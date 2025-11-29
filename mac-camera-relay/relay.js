/**
 * Mac Camera Relay - Bridges local Sricam to VPS
 *
 * This runs on your Mac Mini and:
 * 1. Connects to VPS via WebSocket (like your robot does)
 * 2. Streams video from camera to VPS via FFmpeg
 * 3. Receives PTZ commands from VPS and sends to camera
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Full paths for launchd compatibility
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const CURL = '/usr/bin/curl';

// ============ CONFIGURATION ============
// Load config from config.json (keeps secrets out of git)
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('ERROR: config.json not found! Copy config.example.json to config.json and fill in your settings.');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ============ VPS CONNECTION ============
let vpsSocket = null;
let ffmpegProcess = null;
let reconnectTimer = null;

function connectToVPS() {
  if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) return;

  console.log('[VPS] Connecting to', CONFIG.vps.wsUrl);

  try {
    vpsSocket = new WebSocket(CONFIG.vps.wsUrl);
  } catch (err) {
    console.error('[VPS] Connection error:', err.message);
    scheduleReconnect();
    return;
  }

  vpsSocket.on('open', () => {
    console.log('[VPS] Connected!');

    // Announce as camera relay (like robot sends robot_hello)
    vpsSocket.send(JSON.stringify({
      type: 'camera_hello',
      camera: 1,
      ip: CONFIG.camera.ip
    }));

    // Start streaming
    startStreaming();
  });

  vpsSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle PTZ commands from VPS
      if (msg.type === 'cam_ptz') {
        await handlePTZ(msg);
      }

      // Handle camera settings
      if (msg.type === 'cam_setting') {
        await handleSetting(msg);
      }

      // Handle snapshot request
      if (msg.type === 'cam_snapshot') {
        await sendSnapshot();
      }

    } catch (err) {
      console.error('[VPS] Message error:', err.message);
    }
  });

  vpsSocket.on('close', () => {
    console.log('[VPS] Disconnected');
    vpsSocket = null;
    stopStreaming();
    scheduleReconnect();
  });

  vpsSocket.on('error', (err) => {
    console.error('[VPS] Error:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[VPS] Reconnecting in 5 seconds...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToVPS();
  }, 5000);
}

// ============ VIDEO STREAMING VIA FFMPEG ============
let frameStats = { sent: 0, dropped: 0, avgSize: 0, lastFps: 0 };

function startStreaming() {
  if (ffmpegProcess) {
    console.log('[STREAM] Already running');
    return;
  }

  // Use same simple URL that works with ffplay
  const rtspUrl = `rtsp://${CONFIG.camera.ip}:${CONFIG.camera.rtspPort}${CONFIG.camera.rtspPath}`;
  console.log(`[STREAM] Starting FFmpeg RTSP capture at ${CONFIG.stream.fps}fps`);
  console.log(`[STREAM] RTSP URL: ${rtspUrl}`);

  // FFmpeg: capture RTSP, scale down, output smaller MJPEG frames
  const quality = Math.round(31 - (CONFIG.stream.quality / 100 * 29)); // 50% = q:v 16
  ffmpegProcess = spawn(FFMPEG, [
    '-i', rtspUrl,                   // Input RTSP stream
    '-vf', `scale=${CONFIG.stream.scale}`, // Scale down to 640x360
    '-f', 'image2pipe',              // Output as image pipe
    '-vcodec', 'mjpeg',              // Output codec
    '-q:v', String(quality),         // Quality (2=best, 31=worst)
    '-r', String(CONFIG.stream.fps), // Frame rate
    '-'                              // Output to stdout
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let frameBuffer = Buffer.alloc(0);
  const JPEG_START = Buffer.from([0xFF, 0xD8]);
  const JPEG_END = Buffer.from([0xFF, 0xD9]);

  ffmpegProcess.stdout.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    // Find complete JPEG frames
    while (true) {
      const startIdx = frameBuffer.indexOf(JPEG_START);
      if (startIdx === -1) break;

      const endIdx = frameBuffer.indexOf(JPEG_END, startIdx);
      if (endIdx === -1) break;

      // Extract complete frame
      const frame = frameBuffer.slice(startIdx, endIdx + 2);
      frameBuffer = frameBuffer.slice(endIdx + 2);

      // Send frame
      frameStats.sent++;
      frameStats.avgSize = Math.round((frameStats.avgSize * 0.9) + (frame.length * 0.1));

      if (CONFIG.stream.useWebSocket && vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        vpsSocket.send(frame);
      }
    }

    // Prevent buffer from growing too large
    if (frameBuffer.length > 500000) {
      frameBuffer = Buffer.alloc(0);
    }
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    // Only log important messages
    if (msg.includes('Error') || msg.includes('error')) {
      console.log('[FFMPEG]', msg.trim());
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[FFMPEG] Exited with code ${code}, will restart in 3 seconds...`);
    ffmpegProcess = null;
    // Always restart FFmpeg - it will wait for VPS connection inside startStreaming
    setTimeout(() => {
      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        startStreaming();
      } else {
        console.log('[FFMPEG] VPS not connected, waiting...');
      }
    }, 3000);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[FFMPEG] Process error:', err.message);
    ffmpegProcess = null;
    setTimeout(startStreaming, 3000);
  });

  // Log stats every 5 seconds
  setInterval(() => {
    if (frameStats.sent > 0) {
      console.log(`[STREAM] FPS: ${Math.round(frameStats.sent/5)}, Avg size: ${Math.round(frameStats.avgSize/1024)}KB`);
      frameStats.lastFps = Math.round(frameStats.sent/5);
      frameStats.sent = 0;
    }
  }, 5000);
}

function stopStreaming() {
  if (ffmpegProcess) {
    console.log('[STREAM] Stopping FFmpeg...');
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }
}

// ============ ONVIF PTZ CONTROL ============
function sendOnvif(body, isStop = false) {
  return new Promise((resolve) => {
    const cleanBody = body.replace(/\s+/g, ' ').trim();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${CONFIG.camera.username}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${CONFIG.camera.password}</Password></UsernameToken></Security></s:Header><s:Body>${cleanBody}</s:Body></s:Envelope>`;

    const curl = spawn(CURL, [
      '-s',
      '--connect-timeout', '3',
      '-X', 'POST',
      '-H', 'Content-Type: application/soap+xml; charset=utf-8',
      '-d', xml,
      `http://${CONFIG.camera.ip}:${CONFIG.camera.onvifPort}/onvif/ptz_service`
    ]);

    let stdout = '';
    curl.stdout.on('data', (data) => { stdout += data.toString(); });

    curl.on('close', (code) => {
      const success = stdout.includes('Response') || code === 52;
      console.log('[ONVIF]', isStop ? 'STOP' : 'MOVE', success ? 'OK' : 'FAILED');
      resolve({ success });
    });

    curl.on('error', (err) => {
      console.error('[ONVIF] Error:', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

async function handlePTZ(msg) {
  console.log('[PTZ]', msg.action);

  let body = '';
  let isStop = false;

  switch (msg.action) {
    case 'move':
      body = `<tptz:ContinuousMove>
        <tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>
        <tptz:Velocity>
          <tt:PanTilt x="${msg.pan || 0}" y="${msg.tilt || 0}"/>
          <tt:Zoom x="${msg.zoom || 0}"/>
        </tptz:Velocity>
      </tptz:ContinuousMove>`;
      break;

    case 'stop':
      isStop = true;
      body = `<tptz:Stop>
        <tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>
        <tptz:PanTilt>true</tptz:PanTilt>
        <tptz:Zoom>true</tptz:Zoom>
      </tptz:Stop>`;
      break;

    case 'goto_preset':
      body = `<tptz:GotoPreset>
        <tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>
        <tptz:PresetToken>${msg.preset}</tptz:PresetToken>
      </tptz:GotoPreset>`;
      break;

    case 'set_preset':
      body = `<tptz:SetPreset>
        <tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>
        <tptz:PresetName>${msg.name}</tptz:PresetName>
      </tptz:SetPreset>`;
      break;
  }

  if (body) {
    const result = await sendOnvif(body, isStop);
    if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
      vpsSocket.send(JSON.stringify({ type: 'cam_ptz_result', ...result }));
    }
  }
}

// ============ CAMERA SETTINGS (CGI) ============
async function sendCgi(path) {
  try {
    const url = `http://${CONFIG.camera.username}:${CONFIG.camera.password}@${CONFIG.camera.ip}${path}`;
    const response = await fetch(url);
    return { success: response.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSetting(msg) {
  console.log('[SETTING]', msg.setting, msg);

  let result;

  switch (msg.setting) {
    case 'flip':
      result = await sendCgi(`/cgi-bin/hi3510/param.cgi?cmd=setimageattr&-flip=${msg.flip ? 1 : 0}&-mirror=${msg.mirror ? 1 : 0}`);
      break;

    case 'nightvision':
      result = await sendCgi(`/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${msg.mode}`);
      break;

    case 'motion':
      result = await sendCgi(`/cgi-bin/hi3510/param.cgi?cmd=setmdattr&-enable=${msg.enabled ? 1 : 0}&-s=${msg.sensitivity || 5}`);
      break;
  }

  if (result && vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
    vpsSocket.send(JSON.stringify({ type: 'cam_setting_result', setting: msg.setting, ...result }));
  }
}

async function sendSnapshot() {
  console.log('[SNAPSHOT] Capturing...');

  try {
    const url = `http://${CONFIG.camera.username}:${CONFIG.camera.password}@${CONFIG.camera.ip}/tmpfs/auto.jpg`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
      vpsSocket.send(JSON.stringify({
        type: 'cam_snapshot_data',
        camera: 1,
        data: base64
      }));
    }
    console.log('[SNAPSHOT] Sent', Math.round(base64.length / 1024), 'KB');
  } catch (err) {
    console.error('[SNAPSHOT] Error:', err.message);
  }
}

// ============ STARTUP ============
console.log('========================================');
console.log('  Sricam Camera Relay');
console.log('========================================');
console.log('Camera:', CONFIG.camera.ip);
console.log('VPS:', CONFIG.vps.wsUrl);
console.log('========================================');

connectToVPS();

// Watchdog - check every 30 seconds if streaming should be running
setInterval(() => {
  if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN && !ffmpegProcess) {
    console.log('[WATCHDOG] FFmpeg not running but VPS connected - restarting stream...');
    startStreaming();
  }
}, 30000);

// Cleanup
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopStreaming();
  if (vpsSocket) vpsSocket.close();
  process.exit(0);
});
