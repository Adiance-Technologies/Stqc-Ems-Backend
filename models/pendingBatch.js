const mongoose = require('mongoose');

// pendingBatch — an IWON accepted in ERP and queued in EMS, waiting for an
// operator to choose firmware (per model) and trigger generation. ERP no longer
// auto-generates; it hands the IWON to EMS, EMS shows it here, and the operator
// drives creation. Once created, status flips to 'created' and the per-model
// ProvisionBatch docs take over.
const pendingItemSchema = new mongoose.Schema({
    modelNumber: { type: String },          // raw model number from ERP
    sku: { type: String },                  // resolved SKU (uppercased) or null
    family: { type: String },               // resolved family or null
    connection: { type: String },           // raw connection label from ERP
    connectionType: { type: String },       // mapped Eth/WIFI/4G or null
    macTypes: { type: [String], default: undefined }, // MAC-bearing types (Eth/WiFi)
    quantity: { type: Number },
    suggestedFirmware: { type: String },    // sku.defaultFirmware (operator may override)
    resolveError: { type: String },         // set if the SKU couldn't be resolved
}, { _id: false });

const pendingBatchSchema = new mongoose.Schema({
    iwonName: { type: String, required: true, unique: true, index: true },
    totalQuantity: { type: Number },
    source: { type: String, default: 'erp' },
    status: {
        type: String,
        enum: ['awaiting_firmware', 'created', 'rejected'],
        default: 'awaiting_firmware',
        index: true,
    },
    items: [pendingItemSchema],
    // Filled when the operator creates the batches.
    createdBatchIds: { type: [String], default: undefined },
    createdBy: { type: String },
    createdAt2: { type: Date },              // when batches were actually generated
    rejectedReason: { type: String },
    rejectedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('PendingBatch', pendingBatchSchema, 'pending_batches');
