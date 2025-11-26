const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

let robotSocket = null;

// Ensure temp directories exist
const TEMP_DIR = '/opt/robot-server/temp-sketch';
const BUILD_DIR = path.join(TEMP_DIR, 'build');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected');

  ws.on('message', msg => {
    const data = JSON.parse(msg);

    // Robot identification
    if(data.type === 'robot_hello') {
      robotSocket = ws;
      ws.isRobot = true;
      broadcast({type:'status', connected:true});
      console.log('[ROBOT] ESP32 connected');
    }

    // Serial data from robot
    if(data.type === 'serial' && ws.isRobot) {
      broadcast({type:'serial', data:data.data}, ws);
    }

    // Command to robot
    if(data.type === 'command' && robotSocket) {
      robotSocket.send(JSON.stringify({type:'command', data:data.data}));
      console.log('[CMD] Sent to robot:', data.data);
    }

    // Joystick data
    if(data.type === 'joystick' && robotSocket) {
      robotSocket.send(JSON.stringify({type:'joystick', lx:data.lx, ly:data.ly}));
    }

    // Compilation request
    if(data.type === 'compile') {
      handleCompile(data.target, data.code, ws);
    }
  });

  ws.on('close', () => {
    if(ws.isRobot) {
      robotSocket = null;
      broadcast({type:'status', connected:false});
      console.log('[ROBOT] ESP32 disconnected');
    }
  });
});

function broadcast(d, skip=null) {
  wss.clients.forEach(c => {
    if(c !== skip && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(d));
    }
  });
}

function handleCompile(target, code, clientWs) {
  console.log(`[COMPILE] Starting compilation for ${target}...`);

  if (target !== 'teensy') {
    clientWs.send(JSON.stringify({
      type: 'compile_error',
      error: `Compilation for ${target} not yet implemented`
    }));
    return;
  }

  // Step 1: Write code to sketch.ino
  const sketchPath = path.join(TEMP_DIR, 'sketch.ino');
  try {
    fs.writeFileSync(sketchPath, code);
    console.log('[COMPILE] Code written to', sketchPath);
  } catch (err) {
    console.error('[COMPILE] Failed to write sketch:', err);
    clientWs.send(JSON.stringify({
      type: 'compile_error',
      error: 'Failed to write sketch file: ' + err.message
    }));
    return;
  }

  // Step 2: Compile using Arduino CLI
  const compileCmd = `arduino-cli compile --fqbn teensy:avr:teensy41 --output-dir ${BUILD_DIR} ${TEMP_DIR}`;

  clientWs.send(JSON.stringify({
    type: 'compile_status',
    message: 'Compiling Teensy sketch...'
  }));

  exec(compileCmd, (error, stdout, stderr) => {
    if (error) {
      console.error('[COMPILE] Compilation failed:', stderr);
      clientWs.send(JSON.stringify({
        type: 'compile_error',
        error: stderr || error.message
      }));
      return;
    }

    console.log('[COMPILE] Success:', stdout);

    // Step 3: Read the .hex file
    const hexPath = path.join(BUILD_DIR, 'sketch.ino.hex');

    if (!fs.existsSync(hexPath)) {
      console.error('[COMPILE] .hex file not found at', hexPath);
      clientWs.send(JSON.stringify({
        type: 'compile_error',
        error: '.hex file not generated. Check build output.'
      }));
      return;
    }

    let hexData;
    try {
      hexData = fs.readFileSync(hexPath, 'utf8');
      console.log(`[COMPILE] Read .hex file (${hexData.length} bytes)`);
    } catch (err) {
      console.error('[COMPILE] Failed to read .hex:', err);
      clientWs.send(JSON.stringify({
        type: 'compile_error',
        error: 'Failed to read compiled .hex file: ' + err.message
      }));
      return;
    }

    // Step 4: Send .hex to ESP32
    if (!robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
      console.error('[COMPILE] Robot not connected');
      clientWs.send(JSON.stringify({
        type: 'compile_error',
        error: 'Robot (ESP32) is not connected. Cannot flash Teensy wirelessly.'
      }));
      return;
    }

    robotSocket.send(JSON.stringify({
      type: 'flash_teensy',
      hex: hexData
    }));

    console.log('[COMPILE] Sent .hex to ESP32 for wireless flashing');

    clientWs.send(JSON.stringify({
      type: 'compile_success',
      message: 'Compilation successful! Flashing Teensy wirelessly...',
      hexSize: hexData.length
    }));

    broadcast({
      type: 'serial',
      data: `[COMPILE] ✅ Success! Flashing ${hexData.length} bytes to Teensy...`
    });
  });
}

server.listen(3001, '0.0.0.0', () => {
  console.log('[SERVER] Robot server running on port 3001');
  console.log('[SERVER] Temp directory:', TEMP_DIR);
});
