const mqtt = require('mqtt');
const fs = require('fs');
let client = null;
let latestMessage = null;
let latestMessagemedia = null;
let latestMessageapp = null;

// Track timeouts and active alerts
const timeouts = {
    'server/info': null,
    'mediaserver/info': null,
    'etaarcis/info': null
};

const alertsSent = {
    'server/info': false,
    'mediaserver/info': false,
    'etaarcis/info': false
};

const storageAlertsSent = {
    'server/info': false,
    'mediaserver/info': false,
    'etaarcis/info': false
};

// Function to reset timeout and track server recovery
// Function to reset timeout and check storage
const resetTimeoutAndCheckStorage = (topic, parsedMessage) => {
    if (timeouts[topic]) {
        clearTimeout(timeouts[topic]);
    }

    if (alertsSent[topic]) {
        // console.log(`INFO: ${topic} is back online. Resetting alert.`);
        alertsSent[topic] = false;
    }

    // Check if storage usage exceeds 80%
    if (parseFloat(parsedMessage.storageUsagePercent) > 80 && !storageAlertsSent[topic]) {
        let serverName = topic === 'server/info' ? 'MQTT Server' :
            topic === 'mediaserver/info' ? 'Media Server' :
                topic === 'etaarcis/info' ? 'ETA ARCIS' : 'Unknown Server';

        // sendAlert(topic, serverName, 'STORAGE', `Storage usage exceeded 80%. Current usage: ${parsedMessage.storageUsagePercent}%`);
    }

    // Set new timeout for 30 seconds
    timeouts[topic] = setTimeout(() => {
        let serverName = topic === 'server/info' ? 'MQTT Server' :
            topic === 'mediaserver/info' ? 'Media Server' :
                topic === 'etaarcis/info' ? 'ETA ARCIS' : 'Unknown Server';

        // sendAlert(topic, serverName, 'DOWN', `${serverName} is Down`);
    }, 300000000);
};



// Function to connect to MQTT broker
function connectToMQTT() {
   // const mqttOptions = {
     //   username: process.env.mqttuser,
     //   password: process.env.password,
   // };
    const mqttOptions = {
    protocol: 'mqtts',
    port: 8883,
    ca: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/ca-chain.pem'),
    cert: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/wildcard.crt'),
    key: fs.readFileSync('/etc/ssl/rahul-arcisai-hsm/wildcard.key'),
    username: process.env.mqttuser,
    password: process.env.password,
    rejectUnauthorized: true,
	};

    client = mqtt.connect(process.env.mqtt_broker_url, mqttOptions);

    client.on('connect', () => {
        // console.log('Connected to MQTT broker');

        const topics = ['server/info', 'mediaserver/info', 'etaarcis/info'];
        client.subscribe(topics, (err) => {
            if (err) {
                console.error('Failed to subscribe to topics:', err);
            } else {
                console.log('Subscribed to topics:', topics);
            }
        });
    });

    // MQTT message listener
    client.on('message', (topic, message) => {
        const messageStr = message.toString();

        try {
            const parsedMessage = JSON.parse(messageStr);

            switch (topic) {
                case 'server/info':
                    latestMessage = parsedMessage;
                    break;
                case 'mediaserver/info':
                    latestMessagemedia = parsedMessage;
                    break;
                case 'etaarcis/info':
                    latestMessageapp = parsedMessage;
                    // console.log(latestMessageapp);
                    break;
            }

            // Reset timeout for the topic
            resetTimeoutAndCheckStorage(topic, parsedMessage);

        } catch (error) {
            console.error(`Failed to parse message from topic ${topic}:`, error);
        }
    });

    client.on('error', (err) => {
        console.error('MQTT connection error:', err);
    });
}

// Function to get the latest messages
function getLatestMessage() {
    // console.log("Fetching Latest Messages...");

    return {
        serverInfo: latestMessage || { error: "No data received yet" },
        mediaServerInfo: latestMessagemedia || { error: "No data received yet" },
        etaarcis: latestMessageapp || { error: "No data received yet" },
    };
}

module.exports = {
    connectToMQTT,
    getLatestMessage
};
