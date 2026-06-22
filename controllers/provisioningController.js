const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ProvisionBatch = require('../models/provisionBatch');
const ProvisionedDevice = require('../models/provisionedDevice');
const ProductModel = require('../models/productModel');
const batchGenerationService = require('../services/batchGenerationService');
const macAllocator = require('../services/macAllocator');
const serialAllocator = require('../services/serialAllocator');

// ── Constants ─────────────────────────────────────────────────
const FAMILY_CODES = { SECOS: 0, AUGEN: 1, '4GBDP': 2, WFBDP: 3 };

// Truncated 96-bit hash of the ArcisAI Root CA (OTP pin).
// Computed from /etc/ssl/rahul-arcisai-hsm/root-ca.pem.
// Fleet-wide constant until Root CA is rotated.
const ROOT_CA_HASH = {
    algorithm: 'SHA-256-truncated-96',
    hex: '44EAC14753385146971F2BC3',
    words: [0x44EAC147, 0x53385146, 0x971F2BC3],
};

// HSM Intermediate CA reference (read-only in UI)
const HSM_KEY_REF = process.env.HSM_KEY_REF || 'arcisai-intermediate-ca-hsm';

// Root of Trust Public Key hash (shown read-only in UI; source of secure boot)
// 28-byte SHA-224 of pub_key_mod_hash.bin, written separately by the eFuse tool.
const ROTPK_HEX = process.env.ROTPK_HEX || '';

// Firmware repository — scanned for the Firmware dropdown
const FIRMWARE_ROOT = process.env.FIRMWARE_ROOT || '/home/rahul/augentix-mqtt/firmware';

// Where batch_generate.sh writes output
const BATCH_OUTPUT_ROOT = process.env.BATCH_OUTPUT_ROOT || path.join(__dirname, '..', 'batch_output');

// Path to batch_generate.sh
const BATCH_SCRIPT = process.env.BATCH_SCRIPT || path.join(__dirname, '..', 'scripts', 'batch_generate.sh');

// ── Helpers ───────────────────────────────────────────────────

// Batch IDs are NOT auto-generated. The production manager supplies the
// IWON (Internal Work Order Number) when creating a batch and that becomes
// the batch ID verbatim. Uniqueness is DB-enforced (provisionBatch.js has
// `batchId: { unique: true }`); collisions return HTTP 409.
//
// Acceptable IWON format: 3..64 chars, alphanumeric + `-` and `_` only.
// Tighten further once production's actual IWON convention is locked.
const IWON_RE = /^[A-Za-z0-9_-]{3,64}$/;

// Device IDs follow the original ATPL-NNNNNN-FAMILY format (family suffix
// is one of SECOS / AUGEN / 4GBDP / WFBDP) — matches the unmodified
// gen_otp.py / otp_provision.c parsers that have always been there.

function parseDeviceIdRange(startStr, endStr) {
    const rx = /^ATPL-(\d{6})$/;
    const ms = rx.exec(startStr);
    const me = rx.exec(endStr);
    if (!ms || !me) {
        throw new Error('startDeviceId and endDeviceId must match ATPL-NNNNNN (6 digits)');
    }
    const start = parseInt(ms[1], 10);
    const end = parseInt(me[1], 10);
    if (start < 1 || end < 1) throw new Error('Serial must be positive');
    if (end < start) throw new Error('endDeviceId serial must be >= startDeviceId serial');
    if (end > 0xFFFFF) throw new Error('Serial exceeds 20-bit max (1048575)');
    return { start, end };
}

function encodeDeviceIdUint32(serial, familyCode) {
    return ((serial & 0xFFFFF) << 4) | (familyCode & 0xF);
}

// ── POST /api/provision/batch ─────────────────────────────────
// Create a batch: persist rows, spawn batch_generate.sh in background, return immediately.
exports.createBatch = catchAsyncErrors(async (req, res) => {
    // Manual operator flow. The model number now comes from ERP, so the dashboard
    // only asks for IWON + family + firmware + count. Connection type defaults to
    // Eth (single MAC) — dual-interface Eth+WiFi is an ERP-only, model-driven
    // feature — and the device-ID range is auto-allocated per family.
    const {
        iwon,                  // accept either iwon or batchId — same field, different names
        batchId: bodyBatchId,
        family,
        firmwareVersion,
        count,
    } = req.body;

    const iwonRaw = iwon || bodyBatchId;

    if (!iwonRaw || !family || !firmwareVersion || !count) {
        return res.status(400).json({
            success: false,
            message: 'iwon, family, firmwareVersion, count are required',
        });
    }

    const iwonClean = String(iwonRaw).trim();
    if (!IWON_RE.test(iwonClean)) {
        return res.status(400).json({
            success: false,
            message: `Invalid IWON: must be 3-64 chars, alphanumeric (and - or _ allowed)`,
        });
    }

    if (!FAMILY_CODES.hasOwnProperty(family)) {
        return res.status(400).json({
            success: false,
            message: `Invalid family. Must be one of: ${Object.keys(FAMILY_CODES).join(', ')}`,
        });
    }

    const parsedCount = parseInt(count, 10);
    if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 10000) {
        return res.status(400).json({ success: false, message: 'count must be 1–10000' });
    }

    // Uniqueness pre-check (the unique index on batchId is the real guarantee).
    const dup = await ProvisionBatch.findOne({ batchId: iwonClean }).lean();
    if (dup) {
        return res.status(409).json({
            success: false,
            message: `IWON "${iwonClean}" is already in use (batch created at ${dup.createdAt}). IWON numbers must be unique.`,
        });
    }

    // Firmware must exist on disk.
    const fwDir = path.join(FIRMWARE_ROOT, firmwareVersion);
    if (!fs.existsSync(fwDir) || !fs.statSync(fwDir).isDirectory()) {
        return res.status(400).json({
            success: false,
            message: `Firmware '${firmwareVersion}' not found under ${FIRMWARE_ROOT}`,
        });
    }

    // Auto-allocate the device-ID range for this family (no operator range input).
    let range;
    try {
        range = await serialAllocator.allocateRange(family, parsedCount);
    } catch (e) {
        return res.status(e.statusCode || 500).json({ success: false, message: e.message });
    }

    let batch;
    try {
        ({ batch } = await provisionSingleModelBatch({
            batchId: iwonClean,
            iwonName: iwonClean,
            productModel: '',          // no SKU in the manual flow
            family,
            firmwareVersion,
            fwDir,
            connectionType: 'Eth',     // default; dual-MAC is ERP/model-driven only
            macTypes: ['Eth'],
            count: parsedCount,
            serialStart: range.serialStart,
            serialEnd: range.serialEnd,
            createdBy: req.user ? req.user.email : 'system',
            source: 'ui',
        }));
    } catch (e) {
        if (e.code === 'MAC_POOL_EXHAUSTED' || e.code === 'MAC_POOL_RACE') {
            return res.status(e.statusCode || 409).json({ success: false, message: e.message, code: e.code });
        }
        if (e.code === 11000 || (e.name === 'MongoServerError' && /duplicate key/i.test(e.message))) {
            return res.status(409).json({
                success: false,
                message: `IWON "${iwonClean}" is already in use. IWON numbers must be unique.`,
            });
        }
        throw e;
    }

    res.status(202).json({
        batchId: iwonClean,
        status: 'generating',
        message: 'Batch generation started. Poll GET /api/provision/batch/:batchId for status.',
        count: parsedCount,
        family,
        firmwareVersion,
        startDeviceId: range.startDeviceId,
        endDeviceId: range.endDeviceId,
        connectionType: 'Eth',
        hsmKeyRef: HSM_KEY_REF,
        rootCaHash: ROOT_CA_HASH,
        rotpkHex: ROTPK_HEX,
    });
});

// ── Reusable batch core ───────────────────────────────────────
// Given fully-resolved + validated inputs, allocate device rows + MACs, persist
// the batch, and kick off background generation. Shared by the manual UI handler
// (createBatch above) and the ERP bridge (controllers/erpBatchController.js) so
// the two stay in lock-step. Throws on allocation/persist failure — MAC-pool
// errors carry .code/.statusCode; duplicate batchId surfaces as E11000.
//
// `macTypes` is the SKU's full connection-type set: one MAC of each type is
// allocated per device (dual-interface SKUs → Eth + WiFi, kept separate).
// `onSettled(finalStatus)` (optional) runs after background generation finishes
// ('ready' on success, 'failed' otherwise) — the ERP bridge uses it to fire the
// per-IWON batch-done callback once every model's batch is ready.
async function provisionSingleModelBatch({
    batchId,
    iwonName,
    productModel,
    family,
    firmwareVersion,
    fwDir,
    connectionType,
    macTypes,
    count,
    serialStart,
    serialEnd,
    createdBy,
    source,
    onSettled,
}) {
    const familyCode = FAMILY_CODES[family];
    // Allocate one MAC per MAC-bearing interface (Eth/WiFi). Callers pass an
    // already-filtered macTypes; the fallback re-filters so a 4G connectionType
    // can never slip through and claim a MAC.
    const types = (Array.isArray(macTypes) && macTypes.length)
        ? macTypes
        : macAllocator.macBearingTypes([connectionType]);
    if (!types.length) {
        const err = new Error(`No MAC-bearing interface (Eth/WiFi) for ${productModel} — cannot allocate a MAC`);
        err.statusCode = 400;
        throw err;
    }

    // Build the device-ID list first so the allocator can stamp deviceId
    // onto each MAC row in mac_pool. Device ID format = ATPL-NNNNNN-FAMILY.
    const deviceIds = [];
    for (let serial = serialStart; serial <= serialEnd; serial++) {
        deviceIds.push(`ATPL-${String(serial).padStart(6, '0')}-${family}`);
    }

    // ── Atomically allocate MACs (one of each type per device) ───────
    // All-or-nothing — throws (with statusCode) before anything is persisted.
    const macAssignment = await macAllocator.allocateMultiTypeForBatch({
        batchId,
        deviceIds,
        types,
    });   // Map<deviceId, [{type, mac(hex)}, ...]>

    // Per-device rows (status=allocated). Generation flips them to 'provisioned'.
    const devices = deviceIds.map((deviceId, idx) => {
        const serial = serialStart + idx;
        const entries = macAssignment.get(deviceId) || [];
        const macs = entries.map(e => ({ type: e.type, mac: macAllocator.formatMac(e.mac) }));
        return {
            deviceId,
            batchId,
            serialNumber: serial,
            suffix: family,
            productModel,
            family,
            familyCode,
            otpEncoded: '0x' + encodeDeviceIdUint32(serial, familyCode).toString(16).toUpperCase().padStart(8, '0'),
            status: 'allocated',
            macs,
            // Denormalized snapshot of the primary MAC for quick display.
            // mac_pool / macs[] are the source of truth.
            metadata: { macAddress: macs[0] ? macs[0].mac : null },
        };
    });

    // Persist batch + devices. The unique index on batchId is the real
    // guarantee against collisions — caller maps E11000 to HTTP 409.
    let batch;
    try {
        batch = await ProvisionBatch.create({
            batchId,
            iwonName: iwonName || batchId,
            source: source || 'ui',
            family,
            productModel,
            firmwareVersion,
            firmwarePath: fwDir,
            connectionType,
            macTypes: types,
            macsPerDevice: types.length,
            count,
            startDeviceId: `ATPL-${String(serialStart).padStart(6, '0')}`,
            endDeviceId: `ATPL-${String(serialEnd).padStart(6, '0')}`,
            serialStart,
            serialEnd,
            hsmKeyRef: HSM_KEY_REF,
            rootCaHash: ROOT_CA_HASH,
            rotpkHex: ROTPK_HEX,
            status: 'generating',
            createdBy: createdBy || 'system',
        });
    } catch (e) {
        // Release the MACs we just claimed so the pool stays consistent.
        await macAllocator.releaseForBatch(batchId).catch(() => {});
        throw e;
    }

    try {
        await ProvisionedDevice.insertMany(devices);
    } catch (e) {
        await macAllocator.releaseForBatch(batchId).catch(() => {});
        await ProvisionBatch.deleteOne({ batchId }).catch(() => {});
        throw e;
    }

    // ── Background generation (fire-and-forget) ──────────────────────
    // Cert issuance via @google-cloud/security-private-ca, manifest signing via
    // @google-cloud/kms — no PKCS#11 / gcloud CLI. Caller has already returned
    // 202 by the time this resolves; UI polls GET /api/provision/batch/:id.
    fs.mkdirSync(BATCH_OUTPUT_ROOT, { recursive: true });
    const logFile = path.join(BATCH_OUTPUT_ROOT, `${batchId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    const onLog = (line) => logStream.write(line + '\n');

    setImmediate(async () => {
        let finalStatus = 'failed';
        try {
            const result = await batchGenerationService.generateBatch({
                batchId,
                productModel,
                family,
                firmware: firmwareVersion,
                count,
                serialStart,
                serialEnd,
                deviceIds,    // controller-allocated IDs so EMS Mongo + ZIP stay in sync
                macAssignment, // Map<deviceId, [{type, mac}]> — written into devices/<id>/mac.txt
                connectionType,
                onLog,
            });
            await ProvisionBatch.updateOne(
                { batchId },
                {
                    status: 'ready',
                    zipPath: result.zipPath,
                    zipSha256: result.zipSha256,
                    zipSizeBytes: result.zipSizeBytes,
                    generatedAt: new Date(),
                }
            );

            // Persist per-device cert metadata so the station/dashboard sees
            // Cert=Issued instead of Pending.
            if (Array.isArray(result.devices) && result.devices.length) {
                const ops = result.devices.map((dev) => ({
                    updateOne: {
                        filter: { batchId, deviceId: dev.deviceId },
                        update: {
                            $set: {
                                status:           'provisioned',
                                certHash:         dev.certHash,
                                certSerial:       dev.certSerialNumber,
                                certNotBefore:    dev.certNotBefore,
                                certNotAfter:     dev.certNotAfter,
                                certGcpName:      dev.certGcpName,
                            },
                        },
                    },
                }));
                await ProvisionedDevice.bulkWrite(ops, { ordered: false });
            } else {
                await ProvisionedDevice.updateMany({ batchId }, { status: 'provisioned' });
            }
            finalStatus = 'ready';
        } catch (err) {
            onLog(`ERROR: ${err.stack || err.message}`);
            await ProvisionBatch.updateOne(
                { batchId },
                { status: 'failed', error: `batchGenerationService failed: ${err.message}. See ${logFile}` }
            );
            // Generation failed before any burn — release MACs back to the pool.
            const released = await macAllocator.releaseForBatch(batchId).catch(() => 0);
            if (released) onLog(`Released ${released} MACs back to pool after batchGen failure.`);
            finalStatus = 'failed';
        } finally {
            logStream.end();
            if (typeof onSettled === 'function') {
                try { await onSettled(finalStatus); } catch (e) { /* never let the hook crash the worker */ }
            }
        }
    });

    return { batch, deviceIds };
}

// Exposed so the ERP bridge can create per-model batches through the exact same
// path as the manual UI handler.
exports.provisionSingleModelBatch = provisionSingleModelBatch;

// ── GET /api/provision/batch/:batchId ─────────────────────────
exports.getBatchStatus = catchAsyncErrors(async (req, res) => {
    const { batchId } = req.params;
    const batch = await ProvisionBatch.findOne({ batchId });
    if (!batch) {
        return res.status(404).json({ success: false, message: `Batch ${batchId} not found` });
    }

    // Return the full per-device record so the UI has everything
    // for an audit trail (cert serial + hash, NotBefore/NotAfter, fingerprint,
    // GCP CAS resource name, test results, station + jig slot, OTP readback).
    const devices = await ProvisionedDevice.find({ batchId })
        .sort('serialNumber')
        .lean();

    const counts = { allocated: 0, pending: 0, provisioned: 0, verified: 0, failed: 0 };
    devices.forEach(d => { if (counts[d.status] !== undefined) counts[d.status]++; });

    res.json({
        batchId: batch.batchId,
        status: batch.status,
        productModel: batch.productModel,
        family: batch.family,
        firmwareVersion: batch.firmwareVersion,
        firmwarePath: batch.firmwarePath,
        firmwareSha256: batch.firmwareSha256,
        connectionType: batch.connectionType,
        macsPerDevice:  batch.macsPerDevice,
        count: batch.count,
        startDeviceId: batch.startDeviceId,
        endDeviceId: batch.endDeviceId,
        serialStart: batch.serialStart,
        serialEnd: batch.serialEnd,
        hsmKeyRef: batch.hsmKeyRef,
        rootCaHash: batch.rootCaHash,
        rotpkHex: batch.rotpkHex,
        zipPath: batch.zipPath,
        zipSha256: batch.zipSha256,
        zipSizeBytes: batch.zipSizeBytes,
        downloadCount: batch.downloadCount,
        firstDownloadedAt: batch.firstDownloadedAt,
        error: batch.error,
        createdBy: batch.createdBy,
        counts,
        devices,
        createdAt: batch.createdAt,
        generatedAt: batch.generatedAt,
        updatedAt: batch.updatedAt,
    });
});

// ── GET /api/provision/batch/:batchId/download ────────────────
exports.downloadBatch = catchAsyncErrors(async (req, res) => {
    const { batchId } = req.params;
    const batch = await ProvisionBatch.findOne({ batchId });
    if (!batch) {
        return res.status(404).json({ success: false, message: `Batch ${batchId} not found` });
    }
    if (batch.status !== 'ready' && batch.status !== 'in_progress' && batch.status !== 'completed') {
        return res.status(409).json({
            success: false,
            message: `Batch ${batchId} is '${batch.status}'; ZIP is not ready yet`,
        });
    }
    if (!batch.zipPath || !fs.existsSync(batch.zipPath)) {
        return res.status(410).json({ success: false, message: 'ZIP file missing on disk' });
    }

    await ProvisionBatch.updateOne(
        { batchId },
        {
            $inc: { downloadCount: 1 },
            $set: { firstDownloadedAt: batch.firstDownloadedAt || new Date() },
        }
    );

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${batchId}.zip"`);
    if (batch.zipSha256) res.setHeader('X-Batch-Sha256', batch.zipSha256);
    fs.createReadStream(batch.zipPath).pipe(res);
});

// ── GET /api/provision/firmwares ──────────────────────────────
exports.listFirmwares = catchAsyncErrors(async (req, res) => {
    if (!fs.existsSync(FIRMWARE_ROOT)) {
        return res.json({ firmwares: [], firmwareRoot: FIRMWARE_ROOT });
    }
    const entries = fs.readdirSync(FIRMWARE_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
            const dir = path.join(FIRMWARE_ROOT, e.name);
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.rom') || f.endsWith('.bin'));
            return { version: e.name, files };
        })
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

    res.json({ firmwares: entries, firmwareRoot: FIRMWARE_ROOT });
});

// ── POST /api/provision/verify ────────────────────────────────
exports.reportVerification = catchAsyncErrors(async (req, res) => {
    const { deviceId, batchId, status, tests, metadata, certHash } = req.body;

    if (!deviceId || !batchId || !status) {
        return res.status(400).json({
            success: false,
            message: 'deviceId, batchId, and status are required',
        });
    }
    if (!['verified', 'failed'].includes(status)) {
        return res.status(400).json({ success: false, message: 'status must be "verified" or "failed"' });
    }

    const device = await ProvisionedDevice.findOne({ deviceId, batchId });
    if (!device) {
        return res.status(404).json({ success: false, message: `Device ${deviceId} not in batch ${batchId}` });
    }

    device.status = status;
    if (tests) device.tests = tests;
    if (metadata) Object.assign(device.metadata || {}, metadata);
    if (certHash) device.certHash = certHash;
    if (status === 'verified') device.verifiedAt = new Date();
    device.burnedAt = device.burnedAt || new Date();

    // Terminal status — clear reservation tracking so this device is no
    // longer "owned by station X". The metadata.station/jigSlot/etc. for the
    // burn that just happened is already preserved as historical fact in
    // tests/burnedAt; reservation flags only matter while in-flight.
    if (status === 'verified' || status === 'failed') {
        if (device.metadata) {
            device.metadata.station    = undefined;
            device.metadata.jigSlot    = undefined;
            device.metadata.reservedAt = undefined;
            device.metadata.burningAt  = undefined;
        }
    }
    await device.save();

    // Append to provision_activity for STQC audit trail
    try {
        const ProvisionActivity = require('../models/provisionActivity');
        await ProvisionActivity.create({
            station:  metadata?.station || req.headers['x-station-id'] || req.user?.stationId || 'unknown',
            deviceId, batchId,
            slot:     metadata?.jigSlot,
            type:     status === 'verified' ? 'verify-ok' : 'verify-fail',
            message:  status === 'verified' ? 'device verified at station' : 'device failed verification',
            payload:  { tests, certHash },
        });
    } catch (e) { /* audit must not block verify */ }

    // Flip the device's MAC(s) in mac_pool to status='burned' on success.
    // mac_pool.deviceId was stamped at allocation; we look up by that.
    if (status === 'verified') {
        const MacPool = require('../models/macPool');
        await MacPool.updateMany(
            { deviceId, status: 'assigned' },
            { $set: { status: 'burned', burnedAt: new Date() } }
        );
    }

    const siblings = await ProvisionedDevice.find({ batchId });
    const allDone = siblings.every(d => d.status === 'verified' || d.status === 'failed');
    if (allDone) {
        await ProvisionBatch.updateOne({ batchId }, { status: 'completed' });
    } else {
        await ProvisionBatch.updateOne(
            { batchId, status: { $in: ['ready', 'generating'] } },
            { status: 'in_progress' }
        );
    }

    res.json({
        deviceId,
        status,
        registeredAt: device.verifiedAt || device.updatedAt,
    });
});

// ── DELETE /api/provision/batch/:batchId ──────────────────────
exports.deleteBatch = catchAsyncErrors(async (req, res) => {
    const { batchId } = req.params;
    const batch = await ProvisionBatch.findOne({ batchId });
    if (!batch) {
        return res.status(404).json({ success: false, message: `Batch ${batchId} not found` });
    }

    // Best-effort cleanup of artefacts on disk
    try {
        if (batch.zipPath && fs.existsSync(batch.zipPath)) {
            fs.unlinkSync(batch.zipPath);
            const sumFile = batch.zipPath + '.sha256';
            if (fs.existsSync(sumFile)) fs.unlinkSync(sumFile);
        }
        const dir = path.join(BATCH_OUTPUT_ROOT, batchId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        const logFile = path.join(BATCH_OUTPUT_ROOT, `${batchId}.log`);
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    } catch (e) {
        // Disk cleanup failures shouldn't block DB delete
        console.warn(`[deleteBatch ${batchId}] disk cleanup partial: ${e.message}`);
    }

    const devicesDeleted = await ProvisionedDevice.deleteMany({ batchId });
    await ProvisionBatch.deleteOne({ batchId });

    // Release any not-yet-burned MACs back to the pool. Burned MACs stay
    // burned (those were physically written to a shipped device).
    const macsReleased = await macAllocator.releaseForBatch(batchId).catch(() => 0);

    res.json({
        ok: true,
        batchId,
        devicesDeleted: devicesDeleted.deletedCount,
        macsReleased,
    });
});

// ── GET /api/provision/batches ────────────────────────────────
exports.listBatches = catchAsyncErrors(async (req, res) => {
    const batches = await ProvisionBatch.find()
        .sort('-createdAt')
        .limit(100)
        .lean();

    const results = await Promise.all(batches.map(async (batch) => {
        const counts = { allocated: 0, provisioned: 0, verified: 0, failed: 0 };
        const devices = await ProvisionedDevice.find({ batchId: batch.batchId }).select('status');
        devices.forEach(d => { if (counts[d.status] !== undefined) counts[d.status]++; });
        return { ...batch, counts };
    }));

    res.json({ batches: results });
});
