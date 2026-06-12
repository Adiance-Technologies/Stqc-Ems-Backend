
const mongoose = require('mongoose');

const redirects = new mongoose.Schema({
    deviceId: String,
    mqttUrl: String,
    productType: String,
    lastStartTime: String,
    lastCloseTime: String,
    status: String,
    isPTZ: {
        type: Number,
        default: 0
    },
    otaDeviceToken: {
        type: String,
        default: null,
    },
});

module.exports = mongoose.model('p2predirects', redirects);
