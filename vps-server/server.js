const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Disable caching for HTML files
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
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
  lastSeen: null
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
  2: { streaming: false, lastFrame: 0 }
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

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (msg) => {
    ws.isAlive = true;
    try {
      const data = JSON.parse(msg.toString());

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
  ws.isAlive = true;
  ws.isBrowser = true;  // Assume browser until proven otherwise
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (msg, isBinary) => {
    // Mark alive on any message - camera sends video constantly
    ws.isAlive = true;

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
        broadcast({type:"status", ...robotStatus, camera: cameraStatus});
        console.log("[ROBOT] ESP32 connected");
      }

      if(data.type === "telemetry") {
        if (!ws.isRobot) { robotSocket = ws; ws.isRobot = true; ws.isBrowser = false; }
        robotStatus.connected = true;
        robotStatus.version = data.version || robotStatus.version;
        robotStatus.wifi = data.wifi || robotStatus.wifi;
        robotStatus.rssi = data.rssi || 0;
        robotStatus.ip = data.ip || robotStatus.ip;
        robotStatus.uptime = data.uptime || 0;
        robotStatus.lastSeen = Date.now();
        broadcast({type:"status", ...robotStatus, camera: cameraStatus});
      }

      if(data.type === "serial" && ws.isRobot) {
        broadcast({type:"serial", data:data.data}, ws);
      }

      if(data.type === "command" && robotSocket && robotSocket.readyState === WebSocket.OPEN) {
        robotSocket.send(JSON.stringify({type:"command", data:data.data}));
      }

      if(data.type === "joystick" && robotSocket && robotSocket.readyState === WebSocket.OPEN) {
        robotSocket.send(JSON.stringify({type:"joystick", lx:data.lx, ly:data.ly}));
      }

      if(data.type === "compile") {
        handleCompile(data.target, data.code, ws);
      }

      if(data.type === "ping") {
        ws.send(JSON.stringify({type:"pong", timestamp: Date.now()}));
      }

      if(data.type === "get_status") {
        ws.isBrowser = true;  // Mark as browser client
        ws.send(JSON.stringify({type:"status", ...robotStatus, camera: cameraStatus}));
        ws.send(JSON.stringify({type:"camera_streams", cameras: perCameraStatus}));
      }

      // Handle audio mute toggle from browser
      if(data.type === "audio_mute") {
        ws.audioMuted = data.muted;
        console.log("[AUDIO] Browser mute:", data.muted);
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

      // ============ BROWSER CAMERA COMMANDS ============
      // Forward PTZ commands to camera relay
      if(data.type === "cam_ptz" && cameraSocket && cameraSocket.readyState === WebSocket.OPEN) {
        cameraSocket.send(JSON.stringify(data));
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

    } catch (err) {
      console.error("[WS] Error:", err.message);
    }
  });

  ws.on("close", () => {
    if(ws.isRobot) {
      robotSocket = null;
      robotStatus.connected = false;
      // Clear all status info when disconnected - don't show stale data
      robotStatus.wifi = "unknown";
      robotStatus.rssi = 0;
      robotStatus.ip = "unknown";
      robotStatus.version = "unknown";
      robotStatus.uptime = 0;
      broadcast({type:"status", ...robotStatus, camera: cameraStatus});
      console.log("[ROBOT] ESP32 disconnected");
    }
    if(ws.isCamera) {
      cameraSocket = null;
      cameraStatus.connected = false;
      cameraStatus.streaming = false;
      broadcast({type:"camera_status", ...cameraStatus});
      console.log("[CAMERA] Relay disconnected");
    }
  });
});

// ============ PING/PONG KEEPALIVE ============
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.isRobot) { robotSocket = null; robotStatus.connected = false; broadcast({type:"status", ...robotStatus, camera: cameraStatus}); }
      if (ws.isCamera) { cameraSocket = null; cameraStatus.connected = false; cameraStatus.streaming = false; broadcast({type:"camera_status", ...cameraStatus}); }
      return ws.terminate();
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

        setTimeout(sendNextLine, 5);
      };
      sendNextLine();
    }, 1000);
  });
}

// ============ START SERVER ============
server.listen(3001, "0.0.0.0", () => {
  console.log("[SERVER] Running on port 3001");
  console.log("[SERVER] HLS directory:", HLS_DIR);
});
