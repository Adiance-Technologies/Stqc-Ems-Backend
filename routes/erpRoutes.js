const express = require('express');
const { createErpBatch } = require('../controllers/erpBatchController');
const { erpBridgeAuth } = require('../middleware/erpBridgeAuth');

const router = express.Router();

// ERP → EMS batch bridge. Token-gated (ERP_BRIDGE_TOKEN), no cookie/JWT.
// Mounted at /api so the public path is POST /api/createBatch (reached over
// localhost from the co-located ERP, bypassing the mTLS nginx vhost).
router.post('/createBatch', erpBridgeAuth, createErpBatch);

module.exports = router;
