// ============ CEMANI HOMESTEAD ROBOT - VPS SERVER ============
// Main entry point - coordinates WebSocket connections and message routing

const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Import modules
const state = require('./server-state');
const odometry = require('./server-odometry');
const ptzServer = require('./ptz-server');
const compile = require('./compile');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Share WSS with state module
state.setWss(wss);

// ============ BASIC AUTH ============
let authConfig = null;
try {
  authConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth.json'), 'utf8'));
  console.log('[AUTH] Basic authentication enabled');
} catch (e) {
  console.log('[AUTH] No auth.json found - running without authentication');
}

if (authConfig) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Cemani Robot v2"');
      return res.status(401).send('Authentication required');
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    if (user === authConfig.username && pass === authConfig.password) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Cemani Robot v2"');
      return res.status(401).send('Invalid credentials');
    }
  });
}

// Disable caching for HTML and JS files
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// HLS output directory
const HLS_DIR = "/opt/robot-server/public/hls";
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// Ensure compile directories exist
compile.ensureDirectories();

// Start PTZ server on port 3002
ptzServer.startPtzServer(3002);

const PING_INTERVAL = 30000;

// ============ WEBSOCKET HANDLER ============
wss.on("connection", (ws, req) => {
  console.log("[WS] Client connected from", req.socket.remoteAddress);

  // Enable TCP_NODELAY for lower latency
  if (req.socket) {
    req.socket.setNoDelay(true);
  }

  ws.connectedAt = Date.now();
  ws.frameCount = 0;
  ws.send(JSON.stringify({ type: "status", ...state.robotStatus, camera: state.cameraStatus }));
  ws.isAlive = true;
  ws.missedPings = 0;
  ws.isBrowser = true;
  ws.on("pong", () => { ws.isAlive = true; ws.missedPings = 0; });

  ws.on("message", (msg, isBinary) => {
    ws.isAlive = true;
    ws.missedPings = 0;

    // Handle binary talkback audio from browser
    if (isBinary && ws.isBrowser) {
      const data = Buffer.from(msg);
      if (data.length > 1 && data[0] === 0x10) {
        const cameraSocket = state.getCameraSocket();
        if (cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
          cameraSocket.send(msg);
        }
        return;
      }
    }

    // Handle binary frames from camera relay
    if (isBinary && ws.isCamera) {
      handleCameraFrame(ws, msg);
      return;
    }

    try {
      const msgStr = msg.toString();
      if (msgStr.includes('ptz') || msgStr.includes('PTZ')) {
        console.log("[RAW PTZ]", msgStr.substring(0, 150));
      }
      const data = JSON.parse(msg);

      if (data.type !== 'lidar' && data.type !== 'serial') {
        console.log("[MSG]", data.type, JSON.stringify(data).substring(0, 100));
      }

      handleMessage(ws, data);

    } catch (err) {
      const rawMsg = typeof msg === 'string' ? msg : msg.toString();
      if (rawMsg.includes('ptz') || rawMsg.includes('PTZ') || rawMsg.includes('DPAD')) {
        console.error("[WS] PTZ Parse Error:", err.message, "RAW:", rawMsg.substring(0, 200));
      } else {
        console.error("[WS] Error:", err.message);
      }
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });
});

// ============ MESSAGE HANDLERS ============
function handleMessage(ws, data) {
  const robotSocket = state.getRobotSocket();
  const cameraSocket = state.getCameraSocket();

  // Robot identification
  if (data.type === "robot_hello") {
    state.setRobotSocket(ws);
    ws.isRobot = true;
    ws.isBrowser = false;
    state.robotStatus.connected = true;
    state.robotStatus.version = data.version || "unknown";
    state.robotStatus.wifi = data.wifi || "unknown";
    state.robotStatus.lastSeen = Date.now();
    state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected });
    console.log("[ROBOT] ESP32 connected");
  }

  // Robot telemetry
  if (data.type === "telemetry") {
    if (!ws.isRobot) {
      state.setRobotSocket(ws);
      ws.isRobot = true;
      ws.isBrowser = false;
      console.log("[ROBOT] ESP32 connected via telemetry");
    }
    state.robotStatus.connected = true;
    state.robotStatus.version = data.version || state.robotStatus.version;
    state.robotStatus.wifi = data.wifi || state.robotStatus.wifi;
    state.robotStatus.rssi = data.rssi || 0;
    state.robotStatus.ip = data.ip || state.robotStatus.ip;
    state.robotStatus.uptime = data.uptime || 0;
    state.robotStatus.controller = data.controller || "none";
    state.robotStatus.lastSeen = Date.now();
    state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected });
  }

  // Serial data from robot
  if (data.type === "serial" && ws.isRobot) {
    handleSerialData(data, ws);
  }

  // Commands to robot
  if (data.type === "command") {
    console.log("[CMD] Received:", data.data);
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "command", data: data.data }));
    }
  }

  // Joystick control
  if (data.type === "joystick") {
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "joystick", lx: data.lx, ly: data.ly }));
    }
  }

  // Discrete movement commands
  if (data.type === "move_command") {
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({
        type: "move_command",
        turn: data.turn || 0,
        distance: data.distance || 0,
        direction: data.direction || "N"
      }));
      console.log("[MOVE] Command:", data.direction, data.distance + "m", "turn:", data.turn + "°");
    }
  }

  // Emergency stop
  if (data.type === "emergency_stop") {
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "emergency_stop" }));
      console.log("[MOVE] EMERGENCY STOP");
    }
  }

  // Compile and flash
  if (data.type === "compile") {
    compile.handleCompile(data.target, data.code, ws);
  }
  if (data.type === "flash_prebuilt") {
    compile.handleFlashPrebuilt(ws);
  }

  // Ping
  if (data.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
  }

  // Jetson lidar
  if (data.type === "identify" && data.device === "jetson-lidar") {
    ws.isJetsonLidar = true;
    console.log("[JETSON] Lidar relay connected");
  }
  if (data.type === "lidar" && ws.isJetsonLidar) {
    state.broadcast({ type: "lidar", points: data.points, count: data.count }, ws);
  }

  // Status request
  if (data.type === "get_status") {
    ws.isBrowser = true;
    ws.send(JSON.stringify({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected }));
    ws.send(JSON.stringify({ type: "camera_streams", cameras: state.perCameraStatus }));
  }

  // Audio mute
  if (data.type === "audio_mute") {
    ws.audioMuted = data.muted;
  }

  // Odometry reset
  if (data.type === "reset_odometry") {
    odometry.resetOdometry();
  }

  // Camera relay messages
  if (data.type === "camera_hello") {
    state.setCameraSocket(ws);
    ws.isCamera = true;
    ws.isBrowser = false;
    state.cameraStatus.connected = true;
    state.cameraStatus.ip = data.ip || "unknown";
    state.broadcast({ type: "camera_status", ...state.cameraStatus });
    console.log("[CAMERA] Relay connected, IP:", state.cameraStatus.ip);
  }

  // Forward camera results to browsers
  if (data.type === "cam_ptz_result" && ws.isCamera) {
    state.broadcast({ type: "cam_ptz_result", ...data }, ws);
  }
  if (data.type === "cam_setting_result" && ws.isCamera) {
    state.broadcast({ type: "cam_setting_result", ...data }, ws);
  }
  if (data.type === "cam_snapshot_data" && ws.isCamera) {
    state.broadcast({ type: "cam_snapshot_data", camera: data.camera, data: data.data }, ws);
  }

  // PTZ commands
  handlePtzCommand(data, ws);

  // Camera settings and snapshots
  const cs = state.getCameraSocket();
  if (data.type === "cam_setting" && cs && cs.readyState === WebSocket.OPEN) {
    cs.send(JSON.stringify(data));
  }
  if (data.type === "cam_snapshot" && cs && cs.readyState === WebSocket.OPEN) {
    cs.send(JSON.stringify(data));
  }
  if ((data.type === "talkback_start" || data.type === "talkback_stop") && cs && cs.readyState === WebSocket.OPEN) {
    cs.send(JSON.stringify(data));
    console.log('[TALKBACK]', data.type, 'camera:', data.camera);
  }
}

// Handle serial data from robot (includes TELEM messages)
function handleSerialData(data, ws) {
  // Detect Teensy version message
  if (data.data && data.data.startsWith("TEENSY_VERSION,")) {
    const parts = data.data.split(",");
    if (parts.length >= 2) {
      state.teensyStatus.version = parts[1].trim();
      state.teensyStatus.connected = true;
      state.teensyStatus.lastSeen = Date.now();
      console.log(`[TEENSY] Version: ${state.teensyStatus.version}`);
      state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected, teensyVersion: state.teensyStatus.version });
    }
  }

  // Parse TELEM messages for telemetry and odometry
  if (data.data && data.data.startsWith("TELEM,")) {
    state.teensyStatus.connected = true;
    state.teensyStatus.lastSeen = Date.now();

    const parts = data.data.split(",");
    if (parts.length >= 15) {
      const posL = parseInt(parts[13]) || 0;
      const posR = parseInt(parts[14]) || 0;

      // Process encoders for odometry
      const odomData = odometry.processEncoders(posL, posR);

      // Build telemetry data
      const telemData = {
        type: "teensy_telemetry",
        batteryV: parseFloat(parts[1]),
        batteryPct: parseInt(parts[2]),
        motorTempLF_F: parseInt(parts[3]),
        motorTempLR_F: parseInt(parts[4]),
        motorTempRF_F: parseInt(parts[5]),
        motorTempRR_F: parseInt(parts[6]),
        motorTempL_F: Math.round((parseInt(parts[3]) + parseInt(parts[4])) / 2),
        motorTempR_F: Math.round((parseInt(parts[5]) + parseInt(parts[6])) / 2),
        driverTemp1_F: parseInt(parts[7]),
        driverTemp2_F: parseInt(parts[8]),
        velL: parseFloat(parts[9]),
        velR: parseFloat(parts[10]),
        torqueL: parseFloat(parts[11]),
        torqueR: parseFloat(parts[12]),
        posL: posL,
        posR: posR,
        ...odomData
      };

      state.broadcast(telemData, ws);
    }
  }

  state.broadcast({ type: "serial", data: data.data }, ws);
}

// Handle PTZ commands from browser or ESP32
function handlePtzCommand(data, ws) {
  const ptzRelaySocket = ptzServer.getPtzRelaySocket();

  // Handle ptz_cmd from ESP32
  if (data.type === "ptz_cmd" && data.cmd) {
    console.log("[PTZ] Received ptz_cmd:", data.cmd);
    const parts = data.cmd.split(",");
    let ptzData = null;

    if (parts[0] === "PTZ_MOVE" && parts.length >= 4) {
      ptzData = {
        type: "cam_ptz",
        camera: parseInt(parts[1]),
        action: "move",
        pan: parseInt(parts[2]),
        tilt: parseInt(parts[3]),
        zoom: 0
      };
    } else if (parts[0] === "PTZ_STOP" && parts.length >= 2) {
      ptzData = {
        type: "cam_ptz",
        camera: parseInt(parts[1]),
        action: "stop"
      };
    }

    if (ptzData && ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
      ptzRelaySocket.send(JSON.stringify(ptzData));
      console.log("[PTZ] Forwarded to relay:", ptzData.action, "cam", ptzData.camera);
    }
  }

  // Forward cam_ptz to PTZ relay
  if (data.type === "cam_ptz") {
    console.log("[PTZ] Received:", data.action, "from", ws.isRobot ? "ESP32" : "browser");
    if (ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
      ptzRelaySocket.send(JSON.stringify(data));
      console.log("[PTZ] Forwarded to PTZ relay");
    }
  }
}

// Handle binary camera frames
function handleCameraFrame(ws, msg) {
  const data = Buffer.from(msg);
  if (data.length < 2) return;

  const packetType = data[0];
  const payload = data.slice(1);
  const cameraId = Math.floor(packetType / 2) + 1;
  const isVideo = packetType % 2 === 0;

  if (isVideo) {
    state.cameraStatus.streaming = true;
    const frameTime = Date.now();
    if (state.perCameraStatus[cameraId]) {
      state.perCameraStatus[cameraId].streaming = true;
      state.perCameraStatus[cameraId].lastFrame = frameTime;
    }

    let count = 0, dropped = 0;
    wss.clients.forEach(c => {
      if (c !== ws && c.readyState === WebSocket.OPEN && c.isBrowser) {
        if (c.bufferedAmount > 0) { dropped++; return; }
        try { c.send(msg); count++; } catch (e) { }
      }
    });

    if (Math.random() < 0.02) {
      console.log(`[CAM${cameraId}-VIDEO] Sent ${payload.length} bytes to ${count} browsers${dropped ? `, dropped ${dropped}` : ''}`);
    }
  } else {
    let count = 0;
    wss.clients.forEach(c => {
      if (c !== ws && c.readyState === WebSocket.OPEN && c.isBrowser && !c.audioMuted) {
        try { c.send(msg); count++; } catch (e) { }
      }
    });
  }
}

// Handle WebSocket disconnection
function handleDisconnect(ws) {
  const robotSocket = state.getRobotSocket();
  const cameraSocket = state.getCameraSocket();

  if (ws.isRobot && ws === robotSocket) {
    state.setRobotSocket(null);
    state.robotStatus.connected = false;
    state.robotStatus.wifi = "unknown";
    state.robotStatus.rssi = 0;
    state.robotStatus.ip = "unknown";
    state.robotStatus.version = "unknown";
    state.robotStatus.uptime = 0;
    state.robotStatus.controller = "none";
    state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus });
    console.log("[ROBOT] ESP32 disconnected");
  }

  if (ws.isCamera && ws === cameraSocket) {
    state.setCameraSocket(null);
    state.cameraStatus.connected = false;
    state.cameraStatus.streaming = false;
    state.broadcast({ type: "camera_status", ...state.cameraStatus });
    console.log("[CAMERA] Relay disconnected");
  }
}

// ============ KEEPALIVE ============
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPings = (ws.missedPings || 0) + 1;
      if (ws.missedPings >= 3) {
        console.log("[PING] Client missed 3 pings, disconnecting");
        handleDisconnect(ws);
        return ws.terminate();
      }
    } else {
      ws.missedPings = 0;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

// ============ CAMERA/TEENSY TIMEOUT CHECK ============
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const camId of [1, 2]) {
    const cam = state.perCameraStatus[camId];
    const wasStreaming = cam.streaming;
    cam.streaming = (now - cam.lastFrame) < state.CAMERA_TIMEOUT_MS;
    if (wasStreaming !== cam.streaming) {
      changed = true;
      console.log(`[CAM${camId}] Streaming: ${cam.streaming}`);
    }
  }

  if (changed) {
    state.broadcast({ type: "camera_streams", cameras: state.perCameraStatus });
  }

  // Check Teensy timeout
  const wasTeensyConnected = state.teensyStatus.connected;
  state.teensyStatus.connected = (now - state.teensyStatus.lastSeen) < state.TEENSY_TIMEOUT_MS;
  if (wasTeensyConnected !== state.teensyStatus.connected) {
    console.log(`[TEENSY] Connected: ${state.teensyStatus.connected}`);
    state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected });
  }
}, 1000);

// ============ START SERVER ============
server.listen(3001, "0.0.0.0", () => {
  console.log("[SERVER] Running on port 3001");
  console.log("[SERVER] HLS directory:", HLS_DIR);
});
