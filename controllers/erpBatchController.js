/*
 * controllers/erpBatchController.js
 *
 * ERP → EMS manufacturing bridge.
 *
 * The ERP (Adiance-Erp-ST) fires POST /api/createBatch when an IWON (work
 * order) is accepted. One IWON can span several camera models; EMS turns each
 * model into its own single-model provisioning batch (batchId = <IWON>-<SKU>),
 * all tagged with the same iwonName. When every batch for the IWON has finished
 * generating, EMS calls ERP back at POST /api/request/batch-done so the IWON
 * unblocks. Auth in BOTH directions is the shared ERP_BRIDGE_TOKEN.
 *
 * Inbound payload (see Adiance-Erp-ST utils/etaemsBatch.js):
 *   { iwonName, totalQuantity, items: [{ modelNumber, connection, enclosure, quantity }] }
 *
 * Serials are auto-allocated (services/serialAllocator.js); MACs are allocated
 * one-per-supported-interface (dual-interface SKUs get Eth + WiFi). Both reuse
 * the exact same path as the manual UI handler via
 * provisioningController.provisionSingleModelBatch.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ProvisionBatch = require('../models/provisionBatch');
const ProductModel = require('../models/productModel');
const macAllocator = require('../services/macAllocator');
const serialAllocator = require('../services/serialAllocator');
const { provisionSingleModelBatch } = require('./provisioningController');

const FIRMWARE_ROOT = process.env.FIRMWARE_ROOT || '/home/rahul/augentix-mqtt/firmware';
const ERP_BASE_URL = process.env.ERP_BASE_URL || 'http://127.0.0.1:5003';
const ERP_BATCH_DONE_PATH = process.env.ERP_BATCH_DONE_PATH || '/api/request/batch-done';
const ERP_NOTIFY_TIMEOUT_MS = 8000;

// Map ERP's free-text connection label → EMS connectionType enum.
// PoE is ethernet, so poe → Eth.
function mapConnection(raw) {
    const k = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['poe', 'eth', 'ethernet', 'lan', 'rj45'].includes(k)) return 'Eth';
    if (['wifi', 'wireless', 'wlan'].includes(k)) return 'WIFI';
    if (['4g', 'lte', 'cellular', 'gsm', 'gprs'].includes(k)) return '4G';
    return null;
}

// ── POST /api/createBatch ─────────────────────────────────────
exports.createErpBatch = catchAsyncErrors(async (req, res) => {
    const { iwonName, items } = req.body || {};

    if (!iwonName || typeof iwonName !== 'string' || !iwonName.trim()) {
        return res.status(400).json({ success: false, message: 'iwonName is required' });
    }
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: 'items[] is required and must be non-empty' });
    }
    const iwon = iwonName.trim();

    // Idempotency / collision guard at the IWON level: if EMS already has
    // batches for this IWON, don't create a second set.
    const existing = await ProvisionBatch.findOne({ iwonName: iwon }).select('batchId').lean();
    if (existing) {
        return res.status(409).json({
            success: false,
            code: 'IWON_EXISTS',
            message: `IWON '${iwon}' already has batches in EMS (e.g. ${existing.batchId})`,
        });
    }

    // Resolve + validate EVERY item before creating anything, so a bad item
    // is reported rather than leaving a half-provisioned IWON.
    const resolved = [];
    const errors = [];
    const usedBatchIds = new Set();

    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const modelNumber = String(it.modelNumber || '').trim();
        const qty = parseInt(it.quantity, 10);
        const requested = mapConnection(it.connection);

        if (!modelNumber) { errors.push(`item ${i}: modelNumber is required`); continue; }
        if (!Number.isFinite(qty) || qty < 1) { errors.push(`item ${i} (${modelNumber}): quantity must be >= 1`); continue; }

        const sku = await ProductModel.findOne({ sku: modelNumber.toUpperCase() }).lean();
        if (!sku) { errors.push(`item ${i}: SKU '${modelNumber}' not found in product_models`); continue; }
        if (!sku.family) { errors.push(`SKU ${sku.sku}: no family set in catalog`); continue; }

        const firmwareVersion = sku.defaultFirmware;
        if (!firmwareVersion) {
            errors.push(`SKU ${sku.sku}: no defaultFirmware configured — set it before ERP can build this model`);
            continue;
        }
        const fwDir = path.join(FIRMWARE_ROOT, firmwareVersion);
        if (!fs.existsSync(fwDir) || !fs.statSync(fwDir).isDirectory()) {
            errors.push(`SKU ${sku.sku}: firmware '${firmwareVersion}' not found under ${FIRMWARE_ROOT}`);
            continue;
        }

        // One MAC per MAC-bearing interface (Eth/WiFi) the model supports. 4G
        // never gets a MAC, so a 4G+Eth model gets only an Eth MAC; an Eth+WiFi
        // model gets both. The requested connection becomes the primary
        // connectionType when the model supports it.
        const macTypes = macAllocator.macBearingTypes(sku.connectionTypes);
        if (!macTypes.length) {
            errors.push(`SKU ${sku.sku}: no Eth/WiFi interface to assign a MAC (connectionTypes: ${(sku.connectionTypes || []).join(', ') || 'none'})`);
            continue;
        }
        const connectionType = (requested && macTypes.includes(requested)) ? requested : macTypes[0];

        // batchId = <IWON>-<SKU>; disambiguate if the same SKU appears twice.
        let batchId = `${iwon}-${sku.sku}`;
        let n = 1;
        while (usedBatchIds.has(batchId)) { n++; batchId = `${iwon}-${sku.sku}-${n}`; }
        usedBatchIds.add(batchId);

        resolved.push({ sku, family: sku.family, firmwareVersion, fwDir, connectionType, macTypes, quantity: qty, batchId });
    }

    if (!resolved.length) {
        return res.status(400).json({ success: false, message: 'No valid items to provision', errors });
    }

    // Create each model's batch. Serial range is auto-allocated per family.
    const created = [];
    const failed = [...errors];
    for (const r of resolved) {
        try {
            const range = await serialAllocator.allocateRange(r.family, r.quantity);
            const { batch } = await provisionSingleModelBatch({
                batchId: r.batchId,
                iwonName: iwon,
                productModel: r.sku.sku,
                family: r.family,
                firmwareVersion: r.firmwareVersion,
                fwDir: r.fwDir,
                connectionType: r.connectionType,
                macTypes: r.macTypes,
                count: r.quantity,
                serialStart: range.serialStart,
                serialEnd: range.serialEnd,
                createdBy: `erp:${iwon}`,
                source: 'erp',
                // Fire the per-IWON batch-done callback once every model is ready.
                onSettled: () => maybeNotifyErpDone(iwon),
            });
            created.push({
                batchId: batch.batchId,
                model: r.sku.sku,
                family: r.family,
                count: r.quantity,
                connectionType: r.connectionType,
                macTypes: r.macTypes,
                startDeviceId: range.startDeviceId,
                endDeviceId: range.endDeviceId,
            });
        } catch (e) {
            failed.push(`${r.sku.sku}: ${e.message}`);
        }
    }

    if (!created.length) {
        // Nothing provisioned — non-2xx so ERP logs it and leaves the IWON
        // awaiting batch (an operator can fix the catalog and retry).
        return res.status(502).json({ success: false, message: 'All items failed to provision', errors: failed });
    }

    return res.status(202).json({
        success: true,
        iwonName: iwon,
        accepted: created,
        failed: failed.length ? failed : undefined,
        message: `Provisioning ${created.length} batch(es) for ${iwon}. ERP will be notified at ${ERP_BATCH_DONE_PATH} when all are ready.`,
    });
});

// Called after each per-model batch settles. Sends the single per-IWON
// batch-done callback once ALL of the IWON's batches have finished generating
// successfully (none still generating, none failed). Atomically claims the
// send via batchDoneSentAt so concurrent settles don't double-fire.
async function maybeNotifyErpDone(iwonName) {
    const batches = await ProvisionBatch.find({ iwonName }).select('status batchDoneSentAt').lean();
    if (!batches.length) return;

    const stillWorking = batches.some(b => ['generating', 'allocated'].includes(b.status));
    if (stillWorking) return;

    const anyFailed = batches.some(b => b.status === 'failed');
    if (anyFailed) {
        // Leave the IWON unconfirmed for operator attention — ERP only accepts "done".
        console.warn(`[erpBatch] IWON ${iwonName} has a failed batch — not sending batch-done`);
        return;
    }

    // Atomic claim: flip batchDoneSentAt on every batch that doesn't have it.
    // Only the worker whose update actually modifies rows proceeds to notify.
    const claim = await ProvisionBatch.updateMany(
        { iwonName, batchDoneSentAt: { $exists: false } },
        { $set: { batchDoneSentAt: new Date() } }
    );
    if (!claim.modifiedCount) return;   // already claimed/sent by another settle

    await notifyErpBatchDone(iwonName);
}

// POST the batch-done callback to ERP. Retries a few times; on final failure
// clears the claim so a later trigger / manual replay can try again.
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
            await axios.post(
                url,
                { iwonName, status: 'done' },
                { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: ERP_NOTIFY_TIMEOUT_MS }
            );
            console.log(`[erpBatch] batch-done sent for ${iwonName}`);
            return true;
        } catch (e) {
            const status = e?.response?.status;
            const msg = e?.response?.data?.message || e?.message || 'unknown error';
            console.error(`[erpBatch] batch-done attempt ${attempt}/3 failed for ${iwonName}: status=${status || 'no-response'} msg=${msg}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    // Give up for now — unclaim so it can be retried.
    await ProvisionBatch.updateMany({ iwonName }, { $unset: { batchDoneSentAt: '' } }).catch(() => {});
    return false;
}

exports.notifyErpBatchDone = notifyErpBatchDone;
exports.mapConnection = mapConnection;
