const mongoose = require('mongoose');

const provisionBatchSchema = new mongoose.Schema({
    batchId: {
        type: String,
        required: true,
        unique: true,
    },
    // Parent work order this batch belongs to. For manual UI batches this equals
    // batchId (one batch == one IWON). For ERP-created batches an IWON can span
    // multiple models, so each model becomes its own batch (batchId = IWON-SKU)
    // while iwonName ties them together for grouping/lookup + the batch-done callback.
    iwonName: {
        type: String,
        index: true,
    },
    // Where the batch originated: 'ui' = operator via the dashboard,
    // 'erp' = auto-created from an ERP IWON via POST /api/createBatch.
    source: {
        type: String,
        enum: ['ui', 'erp'],
        default: 'ui',
    },
    family: {
        type: String,
        required: true,
        enum: ['SECOS', 'AUGEN', '4GBDP', 'WFBDP'],
    },
    // SKU. Present for ERP batches (model comes from the IWON) and blank for the
    // manual operator flow, which only supplies family + firmware.
    productModel: {
        type: String,
    },
    firmwareVersion: {
        type: String,
        required: true,
    },
    // Operator picks one of the SKU's supported connection types at batch creation;
    // drives which MAC type the allocator pulls from mac_pool.
    connectionType: {
        type: String,
        enum: ['Eth', 'WIFI', '4G'],
        required: true,
    },
    // How many MACs were allocated per device (1 for single-interface SKUs,
    // potentially 2 for 4G+Eth dual-interface in the future).
    macsPerDevice: {
        type: Number,
        default: 1,
        min: 1,
        max: 4,
    },
    // Every connection type a MAC was allocated for, per device. Usually one
    // entry matching connectionType. For dual-interface SKUs (e.g. a model that
    // supports Eth AND WiFi) this holds both — one MAC of each type is assigned
    // per device regardless of which single connectionType the order requested.
    macTypes: {
        type: [{ type: String, enum: ['Eth', 'WIFI', '4G'] }],
        default: undefined,
    },
    firmwarePath: {
        type: String,
    },
    firmwareSha256: {
        type: String,
    },
    count: {
        type: Number,
        required: true,
    },
    startDeviceId: {
        type: String,
        required: true,
        match: [/^ATPL-\d{6}$/, 'Start device ID must match ATPL-NNNNNN'],
    },
    endDeviceId: {
        type: String,
        required: true,
        match: [/^ATPL-\d{6}$/, 'End device ID must match ATPL-NNNNNN'],
    },
    serialStart: {
        type: Number,
        required: true,
    },
    serialEnd: {
        type: Number,
        required: true,
    },
    hsmKeyRef: {
        type: String,
        default: 'arcisai-intermediate-ca-hsm',
    },
    rootCaHash: {
        algorithm: { type: String, default: 'SHA-256-truncated-96' },
        hex: { type: String, required: true },
        words: [{ type: Number }],
    },
    rotpkHex: {
        type: String,
    },
    zipPath: {
        type: String,
    },
    zipSha256: {
        type: String,
    },
    zipSizeBytes: {
        type: Number,
    },
    status: {
        type: String,
        enum: ['allocated', 'generating', 'ready', 'in_progress', 'completed', 'cancelled', 'failed'],
        default: 'allocated',
    },
    error: {
        type: String,
    },
    generatedAt: {
        type: Date,
    },
    firstDownloadedAt: {
        type: Date,
    },
    downloadCount: {
        type: Number,
        default: 0,
    },
    createdBy: {
        type: String,
    },
    // Set once EMS has notified ERP (POST /api/request/batch-done) that the
    // parent IWON's batches are all done. Guards against double-sending the
    // single per-IWON callback when several per-model batches finish together.
    batchDoneSentAt: {
        type: Date,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('ProvisionBatch', provisionBatchSchema);
