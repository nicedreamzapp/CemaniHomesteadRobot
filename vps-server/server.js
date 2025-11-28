const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

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

const TEMP_DIR = "/opt/robot-server/temp-sketch";
const BUILD_DIR = path.join(TEMP_DIR, "build");
const ARDUINO_CLI = "/opt/robot-server/public/bin/arduino-cli";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

const PING_INTERVAL = 30000;

wss.on("connection", (ws, req) => {
  console.log("[WS] Client connected from", req.socket.remoteAddress);
  ws.send(JSON.stringify({type: "status", ...robotStatus}));
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg);
      console.log("[MSG]", data.type, JSON.stringify(data).substring(0, 100));

      if(data.type === "robot_hello") {
        robotSocket = ws;
        ws.isRobot = true;
        robotStatus.connected = true;
        robotStatus.version = data.version || "unknown";
        robotStatus.wifi = data.wifi || "unknown";
        robotStatus.lastSeen = Date.now();
        broadcast({type:"status", ...robotStatus});
        console.log("[ROBOT] ESP32 connected");
      }

      if(data.type === "telemetry") {
        if (!ws.isRobot) { robotSocket = ws; ws.isRobot = true; }
        robotStatus.connected = true;
        robotStatus.version = data.version || robotStatus.version;
        robotStatus.wifi = data.wifi || robotStatus.wifi;
        robotStatus.rssi = data.rssi || 0;
        robotStatus.ip = data.ip || robotStatus.ip;
        robotStatus.uptime = data.uptime || 0;
        robotStatus.lastSeen = Date.now();
        broadcast({type:"status", ...robotStatus});
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
        ws.send(JSON.stringify({type:"status", ...robotStatus}));
      }
    } catch (err) {
      console.error("[WS] Error:", err.message);
    }
  });

  ws.on("close", () => {
    if(ws.isRobot) {
      robotSocket = null;
      robotStatus.connected = false;
      broadcast({type:"status", ...robotStatus});
      console.log("[ROBOT] ESP32 disconnected");
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.isRobot) { robotSocket = null; robotStatus.connected = false; broadcast({type:"status", ...robotStatus}); }
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

function handleCompile(target, code, clientWs) {
  console.log("[COMPILE] Starting for", target);

  if (target !== "teensy") {
    clientWs.send(JSON.stringify({ type: "compile_error", error: "Only Teensy supported" }));
    return;
  }

  // Arduino-cli requires .ino filename to match directory name
  const sketchPath = path.join(TEMP_DIR, "temp-sketch.ino");
  fs.writeFileSync(sketchPath, code);

  const compileCmd = ARDUINO_CLI + " compile --fqbn teensy:avr:teensy41 --output-dir " + BUILD_DIR + " " + TEMP_DIR;

  clientWs.send(JSON.stringify({ type: "compile_status", message: "Compiling..." }));

  exec(compileCmd, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      clientWs.send(JSON.stringify({ type: "compile_error", error: stderr || error.message }));
      return;
    }

    // Hex filename matches the .ino filename
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

    // Send FLASH_MODE command first to trigger Teensy OTA mode
    robotSocket.send(JSON.stringify({ type: "flash_mode" }));

    // Wait for ESP32 to put Teensy in flash mode, then send hex
    setTimeout(() => {
      // Split hex into lines and send
      const hexLines = hexData.split("\n").filter(line => line.trim().length > 0);
      console.log("[FLASH] Sending", hexLines.length, "hex lines");

      let lineIndex = 0;
      const sendNextLine = () => {
        if (lineIndex >= hexLines.length) {
          clientWs.send(JSON.stringify({ type: "compile_success", message: "Flashed " + hexLines.length + " lines!" }));
          console.log("[FLASH] Complete!");
          return;
        }

        // Send hex line to ESP32 which forwards to Teensy Serial1
        robotSocket.send(JSON.stringify({ type: "hex_line", data: hexLines[lineIndex] }));

        lineIndex++;
        // Progress update every 100 lines
        if (lineIndex % 100 === 0) {
          clientWs.send(JSON.stringify({ type: "compile_status", message: "Flashing... " + Math.round(lineIndex/hexLines.length*100) + "%" }));
        }

        // Small delay between lines for reliable transfer
        setTimeout(sendNextLine, 5);
      };
      sendNextLine();
    }, 1000);  // Give ESP32 time to enter flash mode
  });
}

server.listen(3001, "0.0.0.0", () => {
  console.log("[SERVER] Running on port 3001");
});
