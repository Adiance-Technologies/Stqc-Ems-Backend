const mqtt = require('mqtt');
const axios = require('axios');
const https = require('https');
const Config = require('../models/Config');
const health = require('../models/cameraHealth');
const firmware = require('../models/firmware');
const time = require('../models/time');
const topicReceive = 'torque/tx/';
const topicSend = 'torque/rx/';
const appTopicSend = 'torque/app/rx/';
const appTopicReceive = 'torque/app/tx/';
const commonConfig = require('../utils/commonConfig');
const { spawn, exec } = require('child_process');

// Buffer for audio chunks
const audioBuffers = {};

export const connectedClients = new Set();

// MQTT Setup
const mqttClient = mqtt.connect('https://ems.devices.arcisai.io:8883', {
    username: 'Torque',
    password: 'Raptor@0'
});

// HTTPS Agent for self-signed certs
const httpsAgent = new https.Agent({
    cert: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.crt"),
    key: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.key"),
    ca: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/ca-chain.pem"),
    rejectUnauthorized: true, // IMPORTANT for production
});

// Utilities
function pad(n) {
    return n.toString().padStart(2, '0');
}

function parseGMTOffset(tzString) {
    const match = tzString.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!match) throw new Error(`Invalid timezone format: ${tzString}`);
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || '0', 10);
    return sign * (hours * 60 + minutes) * 60 * 1000;
}

async function getISTTimestamp(deviceId) {
    try {
        const device = await time.findOne({ deviceId });
        const now = new Date();
        const offsetMs = device?.timeZone ? parseGMTOffset(device.timeZone) : 5.5 * 60 * 60 * 1000;
        const adjustedTime = new Date(now.getTime() + offsetMs);
        const formatted = `${adjustedTime.getUTCFullYear()}-${pad(adjustedTime.getUTCMonth() + 1)}-${pad(adjustedTime.getUTCDate())}T${pad(adjustedTime.getUTCHours())}:${pad(adjustedTime.getUTCMinutes())}:${pad(adjustedTime.getUTCSeconds())}${device?.timeZone?.replace('GMT', '') || '+05:30'}`;
        return JSON.stringify(formatted);
    } catch (err) {
        console.error('Error in getISTTimestamp:', err.message);
        return null;
    }
}

const calculateAvg = (dataArray) => {
    if (!dataArray.length) return "0";
    const sum = dataArray.reduce((acc, entry) => acc + parseFloat(entry.value), 0);
    return (sum / dataArray.length).toFixed(2);
};




// Simulated overlay + time publisher for new client messages
mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT broker');
    mqttClient.subscribe(`${topicReceive}#`, (err) => {
        if (err) {
            console.error('❌ Failed to subscribe:', err);
        } else {
            console.log(`📥 Subscribed to topic: ${topicReceive}#`);
        }
    });
    mqttClient.subscribe(`${appTopicReceive}#`, (err) => {
        if (err) {
            console.error('❌ Failed to subscribe:', err);
        } else {
            console.log(`📥 Subscribed to topic: ${appTopicReceive}#`);
        }
    });
    mqttClient.subscribe(['clients/connected', 'clients/disconnected']);
});

mqttClient.on('message', async (topic, messageBuffer, packet) => {

    if (topic === 'clients/connected') {
        connectedClients.add(clientId);
        console.log(`[+] ${clientId} connected`);
    }

    if (topic === 'clients/disconnected') {
        connectedClients.delete(clientId);
        console.log(`[-] ${clientId} disconnected`);
    }
    try {
        const topicSuffix = topic.slice(topicReceive.length);
        const switchValue = topicSuffix.split('/')[1];
        const newTopic = `${topicSend}${topicSuffix}`;
        const clientId = topicSuffix.split('/')[0];
        const payloadStr = messageBuffer.toString();

        if (packet.topic.startsWith(topicReceive)) {
            switch (switchValue) {
                case '0': {

                    const basicAuth = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
                    const apiUrl = `${process.env.P2P_URL}`;

                    const currentDate = new Date();
                    const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });
                    const timeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' });

                    const currentDateString = dateFormatter.format(currentDate);
                    const currentTimeString = timeFormatter.format(currentDate);

                    const [proxyRes] = await Promise.all([
                        axios.get(apiUrl, {
                            httpsAgent, headers: {
                                "X-API-Key": process.env.P2P_API_KEY,
                                "Accept": "application/json"
                            },
                        }),
                    ]);

                    const payload = JSON.parse(payloadStr);
                    const proxyData = proxyRes.data;
                    const proxy = proxyData.proxies.find(p => p.name === clientId);
                    if (!proxy) {
                        return publishMessage(newTopic, `${clientId} not found in the proxies list`);
                    }

                    const proxyStatus = proxy.status;

                    const updateFields = {};
                    const temp = payload.Temperature_C ? parseFloat(payload.Temperature_C).toFixed(2) : null;
                    const sd = payload.SD_Card?.Used_Percentage ? parseFloat(payload.SD_Card.Used_Percentage).toFixed(2) : null;
                    const cpu = payload.CPU ? parseFloat(payload.CPU).toFixed(2) : null;
                    const signal = payload.Signal !== undefined ? parseInt(payload.Signal, 10) : null;
                    // const outBW = payload.OutBandWidth !== undefined ? parseInt(payload.OutBandWidth, 10) : null;
                    // const proxyStatusData = payload.ProxyStatus || null;

                    if (temp) updateFields["Temperature_C"] = { value: temp, date: currentDateString, time: currentTimeString };
                    if (sd) updateFields["SD_Card"] = { value: sd, date: currentDateString, time: currentTimeString };
                    if (cpu) updateFields["CPUUsage"] = { value: cpu, date: currentDateString, time: currentTimeString };
                    if (signal !== null) updateFields["signalStrength"] = { value: signal, date: currentDateString, time: currentTimeString };
                    // if (proxyStatusData !== null) updateFields["p2pStatus"] = { value: proxyStatus, date: currentDateString, time: currentTimeString };

                    if (Object.keys(updateFields).length) {
                        await health.updateOne({ deviceId: clientId }, { $push: updateFields }, { upsert: true });
                    }

                    const camHealthData = await health.findOne({ deviceId: clientId });
                    if (camHealthData && (
                        camHealthData.Temperature_C?.length >= 120 ||
                        camHealthData.SD_Card?.length >= 120 ||
                        camHealthData.CPUUsage?.length >= 120 ||
                        camHealthData.signalStrength?.length >= 120 ||
                        camHealthData.outBandWidth?.length >= 120
                    )) {
                        await health.updateOne(
                            { deviceId: clientId },
                            {
                                $push: {
                                    hourlyTemperature_C: { $each: [{ value: calculateAvg(camHealthData.Temperature_C), date: currentDateString, time: currentTimeString }], $slice: -120 },
                                    hourlySD_Card: { $each: [{ value: calculateAvg(camHealthData.SD_Card), date: currentDateString, time: currentTimeString }], $slice: -120 },
                                    hourlyCPU: { $each: [{ value: calculateAvg(camHealthData.CPUUsage), date: currentDateString, time: currentTimeString }], $slice: -120 },
                                    signalAvg: { $each: [{ value: calculateAvg(camHealthData.signalStrength), date: currentDateString, time: currentTimeString }], $slice: -120 },
                                    outBandWidthAvg: { $each: [{ value: calculateAvg(camHealthData.outBandWidth), date: currentDateString, time: currentTimeString }], $slice: -120 },
                                    // hourlyp2pStatus: { $each: [{ value: proxyStatus, date: currentDateString, time: currentTimeString }], $slice: -120 }
                                },
                                $set: {
                                    Temperature_C: [],
                                    SD_Card: [],
                                    CPUUsage: [],
                                    signalStrength: [],
                                    outBandWidth: [],
                                    p2pStatus: []
                                }
                            },
                            { upsert: true }
                        );
                    }

                    return publishMessage(newTopic, `${clientId} has status: ${proxyStatus}`);
                }

                case '1': {
                    const deviceId = topicSuffix.split('/')[0];
                    const config = await Config.findOne({ topic: deviceId });

                    const defaultConfig = {
                        type: 'http',
                        local_port: 80,
                        local_ip: '127.0.0.1',
                        subdomain: deviceId,
                        host_header_rewrite: 'torqueverse.dev',
                        server_addr: 'p2p.arcisai.io',
                        server_port: 7000,
                        token: '12345678'
                    };

                    const final = { ...defaultConfig, ...config?._doc };

                    const lines = [
                        `[common]`,
                        `server_addr = ${final.server_addr}`,
                        `server_port = ${final.server_port}`,
                        `token = ${final.token}`,
                        ``,
                        `[${final.subdomain}]`,
                        `type = ${final.type}`,
                        `local_port = ${final.local_port}`,
                        `local_ip = ${final.local_ip}`,
                        `subdomain = ${final.subdomain}`,
                        `host_header_rewrite = ${final.host_header_rewrite}`,
                        ``,
                    ];

                    if (final.typeRtsp) {
                        lines.push(`[RTSP-${final.subdomain}]`);
                        lines.push(`type = ${final.typeRtsp}`);
                        lines.push(`local_port = ${final.local_portRtsp}`);
                        lines.push(`local_ip = ${final.local_ipRtsp}`);
                        lines.push(`remote_port = ${final.remotePortRtsp}`);
                        lines.push(`subdomain = ${final.subdomainRtsp}`);
                        lines.push(``);
                    }

                    if (final.typeTelnet) {
                        lines.push(`[telnet-${final.subdomain}]`);
                        lines.push(`type = ${final.typeTelnet}`);
                        lines.push(`local_port = ${final.local_portTelnet}`);
                        lines.push(`local_ip = ${final.local_ipTelnet}`);
                        lines.push(`remote_port = ${final.remote_portTelnet}`);
                        lines.push(`subdomain = ${final.subdomainTelnet}`);
                        lines.push(``);
                    }

                    publishMessage(newTopic, lines.join('\n'));
                    if (!deviceId || !deviceId || deviceId.startsWith("mqttjs")) return;

                    const data = {
                        channelNameOverlay: {
                            enabled: true,
                            regionX: 1,
                            regionY: 95
                        },
                        datetimeOverlay: {
                            enabled: true,
                            regionX: 0,
                            regionY: 5,
                            dateFormat: "YYYY-MM-DD",
                            timeFormat: 24,
                            displayWeek: false,
                            displayChinese: false
                        },
                        textOverlays: ""
                    }

                    // const channelName = {
                    //     channelName: "ARCIS AI"
                    // }

                    const currentDate = await getISTTimestamp(deviceId);
                    publishMessage(`${topicSend}${deviceId}/60`, currentDate)
                    publishMessage(`${topicSend}${deviceId}/19`, JSON.stringify(data))
                    break;
                }
                case '35':
                    console.log('Received message on 35', packet.payload);
                    const deviceIdGetUpdate = topicSuffix.split('/')[0];
                    console.log(deviceIdGetUpdate);
                    const localConfig = JSON.parse(packet.payload)
                    const firmwareInfo = await firmware.findOne({ deviceId: deviceIdGetUpdate });
                    if (!firmwareInfo) {
                        console.log('firmwareInfo not found');
                        const sendTOAppTopicGetTopic = `${appTopicSend}${deviceIdGetUpdate}/${commonConfig.MSG_TYPE_GET_OTA}`;
                        publishMessage(sendTOAppTopicGetTopic, JSON.stringify({ data: 'firmwareInfo not found' }));
                        break;
                    }
                    else if (
                        firmwareInfo.firmware !== localConfig.firmware ||
                        firmwareInfo.vcamAmbicam !== localConfig.vcamAmbicam ||
                        firmwareInfo.p2pAmbicam !== localConfig.p2pAmbicam
                    ) {
                        console.log('update available');

                        const firmwareVersion = firmwareInfo.firmware.split('_').pop();
                        const sendTOAppTopicGetTopic = `${appTopicSend}${deviceIdGetUpdate}/${commonConfig.MSG_TYPE_GET_OTA}`;

                        publishMessage(sendTOAppTopicGetTopic, JSON.stringify({
                            data: 'update available',
                            firmwareVersion,
                            localConfig
                        }));
                        break;
                    } else {
                        const firmwareVersion = firmwareInfo.firmware.split('_').pop();
                        const sendTOAppTopicGetTopic = `${appTopicSend}${deviceIdGetUpdate}/${commonConfig.MSG_TYPE_GET_OTA}`;

                        publishMessage(sendTOAppTopicGetTopic, JSON.stringify({
                            data: 'version up to date',
                            firmwareVersion,
                            localConfig
                        }));
                        break;
                    }
                case '36':
                    console.log('Received message on 36', packet.payload);
                    const deviceIdSetVersion = topicSuffix.split('/')[0];
                    console.log(deviceIdSetVersion);
                    const sendTOAppTopicGetVersion = `${appTopicSend}${deviceIdSetVersion}/${commonConfig.MSG_TYPE_SET_OTA}`;
                    publishMessage(sendTOAppTopicGetVersion, packet.payload);
                    break;
                default:
                    console.log('Unhandled switch case:', switchValue);
                    break;
            }
        }
        else if (packet.topic.startsWith(appTopicReceive)) {
            console.log('Received message on app', packet.payload);
            const topicSuffixApp = packet.topic.slice(appTopicReceive.length);
            const deviceIdApp = topicSuffixApp.split('/')[0];
            const switchValueApp = topicSuffixApp.split('/')[1];
            const newTopicCamera = `${topicSend}${topicSuffixApp}`;

            switch (switchValueApp) {

                case commonConfig.MSG_TYPE_SET_OTA:
                    console.log('Received message on 36 from app', packet.payload);
                    console.log(topicSuffixApp)
                    const deviceId = topicSuffixApp.split('/')[0];
                    const firmwareInfo = await firmware.findOne({ deviceId: deviceIdApp });
                    console.log(firmwareInfo);
                    if (firmwareInfo.productType === 'Augentix') {
                        const updatePath = 'https://ems.devices.arcisai.io/protected/augentix/0.1/Augentix.tar.gz'
                        console.log('Publishing Augentix update path', updatePath);
                        publishMessage(newTopicCamera, updatePath);
                        break;
                    }
                    else if (firmwareInfo.productType === 'VSPL') {
                        const updatePath = 'https://ems.devices.arcisai.io/protected/A-Series/ambicam.tar.gz'
                        publishMessage(newTopicCamera, updatePath);
                        break;
                    }
                    else if (firmwareInfo.productType === 'PTZ_S_Series') {
                        const updatePath = 'https://ems.devices.arcisai.io/protected/S-Series/S_Series.tar.gz'
                        publishMessage(newTopicCamera, updatePath);
                        break;
                    }
                    publishMessage(newTopicCamera, 'OTA is not supported');
                    break;
                case commonConfig.MSG_TYPE_GET_OTA:
                    console.log('Received message on 35 from app', packet.payload);
                    publishMessage(newTopicCamera, 'get OTA');
                    break;
                case commonConfig.MSG_TYPE_AUDIO:
                    console.log('Received message on 56 from app', packet.payload);

                    if (!audioBuffers[deviceIdApp]) {
                        audioBuffers[deviceIdApp] = [];
                    }

                    if (packet.payload.toString() === 'Streamend') {
                        console.log(`Streamend received for deviceId: ${deviceIdApp}`);

                        // Combine buffered chunks into a single buffer
                        const audioBuffer = Buffer.concat(audioBuffers[deviceIdApp]);

                        console.log('Starting real-time conversion and streaming...');

                        // ** FFmpeg process with optimized audio conversion **
                        const ffmpegProcess = spawn('ffmpeg', [
                            '-hide_banner', '-loglevel', 'error', // Reduce console noise
                            '-i', 'pipe:0',
                            '-acodec', 'pcm_alaw', // G.711A codec
                            '-ac', '1', // Mono
                            '-ar', '8000', // 8kHz sample rate
                            '-af', 'volume=2', // 🔥 Boost volume 2x
                            '-f', 'alaw', 'pipe:1' // Output raw audio
                        ]);

                        // Capture FFmpeg errors
                        ffmpegProcess.stderr.on('data', (data) => {
                            console.error('FFmpeg ERROR:', data.toString());
                        });

                        // Write input audio buffer (MP3) to FFmpeg stdin
                        ffmpegProcess.stdin.write(audioBuffer);
                        ffmpegProcess.stdin.end();

                        let outputBuffer = Buffer.alloc(0);

                        ffmpegProcess.stdout.on('data', (data) => {
                            outputBuffer = Buffer.concat([outputBuffer, data]);
                        });

                        ffmpegProcess.on('close', (code) => {
                            if (code !== 0) {
                                console.error(`FFmpeg exited with code ${code}`);
                                return;
                            }

                            console.log('Conversion complete. Streaming G.711A audio...');

                            const chunkSize = 640; // ** Chunk size for G.711A streaming **
                            let offset = 0;
                            const publishQueue = [];

                            while (offset < outputBuffer.length) {
                                publishQueue.push(outputBuffer.slice(offset, offset + chunkSize));
                                offset += chunkSize;
                            }

                            console.log(`Total packets in queue: ${publishQueue.length}`);

                            // ** Send packets with adaptive interval **
                            const sendNextChunk = () => {
                                if (publishQueue.length === 0) {
                                    console.log('Audio stream completed');

                                    // ** Publish "Streamend" message **
                                    publishMessage(newTopicCamera, 'Streamend');
                                    console.log('Published "Streamend" to MQTT');
                                    return;
                                }

                                const chunk = publishQueue.shift();
                                publishMessage(newTopicCamera, chunk);
                                console.log(`Published chunk to MQTT, Remaining: ${publishQueue.length}`);

                                // ** Adjust interval dynamically based on queue size **
                                const dynamicDelay = publishQueue.length > 30 ? 15 : 20;
                                setTimeout(sendNextChunk, dynamicDelay);
                            };

                            sendNextChunk();
                        });

                        ffmpegProcess.on('error', (error) => {
                            console.error('FFmpeg process error:', error);
                        });

                        // Cleanup buffer for future use
                        delete audioBuffers[deviceIdApp];
                    } else {
                        // Buffer incoming chunks
                        audioBuffers[deviceIdApp].push(packet.payload);
                    }
                    break;
            }
        };
    } catch (err) {
        console.error('❌ Error in MQTT message handler:', err);
    }
});

function publishMessage(topic, message, qos = 0, retain = false) {
    mqttClient.publish(topic, message, { qos, retain }, (err) => {
        if (err) {
            console.error(`❌ Failed to publish to ${topic}:`, err);
        } else {
            console.log(`📤 Published to ${topic}: ${message}`);
        }
    });
}

