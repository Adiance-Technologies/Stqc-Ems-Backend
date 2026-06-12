const Firmware = require('../models/firmware');
const p2predirect = require('../models/p2predirect');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const FormData = require('form-data');
const FirmwareOtaRelease = require('../models/firmwareOtaRelease');
const apiUrl = `${process.env.MQTT_CONNECTED_DEVICES}`;

// Root directory where firmware releases are dropped. Each release lives in
// its own tag-named subdirectory and carries a manifest.json describing the
// .rom file, sha256, productType, publishedAt, and release notes.
const FIRMWARE_ROOT = process.env.FIRMWARE_ROOT || '/home/rahul/augentix-mqtt/firmware';
const FIRMWARE_PUBLIC_BASE = process.env.FIRMWARE_PUBLIC_BASE || 'https://ems.devices.arcisai.io/firmware';
const appTopicSend = 'torque/app/tx/';
const appTopicReceive = 'torque/app/rx/';


const httpsAgent = new https.Agent({
    cert: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.crt"),
    key: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.key"),
    ca: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/ca-chain.pem"),
    rejectUnauthorized: true, // IMPORTANT for production
});


// @desc    Get all firmware versions
// @route   GET /api/firmware
// @access  Admin
exports.cameraList = async (req, res, next) => {
    const { page = 1, limit = 10, searchQuery } = req.query;

    try {
        // Fetch devices from the API
        const devicesResponse = await axios.get(apiUrl, { httpsAgent });
        const devices = devicesResponse.data; // Assuming this contains the array of devices

        // Extract device IDs into an array
        const deviceIds = devices.map(device => device.deviceId);

        if (!deviceIds.length) {
            return res.status(400).json({
                success: false,
                message: 'No devices found for OTA',
            });
        }

        // Build the query using device IDs and optional search query
        const query = { deviceId: { $in: deviceIds } };
        if (searchQuery) {
            query.$or = [
                { deviceId: { $regex: searchQuery, $options: 'i' } },
                { firmware: { $regex: searchQuery, $options: 'i' } }
            ];
        }

        // Calculate pagination parameters
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Query the database for matching firmware versions
        const firmwareVersions = await Firmware.find(query)
            .skip(skip)
            .limit(parseInt(limit))
            .select('deviceId productType firmware releaseDate currentFirmware');

        // Add online/offline status to each firmware version
        const filteredFirmwareVersions = firmwareVersions.map(firmwareVersion => {
            const deviceId = firmwareVersion.deviceId;
            const isOnline = deviceIds.includes(deviceId);
            return {
                ...firmwareVersion.toObject(),
                status: isOnline ? 'online' : 'offline' // Add status based on presence in the deviceIds array
            };
        });

        if (!filteredFirmwareVersions.length) {
            return res.status(400).json({
                success: false,
                message: "No matching devices found for OTA update.",
            });
        }

        // Calculate total count and pages
        const totalCount = await Firmware.countDocuments(query);
        const totalPages = Math.ceil(totalCount / limit);

        res.status(200).json({
            success: true,
            message: 'data fetched successfully',
            data: filteredFirmwareVersions,
            totalPages,
            currentPage: parseInt(page),
            totalCount
        });
    } catch (error) {
        next(error);
    }
};
// @desc    relese firmware version
// @route   POST /api/firmware
// @access  Admin

// exports.releseFirmware = async (req, res, next) => {
//     const { productType, firmware, description } = req.body;

//     // get today's date in DD-MM-YYYY format
//     const releseDate = new Date().toLocaleDateString('en-GB');

//     try {
//         const relese = await Firmware.updateMany(
//             { productType: productType },
//             { $set: { firmware, releseDate, description } }
//         );

//         res.status(200).json({
//             success: true,
//             data: relese
//         });
//     }
//     catch (error) {
//         next(error);
//     }
// }

exports.releseFirmware = async (req, res, next) => {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const { productType, firmware, description, isLatest } = req.body;

    try {
        const form = new FormData();
        form.append('folder', productType);
        form.append('version', firmware);
        form.append('file', fs.createReadStream(file.path), file.originalname);

        // Upload to Prong
        const uploadResponse = await axios.post(
            'https://ems.devices.arcisai.io/firmware/upload',
            form,
            { 
httpsAgent,
headers: { ...form.getHeaders() } }
        );

        // DELETE LOCAL FILE IMMEDIATELY AFTER UPLOAD ATTEMPT (Success Case)
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

        if (uploadResponse.status === 200) {
            const remoteData = uploadResponse.data;

            // 1. Toggle latest flags
            if (isLatest === 'true' || isLatest === true) {
                await FirmwareOtaRelease.updateMany(
                    { productType, latestFirmware: true },
                    { $set: { latestFirmware: false } }
                );
            }

            // 2. Create History Record
            await FirmwareOtaRelease.create({
                versionNo: firmware,
                productType,
                description,
                releaseDate: new Date().toLocaleDateString('en-GB'),
                fileName: remoteData.fileName,
                downloadUrl: remoteData.downloadUrl,
                latestFirmware: isLatest === 'true' || isLatest === true
            });

            // 3. Update individual device records
            // await Firmware.updateMany(
            //     { productType },
            //     { $set: { firmware, releseDate: new Date().toLocaleDateString('en-GB'), description } }
            // );
            // 3. UPDATED: Dynamic Bulk Update for Devices
            // If the product contains "Augentix", we update all variants using Regex.
            // Otherwise, we perform an exact match.
            const filter = productType.toLowerCase().includes('augentix')
                ? { productType: { $regex: /Augentix/i } }
                : { productType: productType };

            await Firmware.updateMany(
                filter,
                {
                    $set: {
                        firmware,
                        releseDate: new Date().toLocaleDateString('en-GB'),
                        description
                    }
                }
            );

            return res.status(200).json({ success: true, message: 'Release successful' });
        }
    } catch (err) {
        // DELETE LOCAL FILE IMMEDIATELY (Failure Case)
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);

        console.error("Upload failed", err);
        return res.status(500).json({
            success: false,
            message: 'Internal Server Error during upload',
            error: err.message
        });
    }
};

// @desc    check firmware update
// @route   GET /api/firmware/check
// @access  Admin
exports.getOTA = async (req, res) => {

    const deviceId = req.query.deviceId;
    let responseSent = false; // Flag to prevent multiple responses

    try {
        const options = {
            username: process.env.mqttuser,
            password: process.env.password,
        };

        const client = mqtt.connect(process.env.mqtt_broker_url, options);

        client.on('message', (topic, message) => {
            if (!responseSent) {
                responseSent = true; // Set the flag to true
                const messageString = message.toString();
                console.log(`Message on topic ${topic}:`, messageString);

                try {
                    const parsedMessage = JSON.parse(messageString);
                    console.log(`Parsed JSON message on topic ${topic}:`, parsedMessage);

                    client.end(() => {
                        res.status(200).json(parsedMessage);
                    });
                } catch (err) {
                    console.error('Error parsing JSON:', err);
                    res.status(500).send('Invalid JSON format in the message body.');
                    client.end();
                }
            }
        });

        client.on('connect', () => {
            console.log('Connected to the device');

            client.subscribe(`${appTopicReceive}${deviceId}/35`, (err) => {
                if (err) {
                    console.error('Subscription error:', err);
                } else {
                    console.log(`Subscribed to topics with prefix ${appTopicReceive}`);
                    client.publish(`${appTopicSend}${deviceId}/35`, 'get ota');
                }
            });
        });

        client.on('error', (err) => {
            if (!responseSent) {
                responseSent = true;
                console.error('MQTT Client Error:', err);
                res.status(500).json({ message: 'Error with MQTT client' });
            }
        });
    } catch (error) {
        console.error('Error updating Set UnattendedObjDetect:', error);
        res.status(500).json({
            statusCode: 1,
            statusMessage: 'Error updating Set UnattendedObjDetect',
        });
    }
};

// @desc    set firmware update
// @route   GET /api/firmware/set
// @access  Admin
exports.setOTA = async (req, res) => {

    const deviceId = req.query.deviceId;
    let responseSent = false; // Flag to prevent multiple responses

    try {
        const options = {
            username: process.env.mqttuser,
            password: process.env.password,
        };

        const client = mqtt.connect(process.env.mqtt_broker_url, options);

        client.on('message', (topic, message) => {
            if (!responseSent) {
                responseSent = true; // Set the flag to true
                const messageString = message.toString();
                console.log(`Message on topic ${topic}:`, messageString);

                try {
                    const parsedMessage = { data: messageString };
                    console.log(`Parsed JSON message on topic ${topic}:`, parsedMessage);
                    // Create a buffer from the array
                    const buffer = Buffer.from(parsedMessage.data);

                    // Convert the buffer to a string
                    const resultString = buffer.toString('utf-8');
                    client.end(() => {
                        res.status(200).json(resultString);
                    });
                } catch (err) {
                    console.error('Error parsing JSON:', err);
                    res.status(500).send('Invalid JSON format in the message body.');
                    client.end();
                }

            }
        });

        client.on('connect', () => {
            console.log('Connected to the device');

            client.subscribe(`${appTopicReceive}${deviceId}/36`, (err) => {
                if (err) {
                    console.error('Subscription error:', err);
                } else {
                    console.log(`Subscribed to topics with prefix ${appTopicReceive}`);
                    client.publish(`${appTopicSend}${deviceId}/36`, 'set ota');
                }
            });
        });

        client.on('error', (err) => {
            if (!responseSent) {
                responseSent = true;
                console.error('MQTT Client Error:', err);
                res.status(500).json({ message: 'Error with MQTT client' });
            }
        });
    } catch (error) {
        console.error('Error updating Set UnattendedObjDetect:', error);
        res.status(500).json({
            statusCode: 1,
            statusMessage: 'Error updating Set UnattendedObjDetect',
        });
    }
};

// Function to create or update firmware release
exports.updateOtaLatestRelease = async (req, res) => {
    try {
        const { productType, versionNo, versionName, updates } = req.body;
        const file = req.file;

        if (!versionNo || !versionName || !file || !productType) {
            return res.status(400).json({
                message: 'Version number, name, file, and product type are required.'
            });
        }

        // Prepare release data
        const releaseData = {
            productType,
            versionNo,
            versionName,
            releaseDate: new Date().toISOString(),
            updates: updates || []
        };

        const existingRelease = await releaseFirmwareModel.findOne({ versionNo });

        if (existingRelease) {
            await releaseFirmwareModel.updateOne({ versionNo }, releaseData);
        } else {
            const newRelease = new releaseFirmwareModel(releaseData);
            await newRelease.save();
        }

        // Upload to external server
        const form = new FormData();
        // Add folder BEFORE file to avoid undefined issue in multer destination
        form.append('folder', productType);
        form.append('file', fs.createReadStream(file.path), file.originalname);

        const uploadResponse = await axios.post(
            'http://prong.arcisai.io:6000/upload',
            form,
            { headers: form.getHeaders() }
        );

        if (uploadResponse.status !== 200) {
            return res.status(500).json({
                message: 'File uploaded locally, but remote upload failed.'
            });
        }

        // Remove local file after successful upload
        try {
            fs.unlinkSync(file.path);
        } catch (cleanupErr) {
            console.warn(`⚠ Failed to remove local file ${file.path}:`, cleanupErr.message);
        }

        return res.status(existingRelease ? 200 : 201).json({
            message: `Firmware release ${existingRelease ? 'updated' : 'created'} and uploaded successfully.`,
            remoteUpload: uploadResponse.data
        });
    } catch (error) {
        console.error('Error creating or updating firmware release:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Read manifest.json for a given release tag.
// Returns { tag, file, sha256, productType, publishedAt, releaseNotes } or throws.
function readReleaseManifest(tag) {
    const manifestPath = path.join(FIRMWARE_ROOT, tag, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`manifest.json not found for release ${tag}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.file || !manifest.sha256) {
        throw new Error(`manifest.json for ${tag} is missing file or sha256`);
    }
    return manifest;
}

// List every release by reading every */manifest.json under FIRMWARE_ROOT.
// Ignores directories without a manifest (e.g. legacy manual drops).
function listReleaseManifests() {
    if (!fs.existsSync(FIRMWARE_ROOT)) return [];
    return fs.readdirSync(FIRMWARE_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
            try {
                const m = readReleaseManifest(d.name);
                return { ...m, tag: m.tag || d.name };
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

// Rank manifests newest-first, preferring publishedAt, falling back to tag.
// productType match is lenient: manifest.productType can be a prefix/substring
// of the device's productType or vice-versa, so "Augentix" matches
// "Augentix Camera" / "Augentix-4GBDP" etc.
function pickLatestManifest(manifests, productType) {
    const q = (productType || '').toLowerCase();
    const filtered = q
        ? manifests.filter(m => {
            const p = (m.productType || '').toLowerCase();
            return !p || p === q || p.includes(q) || q.includes(p);
          })
        : manifests.slice();
    filtered.sort((a, b) => {
        const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        if (db !== da) return db - da;
        return String(b.tag).localeCompare(String(a.tag));
    });
    return filtered[0] || null;
}

// ============================================================================
// Secure-OTA rollout state machine — retries once on any error or silence.
// In-memory only; keyed by deviceId. One rollout per device at a time.
// ============================================================================

const crypto = require('crypto');

const MAX_ATTEMPTS = 2;                      // first click + one retry
const WATCHDOG_MS = 5 * 60 * 1000;           // 5 min of silence → retry
const RETRY_BACKOFF_MS = 2000;
const EVICT_AFTER_TERMINAL_MS = 10 * 60 * 1000;

// deviceId -> rollout record
const otaRollouts = new Map();

function newOtaMqttClient() {
    return mqtt.connect(process.env.mqtt_broker_url, {
        username: process.env.mqttuser,
        password: process.env.password,
        cert: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/wildcard.crt'),
        key: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/wildcard.key'),
        ca: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/ca-chain.pem'),
        rejectUnauthorized: false,
    });
}

function closeMqtt(rollout) {
    if (rollout.watchdog) { clearTimeout(rollout.watchdog); rollout.watchdog = null; }
    if (rollout.mqttClient) {
        try { rollout.mqttClient.end(true); } catch {}
        rollout.mqttClient = null;
    }
}

function pushHistory(rollout, entry) {
    rollout.history.push({
        at: new Date().toISOString(),
        attempt: rollout.attempt,
        ...entry,
    });
}

function markTerminal(rollout, finalStatus, reason) {
    rollout.status = finalStatus;
    if (reason) rollout.failureReason = reason;
    rollout.endedAt = new Date().toISOString();
    pushHistory(rollout, { status: finalStatus, reason: reason || null });
    closeMqtt(rollout);
    setTimeout(() => {
        if (otaRollouts.get(rollout.deviceId) === rollout) otaRollouts.delete(rollout.deviceId);
    }, EVICT_AFTER_TERMINAL_MS);
}

function resetWatchdog(rollout) {
    if (rollout.watchdog) clearTimeout(rollout.watchdog);
    rollout.watchdog = setTimeout(() => {
        scheduleRetry(rollout, 'no response within 5 minutes');
    }, WATCHDOG_MS);
}

function scheduleRetry(rollout, reason) {
    closeMqtt(rollout);
    pushHistory(rollout, { status: 'attempt-failed', reason });
    if (rollout.attempt >= MAX_ATTEMPTS) {
        return markTerminal(rollout, 'failed', `${reason} (after ${rollout.attempt} attempt${rollout.attempt > 1 ? 's' : ''})`);
    }
    rollout.status = 'retrying';
    setTimeout(() => startAttempt(rollout), RETRY_BACKOFF_MS);
}

// Map every camera reply into a rollout state transition. Any `error` state
// retries (no detail-based classification). `upgrading` is terminal success.
function handleCameraMessage(rollout, raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

    const state = parsed.state || parsed.status || parsed.level || 'unknown';
    const detail = parsed.detail || parsed.message || parsed.error || '';

    rollout.lastMessage = { state, detail, at: new Date().toISOString() };
    pushHistory(rollout, { status: state, detail });

    if (state === 'upgrading') {
        return markTerminal(rollout, 'upgrading');
    }
    if (state === 'downloaded' || state === 'verified') {
        rollout.status = state;
        resetWatchdog(rollout);
        return;
    }
    if (state === 'error') {
        return scheduleRetry(rollout, detail || 'camera reported error');
    }
    // Unknown payload — keep listening; watchdog will catch silence.
    console.log(`[secureOta] ${rollout.deviceId} unhandled state=${state} detail=${detail}`);
}

function startAttempt(rollout) {
    rollout.attempt += 1;
    rollout.status = 'publishing';
    rollout.attemptStartedAt = new Date().toISOString();
    pushHistory(rollout, { status: 'publishing' });

    const client = newOtaMqttClient();
    rollout.mqttClient = client;

    const rxTopic = `${appTopicReceive}${rollout.deviceId}/62`;
    const txTopic = `${appTopicSend}${rollout.deviceId}/62`;

    client.on('connect', () => {
        client.subscribe(rxTopic, (err) => {
            if (err) return scheduleRetry(rollout, `subscribe error: ${err.message}`);
            client.publish(txTopic, JSON.stringify(rollout.payload), { qos: 1 }, (pubErr) => {
                if (pubErr) return scheduleRetry(rollout, `publish error: ${pubErr.message}`);
                console.log(`[secureOta] ${rollout.deviceId} attempt ${rollout.attempt} published tag=${rollout.tag}`);
                rollout.status = 'waiting';
                pushHistory(rollout, { status: 'waiting' });
                resetWatchdog(rollout);
            });
        });
    });

    client.on('message', (_topic, message) => handleCameraMessage(rollout, message.toString()));

    client.on('error', (err) => {
        console.error(`[secureOta] ${rollout.deviceId} MQTT error:`, err.message);
        scheduleRetry(rollout, `mqtt error: ${err.message}`);
    });
}

// @desc    Trigger secure OTA upgrade on a device via MQTT channel 62.
//          Auto-retries once (total 2 attempts) on any camera-reported error
//          or 5 minutes of silence. Returns 202 immediately with a rolloutId
//          that the UI polls via /secureOta/status for live progress.
// @route   POST /api/ota/secureOta
// @body    { deviceId, tag? }   tag defaults to the latest release for the camera's productType
// @access  mTLS (no JWT — nginx's ssl_verify_client is the gate)
exports.secureOta = async (req, res) => {
    const { deviceId } = req.body;
    let { tag } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required' });
    }

    // Duplicate-click guard: re-attach UI to the existing rollout instead of
    // firing a parallel one.
    const existing = otaRollouts.get(deviceId);
    if (existing && !['upgrading', 'failed'].includes(existing.status)) {
        return res.status(409).json({
            success: true,
            message: 'Rollout already in progress',
            rolloutId: existing.rolloutId,
            deviceId: existing.deviceId,
            tag: existing.tag,
            status: existing.status,
            attempt: existing.attempt,
            maxAttempts: MAX_ATTEMPTS,
            lastMessage: existing.lastMessage,
        });
    }

    try {
        const device = await p2predirect.findOne({ deviceId });
        if (!device) {
            return res.status(404).json({ success: false, message: `Camera ${deviceId} not found` });
        }
        if (!device.otaDeviceToken) {
            return res.status(400).json({
                success: false,
                message: `OTA device token not registered for ${deviceId}. Save it via /api/camera/ota-token.`,
            });
        }

        if (!tag) {
            const latest = pickLatestManifest(listReleaseManifests(), device.productType);
            if (!latest) {
                return res.status(404).json({
                    success: false,
                    message: `No releases available for productType ${device.productType}`,
                });
            }
            tag = latest.tag;
        }

        let manifest;
        try { manifest = readReleaseManifest(tag); }
        catch (err) { return res.status(404).json({ success: false, message: err.message }); }

        const otaUrl = `${FIRMWARE_PUBLIC_BASE}/${tag}/${manifest.file}`;
        const payload = {
            url: otaUrl,
            sha256: manifest.sha256,
            deviceToken: device.otaDeviceToken,
        };

        const rollout = {
            rolloutId: crypto.randomUUID(),
            deviceId,
            tag,
            url: otaUrl,
            sha256: manifest.sha256,
            payload,
            attempt: 0,
            maxAttempts: MAX_ATTEMPTS,
            status: 'pending',
            lastMessage: null,
            failureReason: null,
            history: [],
            startedAt: new Date().toISOString(),
            endedAt: null,
            mqttClient: null,
            watchdog: null,
        };
        otaRollouts.set(deviceId, rollout);
        startAttempt(rollout);

        return res.status(202).json({
            success: true,
            message: 'Secure OTA triggered',
            rolloutId: rollout.rolloutId,
            deviceId,
            tag,
            url: otaUrl,
            sha256: manifest.sha256,
            status: rollout.status,
            attempt: rollout.attempt,
            maxAttempts: MAX_ATTEMPTS,
        });
    } catch (error) {
        console.error('[secureOta] error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// @desc    Poll the latest secure-OTA rollout for a device.
// @route   GET /api/ota/secureOta/status?deviceId=...
// @access  mTLS
exports.getRolloutStatus = (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId is required' });

    const rollout = otaRollouts.get(deviceId);
    if (!rollout) return res.status(404).json({ success: false, message: 'No rollout found for this device' });

    return res.status(200).json({
        success: true,
        rolloutId: rollout.rolloutId,
        deviceId: rollout.deviceId,
        tag: rollout.tag,
        status: rollout.status,
        attempt: rollout.attempt,
        maxAttempts: rollout.maxAttempts,
        lastMessage: rollout.lastMessage,
        failureReason: rollout.failureReason,
        startedAt: rollout.startedAt,
        endedAt: rollout.endedAt,
        history: rollout.history,
    });
};

// @desc    Check whether a newer firmware release is available for a device
// @route   GET /api/ota/checkUpdate?deviceId=...
// @access  Authenticated
exports.checkUpdate = async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required' });
    }

    try {
        const device = await p2predirect.findOne({ deviceId });
        if (!device) {
            return res.status(404).json({ success: false, message: `Camera ${deviceId} not found` });
        }

        const firmwareDoc = await Firmware.findOne({ deviceId });
        const current = firmwareDoc?.currentFirmware || firmwareDoc?.firmware || null;

        const latest = pickLatestManifest(listReleaseManifests(), device.productType);
        if (!latest) {
            return res.status(200).json({
                success: true,
                deviceId,
                productType: device.productType,
                current,
                latest: null,
                updateAvailable: false,
                message: `No releases available for productType ${device.productType}`,
            });
        }

        const updateAvailable = Boolean(current) && current !== latest.tag && current !== latest.file;

        return res.status(200).json({
            success: true,
            deviceId,
            productType: device.productType,
            current,
            latest: {
                tag: latest.tag,
                file: latest.file,
                sha256: latest.sha256,
                publishedAt: latest.publishedAt || null,
                releaseNotes: latest.releaseNotes || null,
            },
            updateAvailable: updateAvailable || !current,
            tokenRegistered: Boolean(device.otaDeviceToken),
        });
    } catch (error) {
        console.error('[checkUpdate] error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// create new device
// @route   POST /api/device
// @access  Admin
