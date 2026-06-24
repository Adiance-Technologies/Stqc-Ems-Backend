/*
 * controllers/stationController.js
 *
 * Endpoints called by manufacturing stations (jig PCs) so they can stay
 * stateless — no station-side MongoDB. Replaces the per-station device
 * pool / reservation logic that used to live in arcisai-platform's
 * `batchLoadService.js` against its own local Mongo.
 *
 * Auth: stationOrUser — either a valid Bearer STATION_API_KEY (production
 * stations) OR an admin cookie (for ops / debugging from the MPS UI).
 *
 * Surface:
 *   POST /api/provision/station/batch/:batchId/reserve
 *   POST /api/provision/station/device/:deviceId/release
 *   POST /api/provision/station/device/:deviceId/start-burn
 *   GET  /api/provision/station/batch/:batchId/devices?station=XYZ
 *   POST /api/provision/station/activity
 *   GET  /api/provision/station/activity?station=XYZ
 */

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ProvisionBatch = require('../models/provisionBatch');
const ProvisionedDevice = require('../models/provisionedDevice');
const ProvisionActivity = require('../models/provisionActivity');

// Helper — pull the station identity from the request. mTLS-presented
// cert OR a `?station=` / `body.station`. Bearer STATION_API_KEY also
// surfaces an `isStation` user via stationOrUser middleware.
function resolveStation(req) {
    return (
        req.body?.station ||
        req.query?.station ||
        req.headers['x-station-id'] ||
        req.user?.stationId ||
        null
    );
}

// ── POST /api/provision/station/batch/:batchId/reserve ────────────────
// Body: { station, count, slots: [1,2,3,4,5,6] }
// Atomically claims `count` devices from the batch's pool. Returns the
// device IDs + everything the station needs to start burning (cert hash,
// MAC, OTP encoded, etc.) — but NOT cert PEMs / OTP bytes (those are in
// the already-extracted batch ZIP on the station's local disk).
//
// Race-safe: each device is claimed via findOneAndUpdate, sorted by
// serialNumber, so two stations hitting reserve simultaneously won't
// both grab the same device.
exports.reserveDevices = catchAsyncErrors(async (req, res) => {
    const { batchId } = req.params;
    const station = resolveStation(req);
    const count = parseInt(req.body?.count, 10) || 6;
    const slots = Array.isArray(req.body?.slots) && req.body.slots.length
        ? req.body.slots
        : Array.from({ length: count }, (_, i) => i + 1);

    if (!station) return res.status(400).json({ success: false, message: 'station required (X-Station-Id header or body.station)' });
    if (count < 1 || count > 64) return res.status(400).json({ success: false, message: 'count must be 1..64' });
    if (slots.length !== count)  return res.status(400).json({ success: false, message: `slots[] length (${slots.length}) must equal count (${count})` });

    const batch = await ProvisionBatch.findOne({ batchId });
    if (!batch) return res.status(404).json({ success: false, message: `Batch ${batchId} not found` });

    const reserved = [];
    for (let i = 0; i < count; i++) {
        const dev = await ProvisionedDevice.findOneAndUpdate(
            {
                batchId,
                status: 'provisioned',                 // not yet claimed by anyone
                'metadata.station': { $in: [null, undefined] },
            },
            {
                $set: {
                    status: 'reserved',
                    'metadata.station':    station,
                    'metadata.jigSlot':    slots[i],
                    'metadata.reservedAt': new Date(),
                },
            },
            { sort: { serialNumber: 1 }, new: true }
        );
        if (!dev) break;
        reserved.push({
            deviceId:       dev.deviceId,
            slot:           dev.metadata?.jigSlot,
            family:         dev.family,
            otpEncoded:     dev.otpEncoded,
            certHash:       dev.certHash,
            mac:            dev.metadata?.macAddress || null,
            connectionType: batch.connectionType || null,
            // Station opens these from its local extracted ZIP at:
            //   <batch_cache>/<batchId>/devices/<deviceId>/{otp.bin, *_cert.pem, *_key.pem}
            //   <batch_cache>/<batchId>/devices/<deviceId>/mac.txt
        });

        // Audit
        await ProvisionActivity.create({
            station, deviceId: dev.deviceId, batchId, slot: slots[i],
            type: 'reserve',
            message: `reserved on slot ${slots[i]}`,
            operator: req.user?.email || null,
        }).catch(() => {});
    }

    res.json({
        ok: true,
        batchId,
        station,
        requested: count,
        reserved,
        short: reserved.length < count,
    });
});

// ── POST /api/provision/station/device/:deviceId/release ───────────────
// Body: { station, reason }
// Returns a previously-reserved device back to the pool. Only allowed if
// device is still in 'reserved' or 'burning' state (not after verify).
exports.releaseDevice = catchAsyncErrors(async (req, res) => {
    const { deviceId } = req.params;
    const station = resolveStation(req);
    const reason  = req.body?.reason || 'released';

    if (!station) return res.status(400).json({ success: false, message: 'station required' });

    const dev = await ProvisionedDevice.findOneAndUpdate(
        { deviceId, status: { $in: ['reserved', 'burning'] }, 'metadata.station': station },
        {
            $set: { status: 'provisioned' },
            $unset: {
                'metadata.station':    '',
                'metadata.jigSlot':    '',
                'metadata.reservedAt': '',
                'metadata.burningAt':  '',
            },
        },
        { new: true }
    );

    if (!dev) return res.status(404).json({ success: false, message: `Device ${deviceId} not reserved by ${station}` });

    await ProvisionActivity.create({
        station, deviceId, batchId: dev.batchId, slot: null,
        type: 'release', message: reason, operator: req.user?.email || null,
    }).catch(() => {});

    res.json({ ok: true, deviceId, status: dev.status });
});

// ── POST /api/provision/station/device/:deviceId/start-burn ────────────
// Body: { station, slot }
// Marks reserved → burning so other stations / dashboards see the burn
// is actually in progress (vs just reserved-but-idle).
exports.startBurn = catchAsyncErrors(async (req, res) => {
    const { deviceId } = req.params;
    const station = resolveStation(req);

    if (!station) return res.status(400).json({ success: false, message: 'station required' });

    const dev = await ProvisionedDevice.findOneAndUpdate(
        { deviceId, status: 'reserved', 'metadata.station': station },
        { $set: { status: 'burning', 'metadata.burningAt': new Date() } },
        { new: true }
    );

    if (!dev) return res.status(409).json({ success: false, message: `Device ${deviceId} not in reserved state for ${station}` });

    await ProvisionActivity.create({
        station, deviceId, batchId: dev.batchId, slot: dev.metadata?.jigSlot,
        type: 'burn-start', message: `starting burn on slot ${dev.metadata?.jigSlot}`,
        operator: req.user?.email || null,
    }).catch(() => {});

    res.json({ ok: true, deviceId, status: dev.status });
});

// ── POST /api/provision/station/device/:deviceId/stage ─────────────────
// Body: { station, stage, ok?, message?, payload? }
// Granular burn-progress sync from the PPC station. Stamps stages.<stage> and
// currentStage on the device so the dashboard shows live progress through the
// pipeline. Coarse lifecycle (reserved→burning→verified) is unchanged — the
// terminal "verified" transition (and MAC burn) stays in reportVerification.
const VALID_STAGES = ['started', 'efuse', 'flash', 'certBurned', 'macBurned', 'completed'];
exports.reportStage = catchAsyncErrors(async (req, res) => {
    const { deviceId } = req.params;
    const station = resolveStation(req);
    const { stage, ok, message, payload } = req.body || {};

    if (!station) return res.status(400).json({ success: false, message: 'station required' });
    if (!stage || !VALID_STAGES.includes(stage)) {
        return res.status(400).json({ success: false, message: `stage must be one of: ${VALID_STAGES.join(', ')}` });
    }

    const now = new Date();
    const set = {
        [`stages.${stage}.done`]: ok !== false,   // default true unless explicitly ok:false
        [`stages.${stage}.at`]: now,
        currentStage: stage,
    };
    // First real stage moves a reserved device into 'burning' so dashboards show
    // it as actively in-progress (mirrors startBurn). Never downgrade a terminal
    // device (verified/failed) — only nudge from reserved.
    if (stage === 'started') {
        const moved = await ProvisionedDevice.findOneAndUpdate(
            { deviceId, status: 'reserved' },
            { $set: { ...set, status: 'burning', 'metadata.burningAt': now } },
            { new: true }
        );
        if (moved) {
            await logStage(station, moved, stage, ok, message, payload);
            return res.json({ ok: true, deviceId, stage, currentStage: moved.currentStage, status: moved.status });
        }
    }

    const dev = await ProvisionedDevice.findOneAndUpdate(
        { deviceId },
        { $set: set },
        { new: true }
    );
    if (!dev) return res.status(404).json({ success: false, message: `Device ${deviceId} not found` });

    await logStage(station, dev, stage, ok, message, payload);
    res.json({ ok: true, deviceId, stage, currentStage: dev.currentStage, status: dev.status });
});

async function logStage(station, dev, stage, ok, message, payload) {
    await ProvisionActivity.create({
        station, deviceId: dev.deviceId, batchId: dev.batchId, slot: dev.metadata?.jigSlot,
        type: `stage:${stage}`,
        message: message || `${stage}${ok === false ? ' FAILED' : ' done'}`,
        payload,
    }).catch(() => {});
}

// ── GET /api/provision/station/batches ─────────────────────────────────
// Loadable batches for the station's "pick a batch" dropdown — so operators
// select instead of typing the batchId. Only batches that have been generated
// (ready / in_progress / completed) are returned; newest first.
exports.listStationBatches = catchAsyncErrors(async (req, res) => {
    const batches = await ProvisionBatch.find({ status: { $in: ['ready', 'in_progress', 'completed'] } })
        .sort('-createdAt')
        .limit(200)
        .lean();

    const results = await Promise.all(batches.map(async (b) => {
        const counts = { provisioned: 0, reserved: 0, burning: 0, verified: 0, failed: 0 };
        const devs = await ProvisionedDevice.find({ batchId: b.batchId }).select('status').lean();
        devs.forEach(d => { if (counts[d.status] !== undefined) counts[d.status]++; });
        return {
            batchId:        b.batchId,
            iwonName:       b.iwonName || null,
            productModel:   b.productModel || null,
            family:         b.family,
            connectionType: b.connectionType || null,
            status:         b.status,
            count:          b.count,
            counts,
            createdAt:      b.createdAt,
        };
    }));

    res.json({ ok: true, batches: results });
});

// ── GET /api/provision/station/batch/:batchId/devices?station=XYZ ──────
// What devices does this batch hold for THIS station — separated by
// status so the jig UI can show counts at a glance.
exports.listStationDevices = catchAsyncErrors(async (req, res) => {
    const { batchId } = req.params;
    const station = resolveStation(req);
    if (!station) return res.status(400).json({ success: false, message: 'station required' });

    const devices = await ProvisionedDevice.find({
        batchId,
        $or: [
            { 'metadata.station': station },                           // mine
            { status: 'provisioned', 'metadata.station': null },       // available pool (no owner)
        ],
    }).sort({ serialNumber: 1 }).lean();

    const buckets = { provisioned: [], reserved: [], burning: [], verified: [], failed: [] };
    for (const d of devices) {
        // Only count "provisioned, no owner" as available; exclude provisioned
        // rows that were just released — those go into provisioned with no
        // station which is still the right bucket.
        const b = buckets[d.status];
        if (b) b.push(d);
    }

    res.json({
        ok: true,
        batchId, station,
        counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
        devices,
    });
});

// ── POST /api/provision/station/activity ───────────────────────────────
// Body: { station, deviceId?, batchId?, slot?, type, message?, payload? }
// Append-only burn event log. Station calls this for every step (relay
// test, OTP write, OTP readback, cert install, verify-sent, etc.).
exports.recordActivity = catchAsyncErrors(async (req, res) => {
    const station = resolveStation(req);
    if (!station) return res.status(400).json({ success: false, message: 'station required' });
    const { deviceId, batchId, slot, type, message, payload } = req.body || {};
    if (!type) return res.status(400).json({ success: false, message: 'type required' });

    const ev = await ProvisionActivity.create({
        station, deviceId, batchId, slot, type, message, payload,
        operator: req.user?.email || null,
        ts: new Date(),
    });

    res.json({ ok: true, id: ev._id, ts: ev.ts });
});

// ── GET /api/provision/station/activity?station=XYZ&deviceId=&type=&since= ──
exports.getStationActivity = catchAsyncErrors(async (req, res) => {
    const station = req.query.station;
    if (!station) return res.status(400).json({ success: false, message: 'station required' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const q = { station };
    if (req.query.deviceId) q.deviceId = req.query.deviceId;
    if (req.query.batchId)  q.batchId  = req.query.batchId;
    if (req.query.type)     q.type     = req.query.type;
    if (req.query.since)    q.ts = { $gte: new Date(req.query.since) };

    const events = await ProvisionActivity.find(q).sort({ ts: -1 }).limit(limit).lean();
    res.json({ ok: true, station, count: events.length, events });
});
