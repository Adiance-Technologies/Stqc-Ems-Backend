const express = require('express');
const { isAuthenticatedUser } = require('../middleware/authMiddleware');
const router = express.Router();
const multer = require('multer');
const { addCamera, getP2PCameras, addP2PCamera, checkP2PCameraExists, enableRtsp, getAllPlanNames, getConfig, updateConfig, disableRtsp, addMultipleP2PCameras, addMultipleCameras, getNvr, createNvr, updateNvr, deleteNvr, addFirmware, generateDeviceId, getAllDeviceIds, burnDeviceId, setOtaToken } = require('../controllers/cameraController');

const upload = multer({ dest: 'uploads/' });

router.post('/add-camera', isAuthenticatedUser, addCamera);
router.get('/get-p2p-cameras', isAuthenticatedUser, getP2PCameras);
router.post('/add-p2p-camera', isAuthenticatedUser, addP2PCamera);
router.post('/check-p2p-camera-exists', checkP2PCameraExists);
router.post('/enable-rtsp', enableRtsp);
router.post('/disable-rtsp', disableRtsp);
router.post('/getAllPlanNames', getAllPlanNames);
router.get('/getConfig', isAuthenticatedUser, getConfig);
router.post('/updateConfig', isAuthenticatedUser, updateConfig);
router.post('/addMultipleP2PCameras', isAuthenticatedUser, addMultipleP2PCameras)
router.post('/addMultipleCameras', isAuthenticatedUser, addMultipleCameras)
router.post('/ota-token', isAuthenticatedUser, setOtaToken);
// router.get('/getNvr', isAuthenticatedUser, getNvr)
//router.post('/updateNvr', isAuthenticatedUser, updateNvr)
//router.post('/createNvr', isAuthenticatedUser, createNvr)
//router.post('/deleteNvr', isAuthenticatedUser, deleteNvr)
//router.post('/addFirmware', isAuthenticatedUser, addFirmware)
//router.post('/generateDeviceId', generateDeviceId);
//router.get('/getAllDeviceIds', getAllDeviceIds);
//router.post('/burnDeviceId', burnDeviceId);

module.exports = router;
