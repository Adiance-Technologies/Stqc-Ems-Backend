const express = require('express');
const router = express.Router();
const { getAllUsers, createUser, updateUser, deleteUser, getCameras, updateCamera, addCameraToUser, bulkAddCamerasToUser, deleteCameraFromUser, getDashboardData, flushRedis, getAbdDevice } = require('../controllers/adminController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/authMiddleware');
const { getAllEmsUsers, updateEmsUser, deleteEmsUser, getSalesUsers } = require('../controllers/userController');

// Define the route to get the latest message
router.get('/getAllUsers', isAuthenticatedUser, getAllUsers);
router.get('/getAllEmsUsers', getAllEmsUsers);
router.get('/getSalesUsers', getSalesUsers);
router.put('/updateEmsUser', isAuthenticatedUser, updateEmsUser);
router.delete('/deleteEmsUser/:id', isAuthenticatedUser, deleteEmsUser);
router.post('/createUser', isAuthenticatedUser, createUser);
router.post('/updateUser/:id', isAuthenticatedUser, updateUser);
router.post('/deleteUser/:id', isAuthenticatedUser, deleteUser);

router.get('/getCameras', isAuthenticatedUser, getCameras);
router.get('/getDashboardData', isAuthenticatedUser, authorizeRoles('view', 'admin'), getDashboardData);
router.post('/addCameraToUser', isAuthenticatedUser, addCameraToUser);
router.post('/deleteCameraFromUser', isAuthenticatedUser, deleteCameraFromUser);
router.post('/bulkAddCamerasToUser', isAuthenticatedUser, bulkAddCamerasToUser);
router.post('/updateUserCamera', isAuthenticatedUser, authorizeRoles('admin'), updateCamera);
router.get('/flushRedis', flushRedis);
//router.get("/getAbdDevice",isAuthenticatedUser,getAbdDevice)
module.exports = router;
