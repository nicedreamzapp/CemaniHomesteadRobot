// ============ COMPILE AND FLASH HANDLERS ============
// Code compilation and firmware flashing for Teensy

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const WebSocket = require("ws");
const state = require('./server-state');

// Compile setup paths
// Compile setup paths
const TEMP_DIR = path.join(__dirname, "temp-sketch");
const BUILD_DIR = path.join(TEMP_DIR, "build");
const ARDUINO_CLI = path.join(__dirname, "public/bin/arduino-cli");
const PREBUILT_HEX = path.join(__dirname, "prebuilt/teensy41.hex");

// Ensure directories exist
function ensureDirectories() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
}

// Handle code compilation
function handleCompile(target, code, clientWs) {
  console.log("[COMPILE] Starting for", target);
  ensureDirectories();

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

    const robotSocket = state.getRobotSocket();
    if (!robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "compile_error", error: "Robot not connected" }));
      return;
    }

    flashHexToRobot(hexData, robotSocket, clientWs, false);
  });
}

// Handle flashing pre-built hex file
function handleFlashPrebuilt(clientWs) {
  console.log("[FLASH] === FLASH PREBUILT REQUESTED ===");
  console.log("[FLASH] Looking for hex at:", PREBUILT_HEX);

  if (!fs.existsSync(PREBUILT_HEX)) {
    console.log("[FLASH] ERROR: Hex file not found!");
    clientWs.send(JSON.stringify({ type: "compile_error", error: "No pre-built hex found at " + PREBUILT_HEX }));
    return;
  }
  console.log("[FLASH] Hex file found!");

  const robotSocket = state.getRobotSocket();
  if (!robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: "compile_error", error: "Robot not connected" }));
    return;
  }

  const hexData = fs.readFileSync(PREBUILT_HEX, "utf8");
  console.log("[FLASH] Hex size:", hexData.length, "bytes");

  clientWs.send(JSON.stringify({ type: "compile_status", message: "Sending pre-built hex to robot..." }));
  flashHexToRobot(hexData, robotSocket, clientWs, true);
}

// Flash hex data to robot via WebSocket
function flashHexToRobot(hexData, robotSocket, clientWs, isPrebuilt) {
  robotSocket.send(JSON.stringify({ type: "flash_mode" }));

  setTimeout(() => {
    const hexLines = hexData.split("\n").filter(line => line.trim().length > 0);
    console.log("[FLASH] Sending", hexLines.length, "hex lines");

    let lineIndex = 0;
    const sendNextLine = () => {
      if (lineIndex >= hexLines.length) {
        // Send flash_complete to ESP32 so it knows we're done
        if (isPrebuilt) {
          robotSocket.send(JSON.stringify({ type: "flash_complete" }));
        }
        clientWs.send(JSON.stringify({ type: "compile_success", message: "Flashed " + hexLines.length + " lines!" }));
        console.log("[FLASH] Complete!");
        return;
      }

      robotSocket.send(JSON.stringify({ type: "hex_line", data: hexLines[lineIndex] }));
      lineIndex++;

      if (lineIndex % 100 === 0) {
        clientWs.send(JSON.stringify({ type: "compile_status", message: "Flashing... " + Math.round(lineIndex / hexLines.length * 100) + "%" }));
      }

      // 10ms delay between lines - gives serial buffer time to drain
      setTimeout(sendNextLine, 10);
    };
    sendNextLine();
  }, 2000);  // Wait 2s for Teensy to initialize flash buffer
}

module.exports = {
  handleCompile,
  handleFlashPrebuilt,
  ensureDirectories
};
