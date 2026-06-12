const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const userRoutes = require('./routes/userRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const mqttRoutes = require('./routes/dataRoute');
const cameraRoutes = require('./routes/cameraRoute');
//const healthRoutes = require('./routes/healthRoutes');
// const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');
const otaRutes = require('./routes/otaRoutes');
// Provisioning + v2 station endpoints moved to MPS (Manufacturing Platform
// Server) on 2026-05-02. Reachable at https://mps.devices.arcisai.io and
// also via path-based routing on https://ems.devices.arcisai.io/backend/api/{provision,v2}/*
// (nginx forwards both to MPS:5002). See /home/rahul/arcisai-mps/.
const mqttService = require('./services/mqttService');
//const supportRoutes = require('./routes/supportRoutes');
//const batchRoutes = require('./routes/batchRoutes');
//const stqcUserRoutes = require('./routes/stqcUserRoute');
//const macRoutes = require('./routes/macRoutes');
//const versionRoutes = require('./routes/versionRoutes');
//const genRequestsRoutes = require('./routes/genRequestsRoutes');
//const deptRoutes = require('./routes/deptRoutes');
//const abdRoutes = require("./routes/abdRoutes");
const connectDB = require('./utils/db');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const { createProxyMiddleware } = require('http-proxy-middleware');
//const quotationRoutes = require("./routes/quotationUploadRoutes");
const { BASE_PDFS_DIR } = require('./middleware/uploadFile'); // adjust relative path if needed

// require('./services/mqttHelper');
// const User = require("./models/userModel");
// Load environment variables
dotenv.config({ path: '.env' });

// Connect to MongoDB
connectDB();

const app = express();

require("dotenv").config({ path: ".env" });

// Enable CORS
app.use(cors(
    {
        origin: ["https://ems.devices.arcisai.io/dash"],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Origin, X-Requested-With, Content-Type, Accept, Authorization', 'x-api-key'],
    }
));

// Use Helmet to add security headers
app.use(helmet());

// Customizing Helmet to add specific headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
});

// Use cookie-parser middleware
app.use(cookieParser());

// Middleware
app.use(express.json());
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));

// Serve static HTML for video upload form
app.use(express.static('public'));

app.use('/static/pdfs', express.static(BASE_PDFS_DIR));


// app.use((req, res, next) => {
//     const allowedOrigin = 'https://ems.ambicam.com'; // Replace with your frontend domain
//     const origin = req.get('origin') || req.get('referer');
//     if (origin && !origin.startsWith(allowedOrigin)) {
//         return res.status(403).json({
//             success: false,
//             message: 'Access forbidden: Unauthorized origin'
//         });
//     }
//     next();
// });

// Routes
app.use('/api/users', userRoutes);
app.use('/api', settingsRoutes);
app.use('/api/alert', mqttRoutes);
app.use('/api/camera', cameraRoutes);
//app.use('/api/health', healthRoutes);
// app.use('/api/video', videoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ota', otaRutes);
// app.use('/api/provision', ...) and app.use('/api/v2', ...) — moved to MPS.
//app.use('/api/support', supportRoutes);
//app.use('/api/production', batchRoutes);
//app.use('/api/stqc', stqcUserRoutes);
//app.use('/api/mac', macRoutes);
//app.use('/api/version', versionRoutes);
//app.use('/api/reqs', genRequestsRoutes);
//app.use('/api/department', deptRoutes);
//app.use("/api/quotations", quotationRoutes);
//app.use("/api/abd", abdRoutes);


// Proxy middleware to forward requests to target server
const proxyOptions = {
    target: 'https://VSPL-121832-FCYSE.torqueverse.dev', // The URL of the target server to proxy
    changeOrigin: true,
    onProxyRes: (proxyRes, req, res) => {
        let body = '';
        proxyRes.on('data', (chunk) => {
            body += chunk;
        });
        proxyRes.on('end', () => {
            // Send the received HTML content to the client
            res.send(body);
        });
    }
};
app.use('/api/proxy', createProxyMiddleware(proxyOptions));

// Error Handling Middleware
app.use((err, req, res, next) => {
    const statusCode = res.statusCode || 500;
    res.status(statusCode).json({ message: err.message });
});

// Connect to MQTT broker
mqttService.connectToMQTT();

const THIRTY_MINUTES = 30 * 60 * 1000; // 30 minutes in milliseconds

// setInterval(async () => {
//     try {
//         const now = Date.now();
//         const inactiveUsers = await User.find({
//             isLoggedIn: true,
//             lastActivity: { $lte: new Date(now - THIRTY_MINUTES) }
//         });

//         for (const user of inactiveUsers) {
//             user.lastActivityambicam = false;
//             user.tokens = []; // Remove all tokens
//             await user.save();
//             console.log(`User ${user.username} logged out due to inactivity.`);
//         }
//     } catch (error) {
//         console.error("Error logging out inactive users:", error);
//     }
// }, 5 * 60 * 1000); // Run every 5 minutes

module.exports = app;
