const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============ BASIC AUTH ============
// Load credentials from auth.json (kept out of git)
let authConfig = null;
try {
  authConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth.json'), 'utf8'));
  console.log('[AUTH] Basic authentication enabled');
} catch (e) {
  console.log('[AUTH] No auth.json found - running without authentication');
}

// Basic auth middleware
if (authConfig) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Robot Control"');
      return res.status(401).send('Authentication required');
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    if (user === authConfig.username && pass === authConfig.password) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Robot Control"');
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

// ============ ROBOT STATE ============
let robotSocket = null;
let robotStatus = {
  connected: false,
  version: "unknown",
  wifi: "unknown",
  rssi: 0,
  ip: "unknown",
  uptime: 0,
  controller: "none",
  lastSeen: null
};

// ============ TEENSY STATE ============
let teensyStatus = {
  connected: false,
  lastSeen: 0,
  version: "unknown"
};
const TEENSY_TIMEOUT_MS = 5000; // Mark as disconnected if no TELEM for 5 seconds

// ============ ODOMETRY STATE ============
// Robot physical parameters (8-inch wheels, ~55cm wheelbase)
const WHEEL_CIRCUMFERENCE_MM = 203.2 * Math.PI;  // ~638.4mm per wheel rotation
const WHEEL_BASE_MM = 550.0;  // Distance between wheels
const COUNTS_PER_REV = 4096;  // 1024 encoder lines * 4 (quadrature)
const MM_PER_COUNT = WHEEL_CIRCUMFERENCE_MM / COUNTS_PER_REV;  // ~0.156mm per count

let odometry = {
  // Raw encoder counts (from Teensy)
  posL: 0,
  posR: 0,
  // Previous counts for delta calculation
  prevPosL: 0,
  prevPosR: 0,
  // Calculated position (in mm from start)
  x: 0,
  y: 0,
  heading: 0,  // radians, 0 = facing forward (positive Y)
  // Trip stats
  tripStartTime: Date.now(),
  totalDistance: 0,  // mm traveled since start
  // Trail history for mini-map - start at origin (red dot)
  trail: [{ x: 0, y: 0 }]
};

// ============ CAMERA STATE ============
let cameraSocket = null;
let cameraStatus = {
  connected: false,
  ip: "unknown",
  streaming: false
};

// Per-camera streaming status with timeout detection
const perCameraStatus = {
  1: { streaming: false, lastFrame: 0 },
  2: { streaming: false, lastFrame: 0 },
  3: { streaming: false, lastFrame: 0 }  // V380 Light Bulb Camera
};
const CAMERA_TIMEOUT_MS = 3000; // Mark as not streaming if no frame for 3 seconds

// HLS output directory
const HLS_DIR = "/opt/robot-server/public/hls";
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ============ PRIORITY PTZ CONTROL SERVER (Port 3002) ============
// Separate WebSocket for PTZ commands - bypasses video traffic completely
const ptzServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PTZ Control Server - Priority channel for camera control');
});
const ptzWss = new WebSocket.Server({ server: ptzServer });

// Track PTZ relay connection (from Mac) and browser PTZ clients
let ptzRelaySocket = null;
let browserPtzClients = new Set();

ptzWss.on('connection', (ws, req) => {
  console.log('[PTZ-WS] Client connected from', req.socket.remoteAddress);

  // Enable TCP_NODELAY for instant PTZ response
  if (req.socket) {
    req.socket.setNoDelay(true);
  }

  ws.isAlive = true; ws.missedPings = 0;
  ws.on('pong', () => { ws.isAlive = true; ws.missedPings = 0; });

  ws.on('message', (msg) => {
    ws.isAlive = true; ws.missedPings = 0;
    try {
      const data = JSON.parse(msg.toString());
      console.log('[PTZ-WS] Received:', data.type);

      // Mac relay announcing itself on PTZ channel
      if (data.type === 'ptz_relay_hello') {
        ptzRelaySocket = ws;
        ws.isPtzRelay = true;
        console.log('[PTZ-WS] Mac PTZ relay connected');
        // Notify browsers
        browserPtzClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'ptz_relay_status', connected: true }));
          }
        });
        return;
      }

      // Browser announcing itself
      if (data.type === 'ptz_browser_hello') {
        ws.isBrowser = true;
        browserPtzClients.add(ws);
        console.log('[PTZ-WS] Browser connected, total:', browserPtzClients.size);
        ws.send(JSON.stringify({ type: 'ptz_relay_status', connected: !!ptzRelaySocket }));
        return;
      }

      // PTZ commands from browser -> forward to Mac relay INSTANTLY
      if (data.type === 'cam_ptz' && ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
        ptzRelaySocket.send(JSON.stringify(data));
        console.log('[PTZ-WS] CMD:', data.action, 'cam:', data.camera || 1);
        return;
      }

      // PTZ results from Mac relay -> forward to browsers
      if (data.type === 'cam_ptz_result' && ws.isPtzRelay) {
        browserPtzClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify(data));
          }
        });
        return;
      }

      // V380 music ended notification from Jetson -> forward to all browsers
      if (data.type === 'v380_music_ended' && ws.isPtzRelay) {
        console.log('[V380] Music ended, notifying browsers');
        // Broadcast to all main websocket clients
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'v380_music_ended' }));
          }
        });
        return;
      }

    } catch (err) {
      console.error('[PTZ-WS] Error:', err.message);
    }
  });

  ws.on('close', () => {
    if (ws.isPtzRelay) {
      ptzRelaySocket = null;
      console.log('[PTZ-WS] Mac PTZ relay disconnected');
      browserPtzClients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'ptz_relay_status', connected: false }));
        }
      });
    }
    if (ws.isBrowser) {
      browserPtzClients.delete(ws);
      console.log('[PTZ-WS] Browser disconnected, total:', browserPtzClients.size);
    }
  });

  ws.on('error', () => {
    browserPtzClients.delete(ws);
  });
});

// PTZ keepalive - faster interval for responsive control
setInterval(() => {
  ptzWss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.isPtzRelay) ptzRelaySocket = null;
      browserPtzClients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);  // 10 second ping for PTZ (faster than main)

ptzServer.listen(3002, '0.0.0.0', () => {
  console.log('[PTZ-SERVER] Priority PTZ control listening on port 3002');
});

// NOTE: Port 9999 camera stream server REMOVED - was unused and wasting resources
// Video now streams through main WebSocket on port 3001

// ============ COMPILE SETUP ============
const TEMP_DIR = "/opt/robot-server/temp-sketch";
const BUILD_DIR = path.join(TEMP_DIR, "build");
const ARDUINO_CLI = "/opt/robot-server/public/bin/arduino-cli";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

const PING_INTERVAL = 30000;

// ============ WEBSOCKET HANDLER ============
wss.on("connection", (ws, req) => {
  console.log("[WS] Client connected from", req.socket.remoteAddress);

  // Enable TCP_NODELAY for lower latency (disable Nagle's algorithm)
  if (req.socket) {
    req.socket.setNoDelay(true);
  }

  // CRITICAL: Track when this client connected - only send frames AFTER this time
  ws.connectedAt = Date.now();
  ws.frameCount = 0;

  ws.send(JSON.stringify({type: "status", ...robotStatus, camera: cameraStatus}));
  ws.isAlive = true; ws.missedPings = 0;
  ws.isBrowser = true;  // Assume browser until proven otherwise
  ws.on("pong", () => { ws.isAlive = true; ws.missedPings = 0; });

  ws.on("message", (msg, isBinary) => {
    // Mark alive on any message - camera sends video constantly
    ws.isAlive = true; ws.missedPings = 0;

    // Handle binary talkback audio from browser (0x10 = talkback for cam2)
    if (isBinary && ws.isBrowser) {
      const data = Buffer.from(msg);
      if (data.length > 1 && data[0] === 0x10) {
        // Forward talkback audio to camera relay
        if (cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
          cameraSocket.send(msg);
          if (Math.random() < 0.05) console.log('[TALKBACK] Forwarding', data.length, 'bytes to relay');
        }
        return;
      }
    }

    // Handle binary frames from camera relay
    // Packet types: Cam1: 0x00=video, 0x01=audio | Cam2: 0x02=video, 0x03=audio
    if (isBinary && ws.isCamera) {
      const data = Buffer.from(msg);
      if (data.length < 2) return;

      const packetType = data[0];
      const payload = data.slice(1);
      const cameraId = Math.floor(packetType / 2) + 1;  // 0,1 -> cam1, 2,3 -> cam2
      const isVideo = packetType % 2 === 0;

      if (isVideo) {
        // Video frame - track per-camera status
        cameraStatus.streaming = true;
        const frameTime = Date.now();
        if (perCameraStatus[cameraId]) {
          perCameraStatus[cameraId].streaming = true;
          perCameraStatus[cameraId].lastFrame = frameTime;
        }
        let count = 0;
        let dropped = 0;
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN && c.isBrowser) {
            // ZERO BUFFER: If socket has ANY pending data, skip this browser
            // They'll get the next frame instead - always live, never behind
            if (c.bufferedAmount > 0) {
              dropped++;
              return;
            }
            // Send frame
            try { c.send(msg); count++; } catch(e) {}
          }
        });
        if (Math.random() < 0.02) console.log(`[CAM${cameraId}-VIDEO] Sent`, payload.length, "bytes to", count, "browsers" + (dropped ? `, dropped ${dropped}` : ''));
      } else {
        // Audio chunk
        let count = 0;
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN && c.isBrowser && !c.audioMuted) {
            // Send with type marker so browser knows which camera
            try { c.send(msg); count++; } catch(e) {}
          }
        });
        if (Math.random() < 0.01) console.log(`[CAM${cameraId}-AUDIO] Sent`, payload.length, "bytes to", count, "browsers");
      }
      return;
    }

    try {
      // Log raw message if it looks like a PTZ command (for debugging)
      const msgStr = msg.toString();
      if (msgStr.includes('ptz') || msgStr.includes('PTZ')) {
        console.log("[RAW PTZ]", msgStr.substring(0, 150));
      }
      const data = JSON.parse(msg);
      console.log("[MSG]", data.type, JSON.stringify(data).substring(0, 100));

      // ============ ROBOT MESSAGES ============
      if(data.type === "robot_hello") {
        robotSocket = ws;
        ws.isRobot = true;
        ws.isBrowser = false;  // Not a browser
        robotStatus.connected = true;
        robotStatus.version = data.version || "unknown";
        robotStatus.wifi = data.wifi || "unknown";
        robotStatus.lastSeen = Date.now();
        broadcast({type:"status", ...robotStatus, camera: cameraStatus, teensyConnected: teensyStatus.connected});
        console.log("[ROBOT] ESP32 connected");
      }

      if(data.type === "telemetry") {
        if (!ws.isRobot) {
          robotSocket = ws;
          ws.isRobot = true;
          ws.isBrowser = false;
          console.log("[ROBOT] ESP32 connected via telemetry");
        }
        robotStatus.connected = true;
        robotStatus.version = data.version || robotStatus.version;
        robotStatus.wifi = data.wifi || robotStatus.wifi;
        robotStatus.rssi = data.rssi || 0;
        robotStatus.ip = data.ip || robotStatus.ip;
        robotStatus.uptime = data.uptime || 0;
        robotStatus.controller = data.controller || "none";
        robotStatus.lastSeen = Date.now();
        if (data.controller) {
          console.log("[CONTROLLER] Status:", data.controller, "-> robotStatus.controller:", robotStatus.controller);
        }
        const statusMsg = {type:"status", ...robotStatus, camera: cameraStatus, teensyConnected: teensyStatus.connected};
        console.log("[BROADCAST] controller in status:", statusMsg.controller);
        broadcast(statusMsg);
      }

      if(data.type === "serial" && ws.isRobot) {
        // Detect Teensy version message
        if (data.data && data.data.startsWith("TEENSY_VERSION,")) {
          const parts = data.data.split(",");
          if (parts.length >= 2) {
            teensyStatus.version = parts[1].trim();
            teensyStatus.connected = true;
            teensyStatus.lastSeen = Date.now();
            console.log(`[TEENSY] Version: ${teensyStatus.version}`);
            broadcast({type:"status", ...robotStatus, camera: cameraStatus, teensyConnected: teensyStatus.connected, teensyVersion: teensyStatus.version});
          }
        }

        // Detect Teensy TELEM messages to track Teensy connection
        // NEW Format: TELEM,battV,battPct,tempLF,tempLR,tempRF,tempRR,drvTemp1,drvTemp2,velL,velR,torqueL,torqueR,posL,posR
        if (data.data && data.data.startsWith("TELEM,")) {
          teensyStatus.connected = true;
          teensyStatus.lastSeen = Date.now();

          // Parse telemetry - now with 4 motor temps (LF, LR, RF, RR)
          // Format: TELEM,battV,battPct,tempLF,tempLR,tempRF,tempRR,drvTemp1,drvTemp2,velL,velR,torqueL,torqueR,posL,posR
          //         [0]   [1]   [2]     [3]    [4]    [5]    [6]    [7]      [8]      [9]  [10] [11]    [12]    [13] [14]
          const parts = data.data.split(",");
          if (parts.length >= 15) {
            // Get position from encoders (now at index 13 and 14)
            const posL = parseInt(parts[13]) || 0;
            const posR = parseInt(parts[14]) || 0;

            // Calculate deltas from previous encoder values
            const deltaL = posL - odometry.prevPosL;
            const deltaR = posR - odometry.prevPosR;

            // Filter out unrealistic jumps (noise, overflow, or first reading)
            // Max realistic delta: ~50cm per telemetry update (1 second at max speed)
            // At 638mm wheel circumference and 4096 counts/rev: 50cm = ~3200 counts
            const MAX_DELTA = 5000;  // ~75cm worth of encoder counts
            const deltaValid = Math.abs(deltaL) < MAX_DELTA && Math.abs(deltaR) < MAX_DELTA;

            // Only update if we have valid deltas (skip first reading or noise)
            if (deltaValid && (deltaL !== 0 || deltaR !== 0)) {
              // Convert to mm
              const distL = deltaL * MM_PER_COUNT;
              const distR = deltaR * MM_PER_COUNT;

              // Average distance moved
              const distAvg = (distL + distR) / 2;

              // Change in heading (positive = turning right)
              const deltaHeading = (distR - distL) / WHEEL_BASE_MM;

              // Update position using midpoint integration
              const newHeading = odometry.heading + deltaHeading / 2;
              odometry.x += distAvg * Math.sin(newHeading);
              odometry.y += distAvg * Math.cos(newHeading);
              odometry.heading += deltaHeading;

              // Keep heading in [-PI, PI]
              while (odometry.heading > Math.PI) odometry.heading -= 2 * Math.PI;
              while (odometry.heading < -Math.PI) odometry.heading += 2 * Math.PI;

              // Update total distance
              odometry.totalDistance += Math.abs(distAvg);

              // Add to trail more frequently for smoother lines (every ~5cm)
              const lastPoint = odometry.trail[odometry.trail.length - 1];
              const distFromLast = lastPoint
                ? Math.sqrt(Math.pow(odometry.x - lastPoint.x, 2) + Math.pow(odometry.y - lastPoint.y, 2))
                : Infinity;

              if (odometry.trail.length === 0 || distFromLast > 50) {  // 50mm = 5cm
                odometry.trail.push({ x: odometry.x, y: odometry.y });
                if (odometry.trail.length > 500) odometry.trail.shift();  // Keep more points
              }
            }

            // Always store previous values for delta calculation
            odometry.prevPosL = posL;
            odometry.prevPosR = posR;
            odometry.posL = posL;
            odometry.posR = posR;

            const telemData = {
              type: "teensy_telemetry",
              batteryV: parseFloat(parts[1]),
              batteryPct: parseInt(parts[2]),
              // 4 motor temps (all 4 wheels)
              motorTempLF_F: parseInt(parts[3]),
              motorTempLR_F: parseInt(parts[4]),
              motorTempRF_F: parseInt(parts[5]),
              motorTempRR_F: parseInt(parts[6]),
              // Legacy L/R averages for compatibility
              motorTempL_F: Math.round((parseInt(parts[3]) + parseInt(parts[4])) / 2),
              motorTempR_F: Math.round((parseInt(parts[5]) + parseInt(parts[6])) / 2),
              // Driver board temps
              driverTemp1_F: parseInt(parts[7]),
              driverTemp2_F: parseInt(parts[8]),
              velL: parseFloat(parts[9]),
              velR: parseFloat(parts[10]),
              torqueL: parseFloat(parts[11]),
              torqueR: parseFloat(parts[12]),
              // Position data
              posL: posL,
              posR: posR,
              // Odometry
              odomX: Math.round(odometry.x),
              odomY: Math.round(odometry.y),
              odomHeading: odometry.heading,
              odomHeadingDeg: Math.round(odometry.heading * 180 / Math.PI),
              odomDistance: Math.round(odometry.totalDistance),
              odomTrail: odometry.trail
            };
            broadcast(telemData, ws);
          }
        }
        broadcast({type:"serial", data:data.data}, ws);
      }

      if(data.type === "command") {
        console.log("[CMD] Received command:", data.data);
        if(robotSocket && robotSocket.readyState === WebSocket.OPEN) {
          robotSocket.send(JSON.stringify({type:"command", data:data.data}));
          console.log("[CMD] Forwarded to robot");
        } else {
          console.log("[CMD] Robot not connected, cannot forward");
        }
      }

      if(data.type === "joystick" && robotSocket && robotSocket.readyState === WebSocket.OPEN) {
        robotSocket.send(JSON.stringify({type:"joystick", lx:data.lx, ly:data.ly}));
      }

      // ============ DISCRETE MOVEMENT COMMANDS ============
      if(data.type === "move_command") {
        if (robotSocket && robotSocket.readyState === WebSocket.OPEN) {
          // Forward discrete movement command to ESP32
          robotSocket.send(JSON.stringify({
            type: "move_command",
            turn: data.turn || 0,
            distance: data.distance || 0,
            direction: data.direction || "N"
          }));
          console.log("[MOVE] Command:", data.direction, data.distance + "m", "turn:", data.turn + "°");
        } else {
          console.log("[MOVE] ERROR: Cannot forward - robotSocket not connected (socket:", robotSocket ? "exists" : "null", ")");
        }
      }

      if(data.type === "emergency_stop" && robotSocket && robotSocket.readyState === WebSocket.OPEN) {
        robotSocket.send(JSON.stringify({ type: "emergency_stop" }));
        console.log("[MOVE] EMERGENCY STOP");
      }

      if(data.type === "compile") {
        handleCompile(data.target, data.code, ws);
      }

      // Flash pre-built hex file (no compile needed)
      if(data.type === "flash_prebuilt") {
        handleFlashPrebuilt(ws);
      }

      if(data.type === "ping") {
        ws.send(JSON.stringify({type:"pong", timestamp: Date.now()}));
      }

      if(data.type === "get_status") {
        ws.isBrowser = true;  // Mark as browser client
        ws.send(JSON.stringify({type:"status", ...robotStatus, camera: cameraStatus, teensyConnected: teensyStatus.connected}));
        ws.send(JSON.stringify({type:"camera_streams", cameras: perCameraStatus}));
      }

      // Handle audio mute toggle from browser
      if(data.type === "audio_mute") {
        ws.audioMuted = data.muted;
        console.log("[AUDIO] Browser mute:", data.muted);
      }

      // Handle odometry reset
      if(data.type === "reset_odometry") {
        odometry.x = 0;
        odometry.y = 0;
        odometry.heading = 0;
        odometry.totalDistance = 0;
        odometry.trail = [{ x: 0, y: 0 }];  // Start with origin point (red dot)
        odometry.prevPosL = odometry.posL;
        odometry.prevPosR = odometry.posR;
        odometry.tripStartTime = Date.now();
        console.log("[ODOM] Odometry reset - starting at origin");
        // Broadcast the reset state immediately
        broadcast({
          type: "teensy_telemetry",
          odomX: 0,
          odomY: 0,
          odomHeading: 0,
          odomHeadingDeg: 0,
          odomDistance: 0,
          odomTrail: odometry.trail
        });
      }

      // ============ CAMERA RELAY MESSAGES ============
      if(data.type === "camera_hello") {
        cameraSocket = ws;
        ws.isCamera = true;
        ws.isBrowser = false;  // Not a browser
        cameraStatus.connected = true;
        cameraStatus.ip = data.ip || "unknown";
        broadcast({type:"camera_status", ...cameraStatus});
        console.log("[CAMERA] Relay connected, camera IP:", cameraStatus.ip);
      }

      // Forward PTZ results to browsers
      if(data.type === "cam_ptz_result" && ws.isCamera) {
        broadcast({type:"cam_ptz_result", ...data}, ws);
      }

      // Forward setting results to browsers
      if(data.type === "cam_setting_result" && ws.isCamera) {
        broadcast({type:"cam_setting_result", ...data}, ws);
      }

      // Forward snapshot to browsers
      if(data.type === "cam_snapshot_data" && ws.isCamera) {
        broadcast({type:"cam_snapshot_data", camera: data.camera, data: data.data}, ws);
      }

      // ============ CAMERA PTZ COMMANDS (from browser or ESP32) ============
      // Handle ptz_cmd from ESP32 (simpler format to avoid JSON issues)
      if(data.type === "ptz_cmd" && data.cmd) {
        console.log("[PTZ] Received ptz_cmd:", data.cmd);
        const parts = data.cmd.split(",");
        let ptzData = null;
        if(parts[0] === "PTZ_MOVE" && parts.length >= 4) {
          ptzData = {
            type: "cam_ptz",
            camera: parseInt(parts[1]),
            action: "move",
            pan: parseInt(parts[2]),
            tilt: parseInt(parts[3]),
            zoom: 0
          };
        } else if(parts[0] === "PTZ_STOP" && parts.length >= 2) {
          ptzData = {
            type: "cam_ptz",
            camera: parseInt(parts[1]),
            action: "stop"
          };
        }
        if(ptzData) {
          console.log("[PTZ] ptzData ready:", JSON.stringify(ptzData));
          // Use ptzRelaySocket (priority PTZ channel) instead of cameraSocket
          if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
            ptzRelaySocket.send(JSON.stringify(ptzData));
            console.log("[PTZ] Forwarded to PTZ relay:", ptzData.action, "cam", ptzData.camera);
          } else {
            console.log("[PTZ] ERROR: ptzRelaySocket not ready! socket:", !!ptzRelaySocket, "state:", ptzRelaySocket ? ptzRelaySocket.readyState : "null");
          }
        }
      }

      // Forward PTZ commands to PTZ relay (priority channel)
      if(data.type === "cam_ptz") {
        console.log("[PTZ] Received:", data.action, "from", ws.isRobot ? "ESP32" : "browser");
        if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
          ptzRelaySocket.send(JSON.stringify(data));
          console.log("[PTZ] Forwarded to PTZ relay");
        } else {
          console.log("[PTZ] ERROR: PTZ relay not connected!");
        }
      }

      // Forward camera settings to relay
      if(data.type === "cam_setting" && cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
        cameraSocket.send(JSON.stringify(data));
      }

      // Forward snapshot request to relay
      if(data.type === "cam_snapshot" && cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
        cameraSocket.send(JSON.stringify(data));
      }

      // Forward talkback start/stop to relay
      if((data.type === "talkback_start" || data.type === "talkback_stop") && cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
        cameraSocket.send(JSON.stringify(data));
        console.log('[TALKBACK]', data.type, 'camera:', data.camera);
      }

      // Forward V380 light control to PTZ relay (more reliable than main camera socket)
      if(data.type === "v380_light") {
        console.log('[V380-DEBUG] ptzRelaySocket exists:', !!ptzRelaySocket);
        if (ptzRelaySocket) {
          console.log('[V380-DEBUG] ptz readyState:', ptzRelaySocket.readyState, '(OPEN=1)');
        }
        if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
          const msg = JSON.stringify(data);
          console.log('[V380] Sending to ptzRelaySocket:', msg);
          ptzRelaySocket.send(msg);
          console.log('[V380] Sent light command via PTZ channel:', data.state);
        } else {
          console.log('[V380] Cannot send - ptzRelaySocket not ready');
        }
      }

      // Forward V380 music command to Jetson
      if(data.type === "v380_music") {
        console.log('[V380] Music command:', data.action);
        if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
          ptzRelaySocket.send(JSON.stringify(data));
          console.log('[V380] Sent music command via PTZ channel');
        }
      }

      // Forward V380 talk start/stop to Jetson
      if(data.type === "v380_talk_start" || data.type === "v380_talk_stop") {
        console.log('[V380] Talk command:', data.type);
        if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
          ptzRelaySocket.send(JSON.stringify(data));
        }
      }

      // Forward V380 talk audio to Jetson
      if(data.type === "v380_talk_audio") {
        console.log('[V380] Talk audio received:', data.audio ? data.audio.length : 0, 'chars base64');
        if(ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
          ptzRelaySocket.send(JSON.stringify(data));
          console.log('[V380] Talk audio forwarded to Jetson');
        }
      }

    } catch (err) {
      const rawMsg = typeof msg === 'string' ? msg : msg.toString();
      // Log failed PTZ messages in detail
      if (rawMsg.includes('ptz') || rawMsg.includes('PTZ') || rawMsg.includes('DPAD')) {
        console.error("[WS] PTZ Parse Error:", err.message, "RAW:", rawMsg.substring(0, 200));
      } else {
        console.error("[WS] Error:", err.message);
      }
    }
  });

  ws.on("close", () => {
    // Only clear robotSocket if THIS socket is the current robotSocket
    // Prevents old sockets from clearing new connections
    if(ws.isRobot && ws === robotSocket) {
      robotSocket = null;
      robotStatus.connected = false;
      // Clear all status info when disconnected - don't show stale data
      robotStatus.wifi = "unknown";
      robotStatus.rssi = 0;
      robotStatus.ip = "unknown";
      robotStatus.version = "unknown";
      robotStatus.uptime = 0;
      robotStatus.controller = "none";  // Xbox controller also disconnects with robot
      broadcast({type:"status", ...robotStatus, camera: cameraStatus});
      console.log("[ROBOT] ESP32 disconnected - controller status cleared");
    } else if (ws.isRobot) {
      console.log("[ROBOT] Old ESP32 socket closed (replaced by newer connection)");
    }
    // Only clear cameraSocket if THIS socket is the current cameraSocket
    if(ws.isCamera && ws === cameraSocket) {
      cameraSocket = null;
      cameraStatus.connected = false;
      cameraStatus.streaming = false;
      broadcast({type:"camera_status", ...cameraStatus});
      console.log("[CAMERA] Relay disconnected");
    }
  });
});

// ============ PING/PONG KEEPALIVE ============
// More tolerant: allow 3 missed pings before disconnect
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPings = (ws.missedPings || 0) + 1;
      if (ws.missedPings >= 3) {
        console.log("[PING] Client missed 3 pings, disconnecting");
        if (ws.isRobot) { robotSocket = null; robotStatus.connected = false; broadcast({type:"status", ...robotStatus, camera: cameraStatus}); }
        if (ws.isCamera) { cameraSocket = null; cameraStatus.connected = false; cameraStatus.streaming = false; broadcast({type:"camera_status", ...cameraStatus}); }
        return ws.terminate();
      }
    } else {
      ws.missedPings = 0;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

// ============ PER-CAMERA STREAMING TIMEOUT CHECK ============
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const camId of [1, 2]) {
    const cam = perCameraStatus[camId];
    const wasStreaming = cam.streaming;
    cam.streaming = (now - cam.lastFrame) < CAMERA_TIMEOUT_MS;
    if (wasStreaming !== cam.streaming) {
      changed = true;
      console.log(`[CAM${camId}] Streaming: ${cam.streaming}`);
    }
  }
  if (changed) {
    broadcast({type: "camera_streams", cameras: perCameraStatus});
  }

  // Check Teensy timeout
  const wasTeensyConnected = teensyStatus.connected;
  teensyStatus.connected = (now - teensyStatus.lastSeen) < TEENSY_TIMEOUT_MS;
  if (wasTeensyConnected !== teensyStatus.connected) {
    console.log(`[TEENSY] Connected: ${teensyStatus.connected}`);
    broadcast({type:"status", ...robotStatus, camera: cameraStatus, teensyConnected: teensyStatus.connected});
  }
}, 1000);

function broadcast(d, skip=null) {
  const msg = JSON.stringify(d);
  wss.clients.forEach(c => { if(c !== skip && c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ============ COMPILE HANDLER ============
function handleCompile(target, code, clientWs) {
  console.log("[COMPILE] Starting for", target);

  if (target !== "teensy") {
    clientWs.send(JSON.stringify({ type: "compile_error", error: "Only Teensy supported" }));
    return;
  }

  const sketchPath = path.join(TEMP_DIR, "temp-sketch.ino");
  fs.writeFileSync(sketchPath, code);

  const compileCmd = ARDUINO_CLI + " compile --fqbn teensy:avr:teensy41 --output-dir " + BUILD_DIR + " " + TEMP_DIR;

  clientWs.send(JSON.stringify({ type: "compile_status", message: "Compiling..." }));

  exec(compileCmd, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      clientWs.send(JSON.stringify({ type: "compile_error", error: stderr || error.message }));
      return;
    }

    const hexPath = path.join(BUILD_DIR, "temp-sketch.ino.hex");
    if (!fs.existsSync(hexPath)) {
      clientWs.send(JSON.stringify({ type: "compile_error", error: "Hex file not found at " + hexPath }));
      return;
    }

    const hexData = fs.readFileSync(hexPath, "utf8");
    console.log("[COMPILE] Success! Hex size:", hexData.length, "bytes");

    if (!robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "compile_error", error: "Robot not connected" }));
      return;
    }

    clientWs.send(JSON.stringify({ type: "compile_status", message: "Sending to robot..." }));
    robotSocket.send(JSON.stringify({ type: "flash_mode" }));

    setTimeout(() => {
      const hexLines = hexData.split("\n").filter(line => line.trim().length > 0);
      console.log("[FLASH] Sending", hexLines.length, "hex lines");

      let lineIndex = 0;
      const sendNextLine = () => {
        if (lineIndex >= hexLines.length) {
          clientWs.send(JSON.stringify({ type: "compile_success", message: "Flashed " + hexLines.length + " lines!" }));
          console.log("[FLASH] Complete!");
          return;
        }

        robotSocket.send(JSON.stringify({ type: "hex_line", data: hexLines[lineIndex] }));
        lineIndex++;

        if (lineIndex % 100 === 0) {
          clientWs.send(JSON.stringify({ type: "compile_status", message: "Flashing... " + Math.round(lineIndex/hexLines.length*100) + "%" }));
        }

        // 10ms delay between lines - gives serial buffer time to drain
        setTimeout(sendNextLine, 10);
      };
      sendNextLine();
    }, 2000);  // Wait 2s for Teensy to initialize flash buffer
  });
}

// ============ FLASH PREBUILT HEX ============
function handleFlashPrebuilt(clientWs) {
  console.log("[FLASH] === FLASH PREBUILT REQUESTED ===");

  // Use the prebuilt hex file
  const hexPath = "/root/vps-server/prebuilt/teensy41.hex";
  console.log("[FLASH] Looking for hex at:", hexPath);

  if (!fs.existsSync(hexPath)) {
    console.log("[FLASH] ERROR: Hex file not found!");
    clientWs.send(JSON.stringify({ type: "compile_error", error: "No pre-built hex found at " + hexPath }));
    return;
  }
  console.log("[FLASH] Hex file found!");

  if (!robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: "compile_error", error: "Robot not connected" }));
    return;
  }

  const hexData = fs.readFileSync(hexPath, "utf8");
  console.log("[FLASH] Hex size:", hexData.length, "bytes");

  clientWs.send(JSON.stringify({ type: "compile_status", message: "Sending pre-built hex to robot..." }));
  robotSocket.send(JSON.stringify({ type: "flash_mode" }));

  setTimeout(() => {
    const hexLines = hexData.split("\n").filter(line => line.trim().length > 0);
    console.log("[FLASH] Sending", hexLines.length, "hex lines");

    let lineIndex = 0;
    const sendNextLine = () => {
      if (lineIndex >= hexLines.length) {
        // Send flash_complete to ESP32 so it knows we're done
        robotSocket.send(JSON.stringify({ type: "flash_complete" }));
        clientWs.send(JSON.stringify({ type: "compile_success", message: "Flashed " + hexLines.length + " lines!" }));
        console.log("[FLASH] Complete!");
        return;
      }

      robotSocket.send(JSON.stringify({ type: "hex_line", data: hexLines[lineIndex] }));
      lineIndex++;

      if (lineIndex % 100 === 0) {
        clientWs.send(JSON.stringify({ type: "compile_status", message: "Flashing... " + Math.round(lineIndex/hexLines.length*100) + "%" }));
      }

      // 10ms delay between lines (was 5ms) - gives serial buffer time to drain
      setTimeout(sendNextLine, 10);
    };
    sendNextLine();
  }, 2000);  // Wait 2s for Teensy to initialize flash buffer (was 1s)
}

// ============ START SERVER ============
server.listen(3001, "0.0.0.0", () => {
  console.log("[SERVER] Running on port 3001");
  console.log("[SERVER] HLS directory:", HLS_DIR);
});
