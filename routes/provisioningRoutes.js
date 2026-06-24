const express = require('express');
const {
    createBatch,
    getBatchStatus,
    downloadBatch,
    listFirmwares,
    reportVerification,
    listBatches,
    deleteBatch,
} = require('../controllers/provisioningController');
const {
    listProductModels,
    getMacStats,
    importMacs,
    searchDevices,
    getActivityFeed,
} = require('../controllers/provisioningAdminController');
const {
    listPendingBatches,
    createFromPending,
    rejectPending,
} = require('../controllers/erpBatchController');
const {
    reserveDevices,
    releaseDevice,
    startBurn,
    reportStage,
    listStationDevices,
    recordActivity,
    getStationActivity,
} = require('../controllers/stationController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/authMiddleware');
const { stationOrUser } = require('../middleware/stationAuth');

const router = express.Router();

// ── Batch management (admin only — human operators) ───────────
router.post('/batch', isAuthenticatedUser, authorizeRoles('admin'), createBatch);
router.get('/batches', isAuthenticatedUser, authorizeRoles('admin'), listBatches);
// stationOrUser: stations need to read batch metadata + device list to know
// what to burn. Already authorized via Bearer STATION_API_KEY + mTLS — they
// have the ZIP anyway, so reading the same data over JSON is no leak.
router.get('/batch/:batchId', stationOrUser, getBatchStatus);
router.delete('/batch/:batchId', isAuthenticatedUser, authorizeRoles('admin'), deleteBatch);

// ── Station-callable endpoints (accept station API key OR admin cookie) ──
router.get('/batch/:batchId/download', stationOrUser, downloadBatch);
router.post('/verify',                stationOrUser, reportVerification);

// ── Firmware catalog ──────────────────────────────────────────
router.get('/firmwares', isAuthenticatedUser, listFirmwares);

// ── Pending ERP IWONs (queued on accept; operator picks firmware → create) ──
router.get('/pending', isAuthenticatedUser, authorizeRoles('admin'), listPendingBatches);
router.post('/pending/:iwonName/create', isAuthenticatedUser, authorizeRoles('admin'), createFromPending);
router.post('/pending/:iwonName/reject', isAuthenticatedUser, authorizeRoles('admin'), rejectPending);

// ── Admin: SKU catalog + MAC pool management ──────────────────
router.get('/admin/product-models', isAuthenticatedUser, authorizeRoles('admin'), listProductModels);
router.get('/admin/macs/stats',     isAuthenticatedUser, authorizeRoles('admin'), getMacStats);
router.post('/admin/macs/import',   isAuthenticatedUser, authorizeRoles('admin'), importMacs);
router.get('/admin/devices',        isAuthenticatedUser, authorizeRoles('admin'), searchDevices);
router.get('/admin/activity',       isAuthenticatedUser, authorizeRoles('admin'), getActivityFeed);

// ── Station endpoints (replace station-side Mongo) ────────────
// Stations call these via mTLS + Bearer STATION_API_KEY. Admins (cookie
// auth) can also hit them for ops/debug from the MPS UI.
router.post('/station/batch/:batchId/reserve',     stationOrUser, reserveDevices);
router.post('/station/device/:deviceId/release',   stationOrUser, releaseDevice);
router.post('/station/device/:deviceId/start-burn',stationOrUser, startBurn);
router.post('/station/device/:deviceId/stage',     stationOrUser, reportStage);
router.get( '/station/batch/:batchId/devices',     stationOrUser, listStationDevices);
router.post('/station/activity',                   stationOrUser, recordActivity);
router.get( '/station/activity',                   stationOrUser, getStationActivity);

module.exports = router;
