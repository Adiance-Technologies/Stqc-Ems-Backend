const mongoose = require('mongoose');

/**
 * Tracks the last-used serial number per device family.
 * Ensures sequential, non-overlapping device ID allocation across batches.
 */
const provisionCounterSchema = new mongoose.Schema({
    family: {
        type: String,
        required: true,
        unique: true,
        enum: ['SECOS', 'AUGEN', '4GBDP', 'WFBDP'],
    },
    lastSerial: {
        type: Number,
        required: true,
        default: 900000,
    },
});

module.exports = mongoose.model('ProvisionCounter', provisionCounterSchema);
