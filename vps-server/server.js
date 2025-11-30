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

// HLS output directory
const HLS_DIR = "/opt/robot-server/public/hls";
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// ============ CAMERA STREAM SERVER (WebSocket-based, resize-safe) ============
// Receives frames from Mac relay via main WS, broadcasts to browser clients via dedicated WS
let currentFrame = null;
let browserCamClients = new Set();

const streamServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Camera stream server - connect via WebSocket at /cam1/ws');
});

// WebSocket server for browser camera clients
const camWss = new WebSocket.Server({ server: streamServer, path: '/cam1/ws' });

camWss.on('connection', (ws) => {
  console.log('[CAM-WS] Browser connected');
  browserCamClients.add(ws);

  // Send current frame immediately if available
  if (currentFrame) {
    try { ws.send(currentFrame); } catch(e) {}
  }

  ws.on('close', () => {
    console.log('[CAM-WS] Browser disconnected');
    browserCamClients.delete(ws);
  });

  ws.on('error', () => {
    browserCamClients.delete(ws);
  });
});

// Broadcast frame to all browser clients
function broadcastFrame(frame) {
  currentFrame = frame;
  browserCamClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(frame); } catch(e) { browserCamClients.delete(client); }
    }
  });
}

streamServer.listen(9999, '0.0.0.0', () => {
  console.log('[STREAM] Camera WebSocket server listening on port 9999');
});

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
  ws.send(JSON.stringify({type: "status", ...robotStatus, camera: cameraStatus}));
  ws.isAlive = true;
  ws.isBrowser = true;  // Assume browser until proven otherwise
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (msg, isBinary) => {
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
        // Video frame
        cameraStatus.streaming = true;
        let count = 0;
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN && c.isBrowser) {
            // Send with type marker so browser knows which camera
            try { c.send(msg); count++; } catch(e) {}
          }
        });
        if (Math.random() < 0.02) console.log(`[CAM${cameraId}-VIDEO] Sent`, payload.length, "bytes to", count, "browsers");
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

    } catch (err) {
      console.error("[WS] Error:", err.message);
    }
  });

  ws.on("close", () => {
    if(ws.isRobot) {
      robotSocket = null;
      robotStatus.connected = false;
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
