const express = require('express');
const router = express.Router();
const { cameraList, releseFirmware, updateOtaLatestRelease, secureOta, checkUpdate, getRolloutStatus } = require('../controllers/otaController');
const { isAuthenticatedUser } = require('../middleware/authMiddleware');
const { addFirmware } = require('../controllers/cameraController');
const { getOTA, setOTA } = require('../controllers/settingsController');
const multer = require('multer');

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
// Configure Multer for file uploads
const upload = multer({ storage });

// Define the route to get the latest message
router.get('/cameraList', isAuthenticatedUser, cameraList);
// ENSURE THE UPLOAD MIDDLEWARE IS ADDED HERE
router.post('/releaseFirmware', isAuthenticatedUser, upload.single('file'), releseFirmware);
router.post('/addFirmware', isAuthenticatedUser, addFirmware);
router.get('/checkOtaStatus', isAuthenticatedUser, getOTA);
router.get('/setota', isAuthenticatedUser, setOTA);
router.post('/updateOtaLatestRelease', isAuthenticatedUser, upload.single('file'), updateOtaLatestRelease);
// These two are called both from the EMS UI (browser with JWT) AND from
// other backends (VMS proxy with mTLS only). Skip the JWT check — the nginx
// mTLS gate at ems.devices.arcisai.io already restricts access to trusted
// clients presenting the arcisai wildcard client cert.
router.post('/secureOta', secureOta);
router.get('/secureOta/status', getRolloutStatus);
router.get('/checkUpdate', checkUpdate);

module.exports = router;
