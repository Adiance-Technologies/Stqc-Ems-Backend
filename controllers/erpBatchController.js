/*
 * controllers/erpBatchController.js
 *
 * ERP → EMS manufacturing bridge.
 *
 * Flow: when ERP accepts an IWON it POSTs /api/createBatch. EMS does NOT generate
 * immediately — firmware is an EMS-side decision. Instead EMS resolves the models
 * and QUEUES the IWON as a pending request (models/pendingBatch.js). An operator
 * opens it in the EMS dashboard, picks firmware per model, and triggers creation
 * (POST /api/provision/pending/:iwonName/create), which generates one single-model
 * ProvisionBatch per model (serials + MACs + certs + ZIP). When every batch for
 * the IWON is ready, EMS calls ERP back at POST /api/request/batch-done.
 *
 * Inbound payload (Adiance-Erp-ST utils/etaemsBatch.js):
 *   { iwonName, totalQuantity, items: [{ modelNumber, connection, enclosure, quantity }] }
 *
 * Auth in both directions is the shared ERP_BRIDGE_TOKEN.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ProvisionBatch = require('../models/provisionBatch');
const ProductModel = require('../models/productModel');
const PendingBatch = require('../models/pendingBatch');
const macAllocator = require('../services/macAllocator');
const serialAllocator = require('../services/serialAllocator');
const firmwareSource = require('../services/firmwareSource');
const { provisionSingleModelBatch } = require('./provisioningController');

const FIRMWARE_ROOT = process.env.FIRMWARE_ROOT || '/home/rahul/augentix-mqtt/firmware';
const ERP_BASE_URL = process.env.ERP_BASE_URL || 'http://127.0.0.1:5003';
const ERP_BATCH_DONE_PATH = process.env.ERP_BATCH_DONE_PATH || '/api/request/batch-done';
const ERP_NOTIFY_TIMEOUT_MS = 8000;

// Map ERP's free-text connection label → EMS connectionType enum (PoE = Ethernet).
// Manufacturing families that can appear in a device ID (ATPL-NNNNNN-FAMILY).
const VALID_FAMILIES = ['SECOS', 'AUGEN', '4GBDP', 'WFBDP'];

function mapConnection(raw) {
    const k = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['poe', 'eth', 'ethernet', 'lan', 'rj45'].includes(k)) return 'Eth';
    if (['wifi', 'wireless', 'wlan'].includes(k)) return 'WIFI';
    if (['4g', 'lte', 'cellular', 'gsm', 'gprs'].includes(k)) return '4G';
    return null;
}

function fwDirExists(version) {
    if (!version) return false;
    const dir = path.join(FIRMWARE_ROOT, version);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

// ── POST /api/createBatch (ERP) ───────────────────────────────
// Register the IWON as a pending request for the EMS operator. No generation.
exports.createErpBatch = catchAsyncErrors(async (req, res) => {
    const { iwonName, totalQuantity, items } = req.body || {};

    if (!iwonName || typeof iwonName !== 'string' || !iwonName.trim()) {
        return res.status(400).json({ success: false, message: 'iwonName is required' });
    }
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: 'items[] is required and must be non-empty' });
    }
    const iwon = iwonName.trim();

    // Already queued, or already generated? Don't double-register.
    const dupPending = await PendingBatch.findOne({ iwonName: iwon, status: 'awaiting_firmware' }).lean();
    if (dupPending) {
        return res.status(409).json({ success: false, code: 'IWON_PENDING', message: `IWON '${iwon}' is already queued in EMS awaiting firmware.` });
    }
    const dupBatch = await ProvisionBatch.findOne({ iwonName: iwon }).select('batchId').lean();
    if (dupBatch) {
        return res.status(409).json({ success: false, code: 'IWON_EXISTS', message: `IWON '${iwon}' already has batches in EMS (e.g. ${dupBatch.batchId}).` });
    }

    // Resolve each item against the catalog (no allocation). Per-item errors are
    // recorded so the operator sees exactly which models need attention.
    const resolvedItems = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const modelNumber = String(it.modelNumber || '').trim();
        const qty = parseInt(it.quantity, 10);
        const connectionType = mapConnection(it.connection);

        const row = {
            modelNumber,
            connection: it.connection || '',
            enclosure: it.enclosure || '',
            connectionType,
            quantity: Number.isFinite(qty) ? qty : 0,
        };

        if (!modelNumber) { row.resolveError = 'modelNumber missing'; resolvedItems.push(row); continue; }
        if (!Number.isFinite(qty) || qty < 1) { row.resolveError = 'quantity must be >= 1'; resolvedItems.push(row); continue; }

        // MAC interfaces come from ERP's connection choice (poe→Eth, wifi→Eth+WiFi,
        // 4g→4G+Eth). Optional product_models catalog is only a fallback for
        // family / suggested firmware when ERP doesn't send them.
        const sku = await ProductModel.findOne({ sku: modelNumber.toUpperCase() }).lean();
        row.sku = sku?.sku || modelNumber.toUpperCase();
        row.suggestedFirmware = sku?.defaultFirmware || null;   // operator may override

        // Family: ERP-supplied first, catalog fallback. Required (goes into the device ID).
        const family = String(it.family || sku?.family || '').toUpperCase();
        if (!VALID_FAMILIES.includes(family)) {
            row.resolveError = it.family
                ? `Invalid family '${it.family}' — must be one of ${VALID_FAMILIES.join(', ')}`
                : `family missing — ERP must send it (one of ${VALID_FAMILIES.join(', ')}) or add the SKU to product_models`;
            resolvedItems.push(row);
            continue;
        }
        row.family = family;

        // Interfaces from connection; catalog connectionTypes as a fallback.
        const connTypes = macAllocator.connectionToTypes(it.connection) || sku?.connectionTypes;
        const macTypes = macAllocator.macBearingTypes(connTypes || []);
        if (!macTypes.length) {
            row.resolveError = macAllocator.connectionToTypes(it.connection) || sku
                ? 'connection has no Eth/WiFi interface to assign a MAC'
                : `unknown connection '${it.connection}' — expected PoE/Ethernet, WiFi, or 4G`;
            resolvedItems.push(row);
            continue;
        }
        row.macTypes = macTypes;   // e.g. WiFi → ['Eth','WIFI'] (Eth=HwMac, WiFi=WifiMac)
        resolvedItems.push(row);
    }

    const pending = await PendingBatch.create({
        iwonName: iwon,
        totalQuantity: Number(totalQuantity) || resolvedItems.reduce((s, r) => s + (r.quantity || 0), 0),
        source: 'erp',
        status: 'awaiting_firmware',
        items: resolvedItems,
    });

    return res.status(202).json({
        success: true,
        iwonName: iwon,
        queued: true,
        message: `IWON '${iwon}' queued in EMS. An operator will choose firmware and create the batches.`,
        items: resolvedItems.map(r => ({ modelNumber: r.modelNumber, sku: r.sku, family: r.family, connection: r.connection, enclosure: r.enclosure, connectionType: r.connectionType, quantity: r.quantity, macTypes: r.macTypes, suggestedFirmware: r.suggestedFirmware, resolveError: r.resolveError })),
        pendingId: String(pending._id),
    });
});

// ── GET /api/provision/pending (admin) ────────────────────────
exports.listPendingBatches = catchAsyncErrors(async (req, res) => {
    const pending = await PendingBatch.find({ status: 'awaiting_firmware' }).sort('-createdAt').lean();
    res.json({ pending });
});

// ── POST /api/provision/pending/:iwonName/create (admin) ──────
// Body: { firmwares: { "<modelNumber>": "<firmwareVersion>", ... } }
// Generates one batch per resolvable model using the operator-chosen firmware.
exports.createFromPending = catchAsyncErrors(async (req, res) => {
    const iwon = String(req.params.iwonName || '').trim();
    const firmwares = (req.body && req.body.firmwares) || {};

    const pending = await PendingBatch.findOne({ iwonName: iwon });
    if (!pending) return res.status(404).json({ success: false, message: `No pending IWON '${iwon}'` });
    if (pending.status !== 'awaiting_firmware') {
        return res.status(409).json({ success: false, message: `IWON '${iwon}' is '${pending.status}', not awaiting firmware` });
    }

    const created = [];
    const failed = [];
    const usedBatchIds = new Set();

    for (const item of pending.items) {
        const label = item.modelNumber || '(unknown)';
        if (item.resolveError) { failed.push(`${label}: ${item.resolveError}`); continue; }

        const firmwareVersion = (firmwares[item.modelNumber] || item.suggestedFirmware || '').trim();
        if (!firmwareVersion) { failed.push(`${label}: no firmware selected`); continue; }
        try { await firmwareSource.resolveRelease(firmwareVersion); }
        catch (e) { failed.push(`${label}: ${e.message}`); continue; }

        let batchId = `${iwon}-${item.sku}`;
        let n = 1;
        while (usedBatchIds.has(batchId)) { n++; batchId = `${iwon}-${item.sku}-${n}`; }
        usedBatchIds.add(batchId);

        try {
            const range = await serialAllocator.allocateRange(item.family, item.quantity);
            const { batch } = await provisionSingleModelBatch({
                batchId,
                iwonName: iwon,
                productModel: item.sku,
                family: item.family,
                firmwareVersion,
                fwDir: `github:${process.env.FIRMWARE_GH_REPO || 'Adiance-STQC/arcisai-app'}@${firmwareVersion}`,
                connectionType: item.connectionType && item.macTypes.includes(item.connectionType) ? item.connectionType : item.macTypes[0],
                macTypes: item.macTypes,
                count: item.quantity,
                serialStart: range.serialStart,
                serialEnd: range.serialEnd,
                createdBy: req.user ? req.user.email : 'operator',
                source: 'erp',
                onSettled: () => maybeNotifyErpDone(iwon),
            });
            created.push({ batchId: batch.batchId, model: item.sku, family: item.family, count: item.quantity, firmwareVersion, macTypes: item.macTypes });
        } catch (e) {
            failed.push(`${item.sku}: ${e.message}`);
        }
    }

    if (!created.length) {
        return res.status(400).json({ success: false, message: 'No batches were created', failed });
    }

    pending.status = 'created';
    pending.createdBatchIds = created.map(c => c.batchId);
    pending.createdBy = req.user ? req.user.email : 'operator';
    pending.createdAt2 = new Date();
    await pending.save();

    return res.status(202).json({
        success: true,
        iwonName: iwon,
        accepted: created,
        failed: failed.length ? failed : undefined,
        message: `Generating ${created.length} batch(es) for ${iwon}. ERP will be notified when all are ready.`,
    });
});

// ── POST /api/provision/pending/:iwonName/reject (admin) ──────
exports.rejectPending = catchAsyncErrors(async (req, res) => {
    const iwon = String(req.params.iwonName || '').trim();
    const reason = (req.body && req.body.reason) || '';
    const pending = await PendingBatch.findOne({ iwonName: iwon });
    if (!pending) return res.status(404).json({ success: false, message: `No pending IWON '${iwon}'` });
    if (pending.status !== 'awaiting_firmware') {
        return res.status(409).json({ success: false, message: `IWON '${iwon}' is '${pending.status}', cannot reject` });
    }
    pending.status = 'rejected';
    pending.rejectedReason = reason;
    pending.rejectedAt = new Date();
    await pending.save();
    // Note: ERP is not notified (its batch-done only accepts "done"); the IWON
    // stays "awaiting batch" in ERP for the operator to handle out-of-band.
    res.json({ success: true, iwonName: iwon, status: 'rejected' });
});

// Fire the single per-IWON batch-done once all of the IWON's batches are ready.
async function maybeNotifyErpDone(iwonName) {
    const batches = await ProvisionBatch.find({ iwonName }).select('status batchDoneSentAt').lean();
    if (!batches.length) return;
    if (batches.some(b => ['generating', 'allocated'].includes(b.status))) return;
    if (batches.some(b => b.status === 'failed')) {
        console.warn(`[erpBatch] IWON ${iwonName} has a failed batch — not sending batch-done`);
        return;
    }
    const claim = await ProvisionBatch.updateMany(
        { iwonName, batchDoneSentAt: { $exists: false } },
        { $set: { batchDoneSentAt: new Date() } }
    );
    if (!claim.modifiedCount) return;
    await notifyErpBatchDone(iwonName);
}

async function notifyErpBatchDone(iwonName) {
    const token = process.env.ERP_BRIDGE_TOKEN;
    if (!token) {
        console.warn('[erpBatch] ERP_BRIDGE_TOKEN not set — cannot send batch-done');
        await ProvisionBatch.updateMany({ iwonName }, { $unset: { batchDoneSentAt: '' } }).catch(() => {});
        return false;
    }
    const url = `${ERP_BASE_URL}${ERP_BATCH_DONE_PATH}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await axios.post(url, { iwonName, status: 'done' },
                { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: ERP_NOTIFY_TIMEOUT_MS });
            console.log(`[erpBatch] batch-done sent for ${iwonName}`);
            return true;
        } catch (e) {
            const status = e?.response?.status;
            const msg = e?.response?.data?.message || e?.message || 'unknown error';
            console.error(`[erpBatch] batch-done attempt ${attempt}/3 failed for ${iwonName}: status=${status || 'no-response'} msg=${msg}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    await ProvisionBatch.updateMany({ iwonName }, { $unset: { batchDoneSentAt: '' } }).catch(() => {});
    return false;
}

exports.notifyErpBatchDone = notifyErpBatchDone;
exports.mapConnection = mapConnection;
