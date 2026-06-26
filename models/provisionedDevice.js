const mongoose = require('mongoose');

const provisionedDeviceSchema = new mongoose.Schema({
    deviceId: {
        type: String,
        required: true,
        unique: true,
        match: [/^ATPL-\d{6}-(SECOS|AUGEN|4GBDP|WFBDP)$/, 'Device ID must match ATPL-NNNNNN-FAMILY'],
    },
    batchId: {
        type: String,
        required: true,
        index: true,
    },
    serialNumber: {
        type: Number,
        required: true,
    },
    suffix: {
        type: String,
        required: true,
        match: [/^(SECOS|AUGEN|4GBDP|WFBDP)$/, 'Suffix must be one of SECOS / AUGEN / 4GBDP / WFBDP'],
    },
    // SKU — present for ERP batches, blank for the manual (family+firmware) flow.
    productModel: {
        type: String,
    },
    family: {
        type: String,
        required: true,
        enum: ['SECOS', 'AUGEN', '4GBDP', 'WFBDP'],
    },
    familyCode: {
        type: Number,
        required: true,
    },
    otpEncoded: {
        type: String,
    },
    certSerial: {
        type: String,
    },
    certHash: {
        type: String,
    },
    certNotBefore: {
        type: Date,
    },
    certNotAfter: {
        type: Date,
    },
    // GCP CAS resource name (full path) — used for revocation lookups
    certGcpName: {
        type: String,
    },
    // Lifecycle:
    //   allocated   — row created but cert/OTP not yet generated
    //   provisioned — cert issued, OTP computed, ready for any station to claim
    //   reserved    — a station has claimed this device for an upcoming burn
    //   burning     — station is actively burning right now
    //   verified    — burn completed successfully + station reported back
    //   failed      — burn failed (or station reported failure)
    //   pending     — legacy / placeholder
    status: {
        type: String,
        enum: ['pending', 'allocated', 'provisioned', 'reserved', 'burning', 'verified', 'failed'],
        default: 'allocated',
    },
    tests: {
        otpWrite: { type: String, enum: ['pass', 'fail', ''], default: '' },
        otpReadback: { type: String, enum: ['pass', 'fail', ''], default: '' },
        certLoad: { type: String, enum: ['pass', 'fail', ''], default: '' },
        tlsHandshake: { type: String, enum: ['pass', 'fail', ''], default: '' },
        mtlsAuth: { type: String, enum: ['pass', 'fail', ''], default: '' },
        // Cert actually burned INTO the camera post-flash (provision_device.sh
        // exit code), reported by PPC. Distinct from certHash, which only means
        // the cert was generated at batch time. Drives the "Installed" tick.
        certInstall: { type: String, enum: ['pass', 'fail', ''], default: '' },
    },
    // All MACs assigned to this device, kept separate per interface. Single-
    // interface devices have one entry; dual-interface devices (e.g. Eth+WiFi)
    // have one entry per type. mac_pool is the source of truth — this is a
    // denormalized snapshot for display + the ZIP's mac.txt.
    macs: [{
        _id: false,
        type: { type: String, enum: ['Eth', 'WIFI', '4G'] },
        mac: { type: String },   // colon-formatted, e.g. 80:77:86:50:00:01
    }],
    metadata: {
        macAddress: { type: String },
        firmwareVersion: { type: String },
        seChipPresent: { type: Boolean },
        vendorOtpId: { type: String },
        // Reservation tracking — only populated during reserved/burning lifecycle.
        // Cleared on terminal status (verified/failed) so devices don't appear
        // "owned by a station" after the burn finishes.
        station: { type: String },
        jigSlot: { type: Number },
        reservedAt: { type: Date },
        burningAt: { type: Date },
        otpReadback: { type: String },
    },
    burnedAt: {
        type: Date,
    },
    verifiedAt: {
        type: Date,
    },
    // Granular per-device progress reported by the PPC station as it burns.
    // Coarse `status` (above) stays the source of truth for lifecycle; these
    // sub-stages give live visibility into the burn pipeline. certBurned/macBurned
    // are schema-ready for when PPC implements those steps.
    stages: {
        started:    { done: { type: Boolean, default: false }, at: { type: Date } }, // batch pulled / provisioning started in PPC
        efuse:      { done: { type: Boolean, default: false }, at: { type: Date } },
        flash:      { done: { type: Boolean, default: false }, at: { type: Date } },
        certBurned: { done: { type: Boolean, default: false }, at: { type: Date } },
        macBurned:  { done: { type: Boolean, default: false }, at: { type: Date } },
        completed:  { done: { type: Boolean, default: false }, at: { type: Date } },
    },
    // Last stage reported, for quick display (e.g. "efuse", "flash", "completed").
    currentStage: {
        type: String,
    },
}, {
    timestamps: true,
});

provisionedDeviceSchema.index({ batchId: 1, serialNumber: 1 });
// Used by station "list my reservations" + reserve atomicity (skip rows already
// claimed by another station within the same batch).
provisionedDeviceSchema.index({ batchId: 1, status: 1, 'metadata.station': 1 });

module.exports = mongoose.model('ProvisionedDevice', provisionedDeviceSchema);
