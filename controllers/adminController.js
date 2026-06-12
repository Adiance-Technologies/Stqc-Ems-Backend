const axios = require("axios");
const https = require("https");
const Config = require("../models/Config");
const p2predirect = require("../models/p2predirect");
const fs = require('fs');
const httpsAgent = new https.Agent({
  cert: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.crt"),
  key: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/wildcard.key"),
  ca: fs.readFileSync("/etc/ssl/rahul-arcisai-hsm/ca-chain.pem"),
  rejectUnauthorized: true, // IMPORTANT for production
});

// create instance of axios with custom config
const instance = axios.create({
  baseURL: "https://vms.devices.arcisai.io/backend/api/admin",
  httpsAgent,
});

// get all users
exports.getAllUsers = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || ""; // Search parameter for deviceId
  try {
    const response = await instance.get("/getAllUsers", {
      params: {
        page,
        limit,
        search,
      },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// create new user
exports.createUser = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      userId: req.user.email,
    };
    const response = await instance.post("/createUser", payload);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// update user
exports.updateUser = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      userName: req.user.email,
    };
    const response = await instance.put(
      `/updateUserById/${req.params.id}`,
      payload
    );
    console.log(response.data);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// delete user
exports.deleteUser = async (req, res) => {
  try {
    const response = await instance.post(`/deleteUserById/${req.params.id}`, {
      emsUser: req.user.email,
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// User Camera
exports.getCameras = async (req, res) => {
  try {
    const User = req.user;
    // Fetch camera data from the first backend
    const response = await instance.get(`/getCameras`, {
      params: {
        page: req.query.page || 1,
        limit: req.query.limit || 10,
        deviceId: req.query.deviceId || "",
        email: req.query.email || "",
      },
    });

    const cameras = response.data.data; // Extract camera data
    const deviceIds = cameras.map((camera) => camera.deviceId); // Extract deviceId array

    // Fetch related data from another table using deviceIds
    const relatedData = await Config.find(
      { topic: { $in: deviceIds } },
      "topic plan remotePortRtsp" // Fetch only topic and remotePortRtsp fields
    );

    // Map related data by topic
    const relatedDataMap = relatedData.reduce((acc, item) => {
      acc[item.topic] = item.remotePortRtsp; // Map topic to remotePortRtsp
      return acc;
    }, {});

    // Enrich the camera data with the related data
    const enrichedCameras = cameras.map((camera) => ({
      ...camera,
      remotePortRtsp: relatedDataMap[camera.deviceId] || null, // Use deviceId to look up remotePortRtsp
    }));

    // Return the enriched data with pagination
    res.json({
      success: true,
      data: enrichedCameras,
      usersRole: User.role,
      pagination: response.data.pagination, // Preserve original pagination
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// add camera
exports.addCameraToUser = async (req, res) => {
  console.log("addCameraToUser called");
  try {
    const payload = {
      ...req.body,
      userId: req.user.email,
    };
    const response = await instance.post(`/addCameraToUser`, payload);
    res.json(response.data);
  } catch (error) {
    console.log(error, "suchheroroooooooooor......");
    res.status(500).json({ message: error.message });
  }
};

// delete camera
exports.deleteCameraFromUser = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      userId: req.user.email,
    };
    const response = await instance.post(`/deleteCameraFromUser`, payload);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.bulkAddCamerasToUser = async (req, res) => {
  try {
    const response = await instance.post(`/bulkAddCamerasToUser`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// update camera
exports.updateCamera = async (req, res) => {
  try {
    const { deviceId, productType, remotePortRtsp, plan } = req.body;

    const now = new Date();
    const updatedBody = {
      ...req.body,
      userName: req.user.email,
      planStartDate: req.body.planStartDate || now.toLocaleString(),
      planEndDate:
        req.body.planEndDate ||
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleString(),
    };

    // 1. Call External API
    const response = await instance.post(`/updateCamera`, updatedBody);

    // 2. Check if the external update was successful
    if (response.data && response.data.success) {
      console.log("External update successful. Syncing local database...");

      // --- A. Update p2predirect (ProductType & MQTT URL) ---
      if (productType) {

        await p2predirect.updateOne(
          { deviceId },
          {
            $set: {
              productType
            }
          }
        );
        console.log(`Updated p2predirect for ${deviceId}`);
      }

      // --- B. Update Config (RTSP Port & Plan) ---
      // Only update Config if we have a valid port (meaning it's not a 'LIVE' plan with no port)
      if (remotePortRtsp && plan !== 'LIVE') {
        await Config.updateOne(
          { topic: deviceId },
          {
            $set: {
              remotePortRtsp: Math.floor(remotePortRtsp), // Ensure it is a number
              planName: plan,
              typeRtsp: "tcp",
              local_portRtsp: 554,
              local_ipRtsp: "127.0.0.1",
              subdomainRtsp: `RTSP-${deviceId}`
            }
          },
          { upsert: true } // Create the config if it doesn't exist
        );
        console.log(`Updated Config for ${deviceId} with port ${remotePortRtsp}`);
      }
      else if (plan === 'LIVE') {
        // Optional: If plan is LIVE, you might want to remove the RTSP port from Config
        // or simply update the plan name.
        await Config.updateOne(
          { topic: deviceId },
          { $set: { planName: plan } }
        );
      }
    }

    console.log("response", response.data, "response");
    res.json(response.data);

  } catch (error) {
    console.error("Error in updateCamera:", error);
    // Safely handle errors from the external axios call
    const status = error.response ? error.response.status : 500;
    const msg = error.response ? error.response.data : { message: error.message };
    res.status(status).json(msg);
  }
};

// get dashboard data (debug-friendly, works without $isDate/$isString)
exports.getDashboardData = async (req, res) => {
  try {
    console.log("📊 [START] getDashboardData called");

    // Step 1: External API
    console.log("➡ Fetching external API data...");
    const response = await instance.get(`/userCameraCount`);
    console.log(
      "✅ External API data received (keys):",
      Object.keys(response.data || {})
    );

    // Step 2: Basic counts
    const totalCamera = await p2predirect.countDocuments();
    const connectedOnce = await p2predirect.countDocuments({
      lastStartTime: { $ne: null },
    });
    console.log(
      "📦 totalCamera:",
      totalCamera,
      "connectedOnce:",
      connectedOnce
    );

    // Step 3: Date setup
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const now = new Date();
    const currentYearStr = String(new Date().getFullYear());

    function fmt(date) {
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const hh = String(date.getHours()).padStart(2, "0");
      const min = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      return `${mm}-${dd} ${hh}:${min}:${ss}`;
    }

    console.log("🕒 startOfToday:", fmt(startOfToday), " | now:", fmt(now));

    // Build aggregation but without $isDate / $isString (use $type checks instead)
    console.log("🧩 Building aggregation pipeline...");

    const agg = [
      // 1) Add parsed fields using $type checks instead of $isDate/$isString
      {
        $addFields: {
          // check if field is date: $type returns "date" for Date objects
          lastStartTimeParsed: {
            $cond: [
              { $eq: [{ $type: "$lastStartTime" }, "date"] },
              "$lastStartTime",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $type: "$lastStartTime" }, "string"] },
                      { $ne: ["$lastStartTime", ""] },
                    ],
                  },
                  {
                    $dateFromString: {
                      dateString: {
                        $concat: [currentYearStr, "-", "$lastStartTime"],
                      },
                      format: "%Y-%m-%d %H:%M:%S",
                      onError: null,
                      onNull: null,
                    },
                  },
                  null,
                ],
              },
            ],
          },

          lastCloseTimeParsed: {
            $cond: [
              { $eq: [{ $type: "$lastCloseTime" }, "date"] },
              "$lastCloseTime",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $type: "$lastCloseTime" }, "string"] },
                      { $ne: ["$lastCloseTime", ""] },
                    ],
                  },
                  {
                    $dateFromString: {
                      dateString: {
                        $concat: [currentYearStr, "-", "$lastCloseTime"],
                      },
                      format: "%Y-%m-%d %H:%M:%S",
                      onError: null,
                      onNull: null,
                    },
                  },
                  null,
                ],
              },
            ],
          },
        },
      },

      // DEBUG: project a few parsed samples to inspect parsing (we will run a separate pipeline for samples below)
      // Sort to help grouping
      { $sort: { deviceId: 1, lastStartTimeParsed: -1 } },

      // Group to latest per device
      {
        $group: {
          _id: "$deviceId",
          lastStartTime: { $first: "$lastStartTimeParsed" },
          lastCloseTime: { $first: "$lastCloseTimeParsed" },
        },
      },

      // Keep only docs that have a parsed lastStartTime (for sample inspection)
      { $match: { lastStartTime: { $ne: null } } },

      // Limit sample size so this debug pipeline stays cheap
      { $limit: 5 },

      // Project readable fields
      {
        $project: {
          deviceId: "$_id",
          lastStartTime: 1,
          lastCloseTime: 1,
        },
      },
    ];

    console.log(
      "🔎 Running small debug aggregation to inspect parsed timestamps..."
    );
    const debugSamples = await p2predirect.aggregate(agg);
    console.log(
      "🔍 Debug samples (parsed latest per device):",
      JSON.stringify(debugSamples, null, 2)
    );

    // Now run the real pipeline for counting
    const countAgg = [
      // parse same as above
      {
        $addFields: {
          lastStartTimeParsed: {
            $cond: [
              { $eq: [{ $type: "$lastStartTime" }, "date"] },
              "$lastStartTime",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $type: "$lastStartTime" }, "string"] },
                      { $ne: ["$lastStartTime", ""] },
                    ],
                  },
                  {
                    $dateFromString: {
                      dateString: {
                        $concat: [currentYearStr, "-", "$lastStartTime"],
                      },
                      format: "%Y-%m-%d %H:%M:%S",
                      onError: null,
                      onNull: null,
                    },
                  },
                  null,
                ],
              },
            ],
          },

          lastCloseTimeParsed: {
            $cond: [
              { $eq: [{ $type: "$lastCloseTime" }, "date"] },
              "$lastCloseTime",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $type: "$lastCloseTime" }, "string"] },
                      { $ne: ["$lastCloseTime", ""] },
                    ],
                  },
                  {
                    $dateFromString: {
                      dateString: {
                        $concat: [currentYearStr, "-", "$lastCloseTime"],
                      },
                      format: "%Y-%m-%d %H:%M:%S",
                      onError: null,
                      onNull: null,
                    },
                  },
                  null,
                ],
              },
            ],
          },
        },
      },

      // sort+group to get latest per device
      { $sort: { deviceId: 1, lastStartTimeParsed: -1 } },
      {
        $group: {
          _id: "$deviceId",
          lastStartTime: { $first: "$lastStartTimeParsed" },
          lastCloseTime: { $first: "$lastCloseTimeParsed" },
        },
      },

      // match live/today logic
      {
        $match: {
          lastStartTime: { $ne: null, $lte: now },
          $or: [
            { lastCloseTime: null },
            { $expr: { $gt: ["$lastStartTime", "$lastCloseTime"] } },
            { lastCloseTime: { $gte: startOfToday } },
          ],
        },
      },

      // final count
      { $count: "uniqueLiveToday" },
    ];

    console.log("⚙️ Running count aggregation...");
    const aggResult = await p2predirect.aggregate(countAgg);
    console.log("📊 Aggregation result:", aggResult);

    const todaysConnectedCamera =
      (aggResult[0] && aggResult[0].uniqueLiveToday) || 0;
    console.log("✅ todaysConnectedCamera count:", todaysConnectedCamera);

    // Respond
    res.json({
      ...response.data,
      totalCamera,
      connectedOnce,
      todaysConnectedCamera,
    });

    console.log("🎯 [END] getDashboardData completed successfully");
  } catch (error) {
    console.error("❌ [ERROR] getDashboardData failed:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.flushRedis = async (req, res) => {
  try {
    console.log("flushRedis");
    const response = await instance.get(`/flush`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
