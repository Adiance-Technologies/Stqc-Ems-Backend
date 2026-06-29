// External QC Report API — ingest + dashboard reads.
// The external QC App pushes assembled-camera QC results over mTLS; EMS stores
// + tracks each as a QC report (upsert per device, secrets redacted).
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const QcReport = require('../models/qcReport');

// Secrets the QC App includes in `settings` that must NOT be persisted.
const REDACT_KEYS = ['api_token', 'ems_api_key', 'encrypted_pass', 'encrypted_user', 'camera_pass'];

function redactSecrets(payload) {
    let clone;
    try { clone = JSON.parse(JSON.stringify(payload || {})); } catch { clone = {}; }
    if (clone.settings && typeof clone.settings === 'object') {
        for (const k of REDACT_KEYS) delete clone.settings[k];
    }
    return clone;
}

function parseDate(...candidates) {
    for (const c of candidates) {
        if (!c) continue;
        const d = new Date(c);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

// ── POST /api/qc/report (mTLS) ────────────────────────────────
// QC App pushes a full per-device QC result. Upsert by device_fingerprint.
exports.ingestReport = catchAsyncErrors(async (req, res) => {
    const body = req.body || {};
    const info = body.device_info || {};

    let fingerprint = body.device_fingerprint;
    if (!fingerprint) {
        // Fall back to a stable composite if the app didn't send one.
        if (info.uuid && (info.serial_number || info.ext_sn2)) {
            fingerprint = `FULL_${info.uuid}__${info.serial_number || info.ext_sn2}`;
        } else {
            return res.status(400).json({ success: false, message: 'device_fingerprint (or device_info.uuid + serial_number) is required' });
        }
    }

    const testedAt = parseDate(body.timestamp, body.last_updated, body.csv_timestamp);

    const fields = {
        serialNumber:       info.serial_number || info.ext_sn2 || null,
        uuid:               info.uuid || null,
        macAddress:         info.mac_address || null,
        wirelessMacAddress: info.wireless_mac_address || null,
        overallStatus:      body.overall_status || null,
        engineerName:       body.engineer_name || null,
        testType:           body.test_type || null,
        sessionId:          body.session_id || body._session || null,
        model:              info.model || info.device_name || null,
        selectedModel:      info.selected_camera_model || null,
        defModel:           info.def_model || null,
        firmwareVersion:    info.firmware_version || null,
        firmwareMatch:      typeof info.firmware_match === 'boolean' ? info.firmware_match : undefined,
        modelMatch:         typeof info.model_match === 'boolean' ? info.model_match : undefined,
        ipAddress:          info.ip_address || null,
        manufacturer:       info.manufacturer || null,
        odmNumber:          info.odm_number || null,
        checklistStatus:    body.checklist_status,
        testResults:        body.test_results,
        liveCheck:          body.live_check,
        settingsApply:      body.settings_apply,
        emsProvision:       body.ems_provision,
        deviceInfo:         info,
        raw:                redactSecrets(body),
        csvTimestamp:       body.csv_timestamp || null,
        testedAt:           testedAt || new Date(),
    };

    const doc = await QcReport.findOneAndUpdate(
        { deviceFingerprint: fingerprint },
        {
            $set: fields,
            $setOnInsert: { firstTestedAt: testedAt || new Date() },
            $inc: { attempts: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
        success: true,
        api: 'external-qc-report',
        deviceFingerprint: fingerprint,
        serialNumber: doc.serialNumber,
        overallStatus: doc.overallStatus,
        attempts: doc.attempts,
        op: doc.attempts > 1 ? 'updated' : 'created',
    });
});

// ── GET /api/qc/reports (admin) ───────────────────────────────
exports.listReports = catchAsyncErrors(async (req, res) => {
    const { status, q, limit } = req.query;
    const filter = {};
    if (status) filter.overallStatus = status.toUpperCase();
    if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ serialNumber: rx }, { model: rx }, { engineerName: rx }, { macAddress: rx }, { selectedModel: rx }];
    }
    const reports = await QcReport.find(filter)
        .sort('-testedAt')
        .limit(Math.min(parseInt(limit, 10) || 200, 1000))
        .select('-raw -deviceInfo -liveCheck -settingsApply -emsProvision')
        .lean();

    const counts = { total: 0, pass: 0, fail: 0 };
    const agg = await QcReport.aggregate([{ $group: { _id: '$overallStatus', n: { $sum: 1 } } }]);
    agg.forEach(g => {
        counts.total += g.n;
        if (g._id === 'PASS') counts.pass = g.n;
        else if (g._id === 'FAIL') counts.fail = g.n;
    });

    res.json({ reports, counts });
});

// ── GET /api/qc/reports/:id (admin) — by _id, fingerprint, or serial ──
exports.getReport = catchAsyncErrors(async (req, res) => {
    const { id } = req.params;
    let doc = null;
    if (/^[0-9a-fA-F]{24}$/.test(id)) doc = await QcReport.findById(id).lean();
    if (!doc) doc = await QcReport.findOne({ deviceFingerprint: id }).lean();
    if (!doc) doc = await QcReport.findOne({ serialNumber: id }).sort('-testedAt').lean();
    if (!doc) return res.status(404).json({ success: false, message: `QC report '${id}' not found` });
    res.json(doc);
});
