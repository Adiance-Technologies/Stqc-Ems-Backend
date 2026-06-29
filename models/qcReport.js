const mongoose = require('mongoose');

// qcReport — final QC result for a fully-assembled camera, pushed by the QC App
// after the burn/flash/cert pipeline. One record per device (upsert by
// deviceFingerprint); re-tests overwrite, keeping firstTestedAt + attempts.
// The full payload is kept in `raw` (secrets redacted); key fields are hoisted
// for listing/filtering and to join to provisioned devices via serialNumber.
const qcReportSchema = new mongoose.Schema({
    deviceFingerprint: { type: String, required: true, unique: true, index: true },

    // Identity / join keys
    serialNumber:   { type: String, index: true },   // ATPL-NNNNNN-FAMILY (= provisionedDevice.deviceId)
    uuid:           { type: String },
    macAddress:     { type: String, index: true },
    wirelessMacAddress: { type: String },

    // Result summary
    overallStatus:  { type: String, index: true },    // PASS | FAIL
    engineerName:   { type: String, index: true },
    testType:       { type: String },                 // Manual | Auto | Semi Auto
    sessionId:      { type: String },

    // Device snapshot
    model:          { type: String, index: true },
    selectedModel:  { type: String },
    defModel:       { type: String },
    firmwareVersion:{ type: String },
    firmwareMatch:  { type: Boolean },
    modelMatch:     { type: Boolean },
    ipAddress:      { type: String },
    manufacturer:   { type: String },
    odmNumber:      { type: String },

    // Structured detail (free-form)
    checklistStatus:{ type: mongoose.Schema.Types.Mixed },
    testResults:    { type: mongoose.Schema.Types.Mixed },
    liveCheck:      { type: mongoose.Schema.Types.Mixed },
    settingsApply:  { type: mongoose.Schema.Types.Mixed },
    emsProvision:   { type: mongoose.Schema.Types.Mixed },
    deviceInfo:     { type: mongoose.Schema.Types.Mixed },

    // Full payload (secrets redacted) for audit / future fields
    raw:            { type: mongoose.Schema.Types.Mixed },

    // Timing / provenance
    testedAt:       { type: Date, index: true },
    csvTimestamp:   { type: String },
    firstTestedAt:  { type: Date },
    attempts:       { type: Number, default: 1 },
}, { timestamps: true });

qcReportSchema.index({ overallStatus: 1, testedAt: -1 });

module.exports = mongoose.model('QcReport', qcReportSchema, 'qc_reports');
