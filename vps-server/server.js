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
const agent = require('./server-agent');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Share WSS with state module
state.setWss(wss);

// ============ MANUAL OVERRIDE SAFETY ============
// Xbox/joystick/drive system is KING - always overrides autonomous
// When manual input detected, block autonomous commands for 10 seconds
global.manualOverrideUntil = 0;  // Timestamp when manual override expires
global.emergencyStopActive = false;  // Sticky E-stop flag - requires explicit clear
const MANUAL_OVERRIDE_DURATION = 5000;  // Block autonomous for 5 seconds after manual input

// ============ MAPPING STATE ============
global.mappingActive = false;  // Is autonomous mapping mode active?
global.mappingWasPaused = false;  // Was mapping paused by manual override?
global.autoResumeTimeout = null;  // Timeout for auto-resume after override

function setManualOverride() {
  const wasActive = isManualOverrideActive();
  global.manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_DURATION;
  console.log(`[OVERRIDE] Manual control active for ${MANUAL_OVERRIDE_DURATION/1000}s`);

  // Notify Mac mapper of manual override (pause mapping)
  if (global.mappingActive && !wasActive) {
    global.mappingWasPaused = true;
    broadcastToProcessors({ type: "manual_override", active: true });
    console.log(`[MAPPING] Paused for manual override`);
  }

  // Set up auto-resume when override expires
  if (global.mappingActive) {
    if (global.autoResumeTimeout) clearTimeout(global.autoResumeTimeout);
    global.autoResumeTimeout = setTimeout(() => {
      if (global.mappingActive && global.mappingWasPaused && !global.emergencyStopActive) {
        global.mappingWasPaused = false;
        broadcastToProcessors({ type: "manual_override", active: false });
        console.log(`[MAPPING] Auto-resumed after manual override`);
        // Resume autonomous driving too
        resumeAutonomousDriving();
      }
    }, MANUAL_OVERRIDE_DURATION + 500);  // 500ms grace period
  }
}

function isManualOverrideActive() {
  // E-stop is sticky - blocks until explicitly cleared
  if (global.emergencyStopActive) return true;
  return Date.now() < global.manualOverrideUntil;
}

function setEmergencyStop() {
  global.emergencyStopActive = true;
  global.manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_DURATION;
  console.log(`[E-STOP] Emergency stop ACTIVE - autonomous BLOCKED until cleared`);
}

function clearEmergencyStop() {
  global.emergencyStopActive = false;
  console.log(`[E-STOP] Emergency stop CLEARED - autonomous allowed`);
}

// Broadcast to all Mac processor clients
function broadcastToProcessors(msg) {
  const msgStr = JSON.stringify(msg);
  let count = 0;
  let totalClients = 0;
  wss.clients.forEach(client => {
    totalClients++;
    if (client.isProcessor && client.readyState === WebSocket.OPEN) {
      client.send(msgStr);
      count++;
    }
  });
  console.log(`[PROCESSOR] Broadcast ${msg.type}: sent to ${count}/${totalClients} clients (processors)`);
}

// Resume autonomous driving after manual override
function resumeAutonomousDriving() {
  if (!global.mappingActive) return;

  const rs = state.getRobotSocket();
  if (rs && rs.readyState === WebSocket.OPEN) {
    // Restart the auto-drive interval if it was stopped
    if (!global.autoInterval) {
      console.log(`[AUTONOMOUS] Resuming auto-drive after override`);
      global.autoDirection = "FWD";
      global.autoCmdCount = 0;
      global.autoInterval = setInterval(() => {
        if (isManualOverrideActive()) {
          return;  // Skip this tick silently
        }
        const robotSock = state.getRobotSocket();
        if (robotSock && robotSock.readyState === WebSocket.OPEN) {
          const cmd = `AUTO_${global.autoDirection},25`;
          robotSock.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
          global.autoCmdCount++;
          if (global.autoCmdCount % 10 === 0) {
            console.log(`[AUTO-DRIVE] Resumed: sent ${global.autoCmdCount} cmds, current: ${cmd}`);
          }
        }
      }, 300);

      // BROADCAST to update UI - no longer paused!
      state.broadcast({ type: "autonomous_status", running: true, paused: false, mode: "direct" });
      console.log(`[AUTONOMOUS] Broadcast: resumed from pause`);
    }
  }
}

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
    // Allow localhost to access /spin without auth
    const ip = req.ip || req.connection.remoteAddress;
    if ((ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && req.path.startsWith('/spin')) {
      return next();
    }
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

// Disable caching for all web assets
app.use((req, res, next) => {
  // Apply to all static files
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

// HTTP endpoint to spin robot - bypass websocket issues
app.get('/spin/:direction/:degrees', (req, res) => {
  const direction = req.params.direction.toUpperCase();
  const degrees = parseInt(req.params.degrees) || 120;

  console.log(`[HTTP-SPIN] Request: ${direction} ${degrees}°`);

  const rs = state.getRobotSocket();
  if (rs && rs.readyState === 1) { // WebSocket.OPEN = 1
    const cmd = direction === 'RIGHT' ? `MOVE,${degrees},0` : `MOVE,-${degrees},0`;
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
    console.log(`[HTTP-SPIN] Sent to robot: ${cmd}`);
    res.json({ success: true, command: cmd });
  } else {
    console.log(`[HTTP-SPIN] Robot socket not available!`);
    res.status(503).json({ error: 'Robot not connected' });
  }
});

// GPU Renderer - receives frames via WebSocket from Mac processor
let gpuRendererConnected = false;
let latestGpuFrame = null;  // Buffer containing latest JPEG frame
let gpuFrameTimestamp = 0;
const GPU_FRAME_TIMEOUT_MS = 5000;

// MJPEG streaming endpoint - serves frames received via WebSocket
app.get('/gpu-stream', (req, res) => {
  if (!gpuRendererConnected || !latestGpuFrame) {
    res.status(503).send('GPU renderer not connected or no frames available');
    return;
  }

  console.log(`[GPU-STREAM] Client connected from ${req.ip}`);

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send frames at ~15 FPS
  const sendFrame = () => {
    if (latestGpuFrame && (Date.now() - gpuFrameTimestamp) < GPU_FRAME_TIMEOUT_MS) {
      try {
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n\r\n');
        res.write(latestGpuFrame);
        res.write('\r\n');
      } catch (e) {
        clearInterval(interval);
      }
    }
  };

  const interval = setInterval(sendFrame, 67);  // ~15 FPS
  sendFrame();  // Send first frame immediately

  req.on('close', () => {
    clearInterval(interval);
    console.log('[GPU-STREAM] Client disconnected');
  });
});

app.get('/gpu-status', (req, res) => {
  res.json({
    connected: gpuRendererConnected,
    hasFrames: !!latestGpuFrame,
    frameAge: latestGpuFrame ? Date.now() - gpuFrameTimestamp : null,
    streamUrl: gpuRendererConnected ? `/gpu-stream` : null
  });
});

// HLS output directory
const HLS_DIR = "/opt/robot-server/public/hls";
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ============ FINGERPRINT STORAGE ============
// Persistent storage for area fingerprints and 3D maps
const FINGERPRINT_DIR = "/opt/robot-server/fingerprints";
const MAPS_DIR = "/opt/robot-server/maps";
if (!fs.existsSync(FINGERPRINT_DIR)) fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
if (!fs.existsSync(MAPS_DIR)) fs.mkdirSync(MAPS_DIR, { recursive: true });

// Load all saved fingerprints on startup
let savedFingerprints = [];
function loadAllFingerprints() {
  savedFingerprints = [];
  try {
    const files = fs.readdirSync(FINGERPRINT_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(FINGERPRINT_DIR, file), 'utf8'));
          savedFingerprints.push(data);
        } catch (e) {
          console.log(`[FINGERPRINT] Failed to load ${file}:`, e.message);
        }
      }
    }
    console.log(`[FINGERPRINT] Loaded ${savedFingerprints.length} saved fingerprints`);
  } catch (e) {
    console.log(`[FINGERPRINT] No fingerprints directory yet`);
  }
}
loadAllFingerprints();

// Save a fingerprint to disk
function saveFingerprint(data) {
  try {
    const filename = `${data.name}.json`;
    fs.writeFileSync(path.join(FINGERPRINT_DIR, filename), JSON.stringify(data, null, 2));

    // Update in-memory array
    const existingIdx = savedFingerprints.findIndex(fp => fp.name === data.name);
    if (existingIdx >= 0) {
      savedFingerprints[existingIdx] = data;
    } else {
      savedFingerprints.push(data);
    }
    console.log(`[FINGERPRINT] Saved: ${data.name} (${data.pointCount || 0} pts)`);
    return true;
  } catch (e) {
    console.error(`[FINGERPRINT] Save failed:`, e.message);
    return false;
  }
}

// Save 3D map data to disk
function save3DMap(name, mapData) {
  try {
    const filename = `${name}.json`;
    fs.writeFileSync(path.join(MAPS_DIR, filename), JSON.stringify(mapData));
    console.log(`[3D MAP] Saved: ${name} (${mapData.points?.length || 0} pts)`);
    return true;
  } catch (e) {
    console.error(`[3D MAP] Save failed:`, e.message);
    return false;
  }
}

// Load 3D map from disk
function load3DMap(name) {
  try {
    const filename = `${name}.json`;
    const filepath = path.join(MAPS_DIR, filename);
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {
    console.error(`[3D MAP] Load failed:`, e.message);
  }
  return null;
}

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
  ws.clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${ws.clientIP}`);
  ws.send(JSON.stringify({ type: "status", ...state.robotStatus, camera: state.cameraStatus }));
  ws.isAlive = true;
  ws.missedPings = 0;
  ws.isBrowser = false;  // Don't assume browser - wait for identification to prevent flooding ESP32
  ws.on("pong", () => { ws.isAlive = true; ws.missedPings = 0; });

  ws.on("message", (msg, isBinary) => {
    ws.isAlive = true;
    ws.missedPings = 0;

    // DEBUG: Log ALL messages from new clients (first 5 messages)
    ws.msgCount = (ws.msgCount || 0) + 1;
    if (ws.msgCount <= 5) {
      const preview = isBinary ? `binary ${msg.length} bytes` : msg.toString().substring(0, 100);
      console.log(`[DEBUG-MSG] Client ${ws.clientIP} msg #${ws.msgCount}: ${preview}`);
    }

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
      // Debug: log first chars of ALL messages to catch issues
      if (msgStr.startsWith('{"type":')) {
        const typeMatch = msgStr.match(/"type"\s*:\s*"([^"]+)"/);
        const msgType = typeMatch ? typeMatch[1] : 'unknown';
        // Only log non-routine messages
        if (!['lidar', 'serial', 'TELEM', 'COMPASS', 'SONAR'].includes(msgType)) {
          console.log("[RAW MSG]", msgType, msgStr.substring(0, 120));
        }
      }
      if (msgStr.includes('ptz') || msgStr.includes('PTZ')) {
        console.log("[RAW PTZ]", msgStr.substring(0, 150));
      }
      const data = JSON.parse(msg);

      // Log ALL messages for debugging (skip high-frequency lidar/serial)
      if (!['lidar', 'serial'].includes(data.type)) {
        console.log("[MSG]", data.type, JSON.stringify(data).substring(0, 150));
      }
      // EXPLICIT DEBUG for register_processor - this is critical for map display!
      if (data.type === 'register_processor') {
        console.log("[REGISTER] *** PROCESSOR REGISTRATION RECEIVED ***", JSON.stringify(data));
      }
      // Always log processor-related messages
      if (data.type === 'register_processor' || data.type === 'accumulated_map') {
        console.log("[PROCESSOR-MSG]", data.type, "isProcessor:", ws.isProcessor, "points:", data.points?.length || data.total || 0);
      }

      // Extra debug for autonomous control
      if (data.type === "autonomous_control") {
        console.log("[DEBUG-AUTO] Received autonomous_control:", JSON.stringify(data));
      }

      // Extra debug for registration
      if (data.type && data.type.includes("REGISTER")) {
        console.log("[DEBUG REGISTER]", JSON.stringify(data));
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

  ws.on("close", (code, reason) => {
    ws.closeCode = code;
    ws.closeReason = reason ? reason.toString() : '';
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
  if (data.type === "serial") {
    // Auto-identify robot socket from serial data
    if (!ws.isRobot) {
      state.setRobotSocket(ws);
      ws.isRobot = true;
      ws.isBrowser = false;
      console.log("[ROBOT] ESP32 connected via serial data");
    }
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

  // Joystick control - OVERRIDES autonomous mode (XBOX IS KING)
  if (data.type === "joystick") {
    // Set manual override - blocks ALL autonomous commands
    setManualOverride();

    // PAUSE autonomous if running - manual control takes priority
    // But DON'T change running status - AUTO mode stays active, just paused
    if (global.autoInterval) {
      clearInterval(global.autoInterval);
      global.autoInterval = null;
      console.log("[OVERRIDE] Joystick input - PAUSING autonomous (will auto-resume)");
      // Broadcast paused state but keep running=true so button stays AUTO
      state.broadcast({ type: "autonomous_status", running: true, paused: true, reason: "manual_override" });
    }
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

  // Click-to-navigate target from UI - HUMAN INPUT, overrides autonomous
  if (data.type === "nav_target") {
    // Set manual override - human is navigating
    setManualOverride();

    // PAUSE autonomous if running - will auto-resume after navigation
    if (global.autoInterval) {
      clearInterval(global.autoInterval);
      global.autoInterval = null;
      console.log("[OVERRIDE] Click-to-navigate - PAUSING autonomous (will auto-resume)");
      state.broadcast({ type: "autonomous_status", running: true, paused: true, reason: "manual_override" });
    }

    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      // Calculate angle and distance to target
      const odom = state.getOdometry();
      const dx = data.x - odom.x;
      const dy = data.y - odom.y;
      const distance = Math.sqrt(dx * dx + dy * dy) / 1000;  // mm to m
      const targetAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      const turn = targetAngle - odom.heading;

      // Normalize turn angle to -180 to 180
      let normalizedTurn = turn;
      while (normalizedTurn > 180) normalizedTurn -= 360;
      while (normalizedTurn < -180) normalizedTurn += 360;

      console.log(`[NAV] Target: (${data.x.toFixed(0)}, ${data.y.toFixed(0)}) mm, dist=${distance.toFixed(2)}m, turn=${normalizedTurn.toFixed(1)}°`);

      // Send as move command
      rs.send(JSON.stringify({
        type: "nav_goto",
        targetX: data.x,
        targetY: data.y,
        distance: distance,
        turn: normalizedTurn
      }));
    }
  }

  // Cancel navigation
  if (data.type === "nav_cancel") {
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "nav_cancel" }));
      console.log("[NAV] Cancelled");
    }
  }

  // Serial command to Teensy (via ESP32) - OVERRIDES autonomous mode for movement commands
  if (data.type === "serial_cmd") {
    // Movement commands override autonomous mode (FWD, BACK, LEFT, RIGHT, STOP, etc.)
    // NOTE: AUTO_ commands are from autonomous system, not manual - don't override for those
    const manualMovementCmds = ["FWD", "BACK", "LEFT", "RIGHT", "STOP", "TURN"];
    const isManualMovementCmd = manualMovementCmds.some(cmd =>
      data.cmd && data.cmd.includes(cmd) && !data.cmd.startsWith("AUTO_")
    );

    if (isManualMovementCmd) {
      // Set manual override - blocks ALL autonomous commands
      setManualOverride();

      if (global.autoInterval) {
        clearInterval(global.autoInterval);
        global.autoInterval = null;
        console.log("[OVERRIDE] Manual drive command - PAUSING autonomous:", data.cmd);
        state.broadcast({ type: "autonomous_status", running: true, paused: true, reason: "manual_override" });
      }
    }

    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "serial_cmd", cmd: data.cmd }));
      console.log("[SERIAL_CMD]", data.cmd);
    } else {
      console.log("[SERIAL_CMD] ❌ Robot socket not available for:", data.cmd);
    }
  }

  // Direct mapping_control from browser (MAP 1 button) - forward to Mac processors
  if (data.type === "mapping_control") {
    console.log("[MAP1] Received mapping_control from browser:", data.cmd);
    broadcastToProcessors({ type: "mapping_control", cmd: data.cmd });
    console.log("[MAP1] Forwarded to Mac processors");
  }

  // Robot spin command from Mac mapper - forward to robot
  if (data.type === "robot_spin") {
    console.log("[SPIN] Received spin command:", data.direction, data.degrees);
    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      const dir = data.direction === "RIGHT" ? "AUTO_RIGHT" : "AUTO_LEFT";
      const cmd = `${dir},${data.degrees}`;
      rs.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
      console.log("[SPIN] Sent to robot:", cmd);
    } else {
      console.log("[SPIN] Robot socket not available!");
    }
  }

  // Emergency stop - STICKY: blocks autonomous until explicitly cleared
  if (data.type === "emergency_stop") {
    // Set sticky E-stop flag - autonomous CANNOT resume until cleared
    setEmergencyStop();

    // Stop autonomous loop immediately
    if (global.autoInterval) {
      clearInterval(global.autoInterval);
      global.autoInterval = null;
      console.log("[E-STOP] Autonomous loop terminated");
      state.broadcast({ type: "autonomous_status", running: false, reason: "emergency_stop" });
    }

    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      rs.send(JSON.stringify({ type: "emergency_stop" }));
      console.log("[E-STOP] EMERGENCY STOP sent to robot");
    }

    // Notify browsers
    state.broadcast({ type: "emergency_stop_active", active: true });
  }

  // Clear emergency stop - allows autonomous to resume
  if (data.type === "clear_emergency_stop") {
    clearEmergencyStop();
    state.broadcast({ type: "emergency_stop_active", active: false });
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

    // LIDAR SAFETY: Check for obstacles in MAP mode
    // Only active when robot is in mapping mode
    if (state.robotStatus.mode === "mapping") {
      const LIDAR_STOP_CM = 40;  // 16 inches = stop distance
      const points = data.points || [];

      // Check front and rear sectors
      let minFrontDist = 9999;
      let minRearDist = 9999;

      for (const p of points) {
        const angle = p[0] || p.angle || 0;
        const dist = (p[1] || p.distance || 0) / 10;  // mm to cm

        if (dist <= 0) continue;

        // Front sector: 0-60° or 300-360°
        if ((angle >= 0 && angle <= 60) || (angle >= 300 && angle <= 360)) {
          if (dist < minFrontDist) minFrontDist = dist;
        }

        // Rear sector: 120-240°
        if (angle >= 120 && angle <= 240) {
          if (dist < minRearDist) minRearDist = dist;
        }
      }

      // Emergency stop if obstacle too close (front or rear)
      const minDist = Math.min(minFrontDist, minRearDist);
      if (minDist < LIDAR_STOP_CM) {
        const rs = state.getRobotSocket();
        if (rs && rs.readyState === 1) {
          rs.send(JSON.stringify({ type: "serial_cmd", cmd: "STOP" }));
          const direction = minFrontDist < minRearDist ? "FRONT" : "REAR";
          console.log(`[LIDAR SAFETY] STOP! ${direction} obstacle at ${minDist.toFixed(0)}cm`);
        }
      }
    }
  }

  // Jetson object detection
  if (data.type === "identify" && data.device === "jetson-detection") {
    ws.isJetsonDetection = true;
    console.log("[JETSON] Object detection connected");
  }
  if (data.type === "JETSON_REGISTER") {
    console.log("[JETSON_REGISTER] Received:", JSON.stringify(data));
    if (data.device === "autonomous") {
      ws.isAutonomous = true;
      console.log("[AUTONOMOUS] Navigator connected!");
      state.broadcast({ type: "autonomous_status", connected: true });
    } else {
      ws.isJetsonDetection = true;
      console.log("[JETSON] Object detection registered with capabilities:", data.capabilities);
    }
  }
  if (data.type === "DETECTIONS") {
    // Mark sender as detection source if not already identified
    if (!ws.isJetsonDetection) {
      ws.isJetsonDetection = true;
      console.log("[JETSON] Object detection connected via detections");
    }
    // Log priority detections
    const priority = data.detections.filter(d => d.is_priority);
    if (priority.length > 0) {
      console.log(`[DETECT] CAM${data.camera} PRIORITY: ${priority.map(p => p.class).join(', ')}`);
    }
    // Broadcast to all browsers (use VPS timestamp, not Jetson - clock sync issues)
    state.broadcast({
      type: "detections",
      camera: data.camera,
      detections: data.detections,
      count: data.count,
      timestamp: Date.now()  // Always use VPS server time to avoid clock sync issues
    }, ws);
  }

  // Detection settings from browser - broadcast to Jetson
  if (data.type === "detection_settings") {
    const cam = data.active_camera || 1;
    console.log(`[DETECT] Settings: cam=${cam}, filter=${data.filter_mode}, confidence=${data.confidence}`);
    // Send to all Jetson clients (detection AND relay for quality adjustment)
    wss.clients.forEach(client => {
      if ((client.isJetsonDetection || client.isJetsonRelay) && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "DETECTION_SETTINGS",
          active_camera: cam,
          filter_mode: data.filter_mode,
          confidence: data.confidence
        }));
      }
    });
  }

  // Agent chat from browser -> Claude API
  if (data.type === "agent_chat") {
    agent.handleChat(ws, data);
  }
  if (data.type === "agent_clear") {
    agent.clearConversation(data.sessionId);
  }

  // Feed telemetry to agent for context
  if (data.type === "teensy_telemetry" || data.type === "ultrasonic" || data.type === "compass") {
    agent.updateTelemetry(data);
  }

  // Brain commands from browser -> Jetson brain (forwarded via WebSocket)
  if (data.type === "brain_command") {
    // Forward to all autonomous clients (the brain)
    wss.clients.forEach(c => {
      if (c.isAutonomous && c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify(data));
      }
    });
    console.log(`[BRAIN] Browser command: ${data.action} ${data.value || ''}`);
  }

  // Brain responses from Jetson -> browsers
  if (data.type === "brain_status" || data.type === "brain_result") {
    state.broadcast(data, ws);
  }

  // Autonomous commands from Jetson -> Robot
  // BLOCKED when manual override is active (Xbox/drive system is KING)
  if (data.type === "autonomous_cmd") {
    // Check manual override - Xbox/joystick ALWAYS wins
    if (isManualOverrideActive()) {
      console.log(`[AUTONOMOUS] BLOCKED by manual override: ${data.cmd}`);
      return;  // Don't process autonomous command
    }

    const rs = state.getRobotSocket();
    if (rs && rs.readyState === WebSocket.OPEN) {
      // Map autonomous commands to serial commands
      const cmdMap = {
        "STOP": "STOP",
        "FORWARD": `AUTO_FWD,${data.value}`,
        "REVERSE": `AUTO_REV,${data.value}`,
        "TURN_LEFT": `AUTO_LEFT,${data.value}`,
        "TURN_RIGHT": `AUTO_RIGHT,${data.value}`
      };
      const serialCmd = cmdMap[data.cmd] || "STOP";
      rs.send(JSON.stringify({ type: "serial_cmd", cmd: serialCmd }));
      console.log(`[AUTONOMOUS] ${data.cmd} -> ${serialCmd}`);
    }
  }

  // Autonomous control from browser -> Jetson (or direct to robot)
  if (data.type === "autonomous_control") {
    // Count how many autonomous clients are connected
    let autoCount = 0;
    wss.clients.forEach(c => { if (c.isAutonomous && c.readyState === WebSocket.OPEN) autoCount++; });
    console.log(`[AUTONOMOUS] Control: ${data.cmd} -> ${autoCount} autonomous clients connected`);

    const rs = state.getRobotSocket();

    if (data.cmd === "START") {
      // Clear E-stop when user explicitly starts autonomous - they're ready to go
      if (global.emergencyStopActive) {
        clearEmergencyStop();
        state.broadcast({ type: "emergency_stop_active", active: false });
      }

      // Set mapping state ACTIVE
      global.mappingActive = true;
      global.mappingWasPaused = false;

      console.log(`[AUTONOMOUS] START received - robotSocket: ${rs ? 'exists' : 'null'}, state: ${rs ? rs.readyState : 'N/A'}`);

      // ====== START MAC GPU MAPPER ======
      // Tell all Mac processors to start mapping (GPU processing)
      broadcastToProcessors({ type: "mapping_control", cmd: "START" });
      console.log(`[MAPPING] ✓ Sent START to Mac GPU mapper(s)`);

      // Switch robot to mapping mode
      if (rs && rs.readyState === WebSocket.OPEN) {
        rs.send(JSON.stringify({ type: "serial_cmd", cmd: "MODE_MAPPING" }));
        console.log(`[AUTONOMOUS] ✓ Sent MODE_MAPPING to robot`);

        // Count Mac processors
        let processorCount = 0;
        wss.clients.forEach(client => {
          if (client.isProcessor && client.readyState === WebSocket.OPEN) {
            processorCount++;
          }
        });

        // If no autonomous.py AND no Mac processors, start direct control loop
        // Mac processors handle their own robot movement via move_command
        if (autoCount === 0 && processorCount === 0) {
          console.log(`[AUTONOMOUS] No Jetson navigator or Mac processor - starting direct control loop`);

          // Clear any existing interval
          if (global.autoInterval) clearInterval(global.autoInterval);

          // Send commands every 300ms (Teensy timeout is 500ms)
          global.autoDirection = "FWD";  // Track current direction
          global.autoCmdCount = 0;
          global.autoInterval = setInterval(() => {
            // Check manual override - Xbox/joystick ALWAYS wins
            if (isManualOverrideActive()) {
              // Don't spam logs - just skip
              return;  // Skip this tick, don't send command
            }

            const robotSock = state.getRobotSocket();
            if (robotSock && robotSock.readyState === WebSocket.OPEN) {
              // Send current direction command at 25 RPM (about 6 inches/sec)
              const cmd = `AUTO_${global.autoDirection},25`;
              robotSock.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
              global.autoCmdCount++;
              // Log every 10th command to avoid spam
              if (global.autoCmdCount % 10 === 0) {
                console.log(`[AUTO-DRIVE] Sent ${global.autoCmdCount} cmds, current: ${cmd}`);
              }
            } else {
              console.log(`[AUTONOMOUS] Robot disconnected - stopping auto loop`);
              clearInterval(global.autoInterval);
              global.autoInterval = null;
            }
          }, 300);

          // Send first command immediately at 25 RPM
          rs.send(JSON.stringify({ type: "serial_cmd", cmd: "AUTO_FWD,25" }));
          state.broadcast({ type: "autonomous_status", running: true, mode: "direct" });
        } else if (processorCount > 0) {
          console.log(`[AUTONOMOUS] ${processorCount} Mac processor(s) connected - they will handle robot movement`);
          state.broadcast({ type: "autonomous_status", running: true, mode: "mac_processor" });
        }
      } else {
        console.log(`[AUTONOMOUS] ⚠️  Robot not connected!`);
        state.broadcast({ type: "autonomous_error", error: "Robot not connected" });
      }

      // Also broadcast to Jetson autonomous.py if connected
      wss.clients.forEach(client => {
        if (client.isAutonomous && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "AUTONOMOUS_CONTROL", cmd: data.cmd }));
          console.log(`[AUTONOMOUS] Sent START to Jetson navigator`);
        }
      });

      // ALWAYS broadcast status to browsers so UI updates
      state.broadcast({ type: "autonomous_status", running: true, mode: "direct" });
      console.log(`[AUTONOMOUS] Broadcast: running=true`);

    } else if (data.cmd === "STOP" || data.cmd === "PAUSE") {
      // Set mapping state INACTIVE
      global.mappingActive = false;
      global.mappingWasPaused = false;
      if (global.autoResumeTimeout) {
        clearTimeout(global.autoResumeTimeout);
        global.autoResumeTimeout = null;
      }

      // Stop the auto command loop
      if (global.autoInterval) {
        clearInterval(global.autoInterval);
        global.autoInterval = null;
        console.log(`[AUTONOMOUS] Stopped auto command loop`);
      }

      // ====== STOP MAC GPU MAPPER ======
      broadcastToProcessors({ type: "mapping_control", cmd: "STOP" });
      console.log(`[MAPPING] ✓ Sent STOP to Mac GPU mapper(s)`);

      // Stop robot
      if (rs && rs.readyState === WebSocket.OPEN) {
        rs.send(JSON.stringify({ type: "serial_cmd", cmd: "STOP" }));
        rs.send(JSON.stringify({ type: "serial_cmd", cmd: "MODE_MANUAL" }));
        console.log(`[AUTONOMOUS] Sent STOP + MODE_MANUAL to robot`);
      }
      // Notify Jetson
      wss.clients.forEach(client => {
        if (client.isAutonomous && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "AUTONOMOUS_CONTROL", cmd: data.cmd }));
        }
      });
      state.broadcast({ type: "autonomous_status", running: false });
    }
  }

  // Map status from autonomous Jetson - broadcast to all browsers
  if (data.type === "map_status") {
    // Store map state
    state.mapStatus = {
      robot_x: data.robot_x || 0,
      robot_y: data.robot_y || 0,
      robot_heading: data.robot_heading || 0,
      static_cells: data.static_cells || 0,
      total_cells: data.total_cells || 0,
      map_coverage: data.map_coverage || 0,
      updated: Date.now()
    };
    // Broadcast to all browsers
    state.broadcast({ type: "map_status", ...state.mapStatus });
  }

  // Map cells for 3D visualization - broadcast to all browsers
  if (data.type === "map_cells") {
    // Broadcast directly to all browsers for 3D rendering
    state.broadcast({
      type: "map_cells",
      resolution: data.resolution || 0.05,
      static: data.static || [],
      dynamic: data.dynamic || [],
      free: data.free || []
    });
  }

  // Visual mapping commands - forward between browser and Jetson
  if (data.type === "visual_scan_start" || data.type === "visual_scan_stop" ||
      data.type === "visual_map_request" || data.type === "recognize_scene") {
    // Forward to autonomous Jetson
    wss.clients.forEach(client => {
      if (client.isAutonomous && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
    console.log(`[VISUAL] Forwarding ${data.type} to Jetson`);
  }

  // Visual mapping results from Jetson - broadcast to browsers
  if (data.type === "visual_scan_progress" || data.type === "visual_scan_complete" ||
      data.type === "visual_map_data" || data.type === "scene_recognition_result") {
    state.broadcast(data);
    console.log(`[VISUAL] Broadcasting ${data.type} to browsers`);
  }

  // ==================== SEMANTIC MAP COMMANDS ====================
  // Forward semantic map commands from browser to Jetson
  const semanticCommands = [
    "create_zone", "delete_zone", "update_zone",
    "rename_object", "mark_object_static",
    "look_at", "look_at_coords",
    "semantic_map_request", "lookable_targets_request",
    "find_location", "create_zone_here"
  ];
  if (semanticCommands.includes(data.type)) {
    wss.clients.forEach(client => {
      if (client.isAutonomous && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
    console.log(`[SEMANTIC] Forwarding ${data.type} to Jetson`);
  }

  // Semantic map results from Jetson - broadcast to browsers
  const semanticResults = [
    "semantic_map_data", "lookable_targets",
    "zone_created", "semantic_zone_created", "semantic_zone_deleted",
    "look_at_result", "location_found"
  ];
  if (semanticResults.includes(data.type)) {
    state.broadcast(data);
    console.log(`[SEMANTIC] Broadcasting ${data.type} to browsers`);
  }

  // ==================== PTZ SCAN COORDINATION ====================
  // Relay "ready_for_scan" from Jetson autonomous.py to Mac processor
  // This triggers PTZ camera sweeps when robot stops between movements
  if (data.type === "ready_for_scan") {
    console.log(`[PTZ SCAN] Robot ready at (${data.robot_x?.toFixed(0)}, ${data.robot_y?.toFixed(0)}) heading ${data.robot_heading?.toFixed(0)}°`);

    // Relay to all connected Mac processors
    let procCount = 0;
    wss.clients.forEach(client => {
      if (client.isProcessor && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
        procCount++;
      }
    });

    // Also broadcast to browsers for status display
    state.broadcast({
      type: "ptz_scan_started",
      robot_x: data.robot_x,
      robot_y: data.robot_y,
      robot_heading: data.robot_heading,
      timestamp: data.timestamp
    });

    console.log(`[PTZ SCAN] Relayed to ${procCount} processor(s)`);
  }

  // ==================== MAC MINI PROCESSOR ====================
  // Register Mac Mini as a processor
  if (data.type === "register_processor") {
    ws.isProcessor = true;
    ws.processorName = data.name || "mac-processor";
    console.log(`[PROCESSOR] ${ws.processorName} connected`);
    state.broadcast({ type: "processor_status", connected: true, name: ws.processorName });

    // If this is the GPU renderer, capture its IP for stream proxying
    if (data.name === "gpu-renderer" && data.capabilities && data.capabilities.includes("video_stream")) {
      // Get the client IP
      const clientIP = ws._socket?.remoteAddress?.replace('::ffff:', '') || null;
      if (clientIP && clientIP !== '127.0.0.1') {
        gpuRendererIP = clientIP;
        console.log(`[GPU-RENDERER] Stream available at http://${gpuRendererIP}:8089/stream.mjpg`);
      }
    }
  }

  // Accumulated map from Mac Mini - broadcast to browsers for visualization
  // New format: points with {x, y, z, r, g, b, c(confidence)} for textured 3D point cloud
  // Accept from ANY connected client sending accumulated_map (auto-register as processor)
  if (data.type === "accumulated_map") {
    // Auto-register as processor if not already
    if (!ws.isProcessor) {
      ws.isProcessor = true;
      ws.processorName = "mac-auto-registered";
      console.log("[PROCESSOR] Auto-registered processor from accumulated_map");
      state.broadcast({ type: "processor_status", connected: true, name: ws.processorName });
    }
    const pointCount = data.total || (data.points ? data.points.length : 0);
    const stats = data.stats || {};
    // Store latest accumulated map
    state.accumulatedMap = {
      points: data.points || [],
      pointCount: pointCount,
      stats: stats,
      updated: Date.now()
    };
    // Broadcast to all browsers (include stats for display)
    state.broadcast({
      type: "accumulated_map",
      points: data.points,
      total: pointCount,
      stats: stats
    }, ws);
    // Log occasionally
    if (Math.random() < 0.1) {
      console.log(`[3D MAP] ${pointCount} pts | lidar=${stats.lidar_points||0} mono=${stats.mono_points||0} stereo=${stats.stereo_points||0} | scale=${stats.depth_scale||'?'}`);
    }
  }

  // Clear 3D map command from browser -> Mac processor
  if (data.type === "clear_3d_map") {
    wss.clients.forEach(client => {
      if (client.isProcessor && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "clear_3d_map" }));
      }
    });
    console.log("[3D MAP] Clear command sent to processor");
  }

  // Mapping status from Mac processor -> broadcast to browsers
  if (data.type === "mapping_status" && ws.isProcessor) {
    console.log(`[MAPPING] Mac mapper status: active=${data.active}, msg=${data.message}`);
    state.broadcast({
      type: "mapping_status",
      active: data.active,
      message: data.message,
      processor: ws.processorName
    });
  }

  // Frame history from Mac Mini - broadcast to browsers
  if (data.type === "frame_history" && ws.isProcessor) {
    state.broadcast({
      type: "frame_history",
      frames: data.frames || []
    }, ws);
  }

  // Semantic layout from semantic mapper - walls, doorways, objects
  if (data.type === "semantic_layout" && ws.isProcessor) {
    const layout = data.layout || {};
    const stats = data.stats || {};
    state.semanticLayout = { layout, stats, updated: Date.now() };
    state.broadcast({
      type: "semantic_layout",
      layout: layout,
      stats: stats
    }, ws);
    if (Math.random() < 0.2) {
      console.log(`[SEMANTIC] ${stats.planes||0} planes, ${stats.doorways||0} doorways, ${stats.objects||0} objects`);
    }
  }

  // Depth frame from Mac Mini - colorized depth estimation
  if (data.type === "depth_frame" && ws.isProcessor) {
    // Broadcast depth frame to all browsers
    state.broadcast({
      type: "depth_frame",
      camera: data.camera,
      frame: data.frame,  // base64 JPEG
      pose: data.pose,
      timestamp: data.timestamp
    }, ws);
    // Log occasionally
    if (Math.random() < 0.05) {
      console.log(`[DEPTH] Cam ${data.camera} depth frame from ${ws.processorName}`);
    }
  }

  // Status request
  if (data.type === "get_status") {
    ws.isBrowser = true;
    ws.send(JSON.stringify({ type: "status", ...state.robotStatus, camera: state.cameraStatus, teensyConnected: state.teensyStatus.connected }));
    ws.send(JSON.stringify({ type: "camera_streams", cameras: state.perCameraStatus }));
    // Send saved fingerprints to browser
    ws.send(JSON.stringify({ type: "saved_fingerprints", fingerprints: savedFingerprints }));
  }

  // ============ FINGERPRINT & MAP PERSISTENCE ============
  // Save fingerprint from browser
  if (data.type === "save_fingerprint") {
    if (saveFingerprint(data.fingerprint)) {
      ws.send(JSON.stringify({ type: "fingerprint_saved", name: data.fingerprint.name }));
    }
  }

  // Save 3D map from browser/processor
  if (data.type === "save_3d_map") {
    if (save3DMap(data.name, data.mapData)) {
      ws.send(JSON.stringify({ type: "map_saved", name: data.name }));
    }
  }

  // Load 3D map (when area recognized)
  if (data.type === "load_3d_map") {
    const mapData = load3DMap(data.name);
    if (mapData) {
      ws.send(JSON.stringify({ type: "loaded_3d_map", name: data.name, mapData: mapData }));
      console.log(`[3D MAP] Loaded for browser: ${data.name}`);
    } else {
      ws.send(JSON.stringify({ type: "load_3d_map_failed", name: data.name }));
    }
  }

  // Request all fingerprints
  if (data.type === "get_fingerprints") {
    ws.send(JSON.stringify({ type: "saved_fingerprints", fingerprints: savedFingerprints }));
  }

  // Audio mute
  if (data.type === "audio_mute") {
    ws.audioMuted = data.muted;
  }

  // Odometry reset
  if (data.type === "reset_odometry") {
    odometry.resetOdometry();
  }

  // AUTO-RELOCALIZATION: Browser detected position via fingerprint match
  if (data.type === "relocalize") {
    const newX = data.x || 0;
    const newY = data.y || 0;
    const confidence = data.confidence || 0;
    const source = data.source || "unknown";
    const areaName = data.areaName || "unknown";

    console.log(`[RELOCALIZE] Position correction from ${source}: (${newX.toFixed(0)}, ${newY.toFixed(0)}) confidence=${(confidence*100).toFixed(0)}% area=${areaName}`);

    // Update server's odometry state
    odometry.setPosition(newX, newY);

    // Broadcast to all clients so everyone syncs
    state.broadcast({
      type: "relocalization",
      x: newX,
      y: newY,
      confidence: confidence,
      source: source,
      areaName: areaName,
      timestamp: Date.now()
    });

    // Also notify Mac mapper to align its map
    broadcastToProcessors({
      type: "relocalization",
      x: newX,
      y: newY,
      confidence: confidence,
      source: source
    });
  }

  // Camera relay messages
  if (data.type === "camera_hello") {
    state.setCameraSocket(ws);
    ws.isCamera = true;
    ws.isBrowser = false;
    ws.isJetsonRelay = (data.source === 'jetson');  // Mark as Jetson relay for detection settings
    state.cameraStatus.connected = true;
    state.cameraStatus.ip = data.ip || "unknown";
    state.broadcast({ type: "camera_status", ...state.cameraStatus });
    console.log("[CAMERA] Relay connected, source:", data.source || "unknown");
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

  // Handle compass auto-calibration status
  if (data.data && data.data.startsWith("COMPASS_CAL,")) {
    const parts = data.data.split(",");
    const status = parts[1];  // SAVED, COMPLETE, STARTED
    console.log(`[COMPASS] Calibration: ${status}`);
    state.broadcast({ type: "compass_cal", status: status });
  }

  // Handle compass data: COMPASS,heading,x,y,z
  if (data.data && data.data.startsWith("COMPASS,")) {
    const parts = data.data.split(",");
    if (parts.length >= 5) {
      const heading = parseFloat(parts[1]);
      console.log(`[COMPASS] Heading: ${heading.toFixed(1)}°`);
      state.broadcast({ type: "compass", heading: heading, x: parseInt(parts[2]), y: parseInt(parts[3]), z: parseInt(parts[4]) });
    }
  }

  // Handle I2C scan results
  if (data.data && data.data.startsWith("I2C_SCAN,")) {
    console.log(`[I2C] ${data.data}`);
    state.broadcast({ type: "i2c_scan", data: data.data });
  }

  // Handle SAFETY messages for autonomous obstacle avoidance
  if (data.data && data.data.startsWith("SAFETY,")) {
    const parts = data.data.split(",");
    const safetyType = parts[1];
    console.log(`[SAFETY] ${safetyType}`);

    // If we're in autonomous mode and hit an obstacle, change direction
    if (global.autoInterval) {
      if (safetyType === "OBSTACLE_FRONT") {
        // Back up, then turn
        console.log(`[AUTONOMOUS] Front obstacle - backing up and turning`);
        global.autoDirection = "REV";
        // After 1.5 seconds of reversing, turn left
        setTimeout(() => {
          if (global.autoInterval) {
            global.autoDirection = "LEFT";
            console.log(`[AUTONOMOUS] Turning left`);
            // After 1 second of turning, go forward again
            setTimeout(() => {
              if (global.autoInterval) {
                global.autoDirection = "FWD";
                console.log(`[AUTONOMOUS] Resuming forward`);
              }
            }, 1000);
          }
        }, 1500);
      } else if (safetyType === "OBSTACLE_REAR") {
        // Go forward and turn
        console.log(`[AUTONOMOUS] Rear obstacle - going forward`);
        global.autoDirection = "FWD";
      } else if (safetyType === "CLEAR") {
        // Obstacle cleared, resume forward
        if (global.autoDirection !== "FWD") {
          console.log(`[AUTONOMOUS] Obstacle cleared - resuming forward`);
          global.autoDirection = "FWD";
        }
      }
    }
    state.broadcast({ type: "safety", status: safetyType, distance: parts[2] || 0 });
  }

  // Handle GPS data: GPS,valid,lat,lon,sats,lastLat,lastLon
  if (data.data && data.data.startsWith("GPS,")) {
    const parts = data.data.split(",");
    if (parts.length >= 5) {
      const valid = parts[1] === "1";
      const lat = parseFloat(parts[2]);
      const lon = parseFloat(parts[3]);
      const sats = parseInt(parts[4]);
      if (valid && lat !== 0 && lon !== 0) {
        console.log(`[GPS] ${lat.toFixed(6)}, ${lon.toFixed(6)} (${sats} sats)`);
      }
      state.broadcast({ type: "gps", valid: valid, lat: lat, lon: lon, sats: sats });
    }
  }

  // Parse SONAR messages for ultrasonic sensor data
  if (data.data && data.data.startsWith("SONAR,")) {
    const parts = data.data.split(",");
    if (parts.length >= 5) {
      const sonarData = {
        type: "ultrasonic",
        fl: parseFloat(parts[1]) || 0,
        fr: parseFloat(parts[2]) || 0,
        rl: parseFloat(parts[3]) || 0,
        rr: parseFloat(parts[4]) || 0,
        timestamp: Date.now()
      };
      state.broadcast(sonarData, ws);
      // Log occasionally for debugging
      if (Math.random() < 0.1) {
        console.log(`[SONAR] FL:${sonarData.fl} FR:${sonarData.fr} RL:${sonarData.rl} RR:${sonarData.rr} cm`);
      }
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

  // Handle PTZ commands from scanner (type: "ptz" with absolute positioning)
  if (data.type === "ptz") {
    console.log("[PTZ SCAN] Cam", data.camera, "action:", data.action, "pan:", data.pan, "tilt:", data.tilt);
    const ptzData = {
      type: "cam_ptz",
      camera: data.camera,
      action: data.action || "move",
      pan: data.pan || 0,
      tilt: data.tilt || 0,
      zoom: data.zoom || 0
    };
    if (ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
      ptzRelaySocket.send(JSON.stringify(ptzData));
      console.log("[PTZ SCAN] Forwarded to PTZ relay");
    }

    // Broadcast PTZ status to processors for 3D mapping
    state.broadcast({
      type: "ptz_status",
      camera: data.camera,
      pan: data.pan || 0,
      tilt: data.tilt || 0
    });
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

    let count = 0, dropped = 0, procCount = 0;
    wss.clients.forEach(c => {
      if (c !== ws && c.readyState === WebSocket.OPEN) {
        // Send to browsers
        if (c.isBrowser) {
          if (c.bufferedAmount > 0) { dropped++; return; }
          try { c.send(msg); count++; } catch (e) { }
        }
        // Also send to processors (Mac Mini) for hybrid map - higher rate for better mapping
        if (c.isProcessor && Math.random() < 0.5) { // 50% of frames to processor
          try { c.send(msg); procCount++; } catch (e) { }
        }
      }
    });

    if (Math.random() < 0.02) {
      console.log(`[CAM${cameraId}-VIDEO] Sent ${payload.length} bytes to ${count} browsers${dropped ? `, dropped ${dropped}` : ''}${procCount ? `, ${procCount} proc` : ''}`);
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
    const connectedMs = Date.now() - (ws.connectedAt || 0);
    console.log(`[ROBOT] ESP32 disconnected after ${connectedMs}ms, closeCode: ${ws.closeCode}, closeReason: ${ws.closeReason || 'none'}`);
    state.setRobotSocket(null);
    state.robotStatus.connected = false;
    state.robotStatus.wifi = "unknown";
    state.robotStatus.rssi = 0;
    state.robotStatus.ip = "unknown";
    state.robotStatus.version = "unknown";
    state.robotStatus.uptime = 0;
    state.robotStatus.controller = "none";
    state.broadcast({ type: "status", ...state.robotStatus, camera: state.cameraStatus });
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
    // Skip ping check for processor clients - GPU processing blocks their event loop
    if (ws.isProcessor) {
      return;
    }
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
