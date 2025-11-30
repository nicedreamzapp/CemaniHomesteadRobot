/**
 * Mac Camera Relay - Bridges local Sricams to VPS
 *
 * This runs on your Mac Mini and:
 * 1. Connects to VPS via WebSocket (like your robot does)
 * 2. Streams video from multiple cameras to VPS via FFmpeg
 * 3. Receives PTZ commands from VPS and sends to cameras
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
let reconnectTimer = null;

// Per-camera state
const cameraState = {};

// Initialize state for each camera
CONFIG.cameras.forEach(cam => {
  cameraState[cam.id] = {
    videoProcess: null,
    audioProcess: null,
    videoStats: { sent: 0, avgSize: 0 },
    audioStats: { sent: 0, avgSize: 0 }
  };
});

// Packet type markers:
// Camera 1: 0x00 = video, 0x01 = audio
// Camera 2: 0x02 = video, 0x03 = audio
function getVideoMarker(camId) { return (camId - 1) * 2; }
function getAudioMarker(camId) { return (camId - 1) * 2 + 1; }

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

    // Announce as camera relay with all cameras
    vpsSocket.send(JSON.stringify({
      type: 'camera_hello',
      cameras: CONFIG.cameras.map(c => ({ id: c.id, name: c.name, ip: c.ip }))
    }));

    // Start streaming all cameras (video only for now - audio causes lag with 2 cameras)
    CONFIG.cameras.forEach(cam => {
      startVideoStream(cam);
      // startAudioStream(cam);  // Disabled - too many RTSP connections cause lag
    });
  });

  vpsSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle PTZ commands from VPS (with camera ID)
      if (msg.type === 'cam_ptz') {
        const camId = msg.camera || 1;
        const cam = CONFIG.cameras.find(c => c.id === camId);
        if (cam) {
          await handlePTZ(cam, msg);
        }
      }

      // Handle camera settings
      if (msg.type === 'cam_setting') {
        const camId = msg.camera || 1;
        const cam = CONFIG.cameras.find(c => c.id === camId);
        if (cam) {
          await handleSetting(cam, msg);
        }
      }

      // Handle snapshot request
      if (msg.type === 'cam_snapshot') {
        const camId = msg.camera || 1;
        const cam = CONFIG.cameras.find(c => c.id === camId);
        if (cam) {
          await sendSnapshot(cam);
        }
      }

    } catch (err) {
      console.error('[VPS] Message error:', err.message);
    }
  });

  vpsSocket.on('close', () => {
    console.log('[VPS] Disconnected');
    vpsSocket = null;
    // Stop all cameras
    CONFIG.cameras.forEach(cam => {
      stopVideoStream(cam);
      stopAudioStream(cam);
    });
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
function startVideoStream(cam) {
  const state = cameraState[cam.id];
  if (state.videoProcess) {
    console.log(`[CAM${cam.id}] Video already running`);
    return;
  }

  const rtspUrl = `rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`;
  console.log(`[CAM${cam.id}] Starting video stream at ${CONFIG.stream.fps}fps`);
  console.log(`[CAM${cam.id}] RTSP URL: ${rtspUrl}`);

  const quality = Math.round(31 - (CONFIG.stream.quality / 100 * 29));
  state.videoProcess = spawn(FFMPEG, [
    '-timeout', '5000000',
    '-i', rtspUrl,
    '-vf', `scale=${CONFIG.stream.scale}`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', String(quality),
    '-r', String(CONFIG.stream.fps),
    '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let frameBuffer = Buffer.alloc(0);
  const JPEG_START = Buffer.from([0xFF, 0xD8]);
  const JPEG_END = Buffer.from([0xFF, 0xD9]);
  const videoMarker = getVideoMarker(cam.id);

  state.videoProcess.stdout.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (true) {
      const startIdx = frameBuffer.indexOf(JPEG_START);
      if (startIdx === -1) break;

      const endIdx = frameBuffer.indexOf(JPEG_END, startIdx);
      if (endIdx === -1) break;

      const frame = frameBuffer.slice(startIdx, endIdx + 2);
      frameBuffer = frameBuffer.slice(endIdx + 2);

      state.videoStats.sent++;
      state.videoStats.avgSize = Math.round((state.videoStats.avgSize * 0.9) + (frame.length * 0.1));

      if (CONFIG.stream.useWebSocket && vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        const packet = Buffer.concat([Buffer.from([videoMarker]), frame]);
        vpsSocket.send(packet);
      }
    }

    if (frameBuffer.length > 500000) {
      frameBuffer = Buffer.alloc(0);
    }
  });

  state.videoProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.log(`[CAM${cam.id}-FFMPEG]`, msg.trim());
    }
  });

  state.videoProcess.on('close', (code) => {
    console.log(`[CAM${cam.id}] Video exited with code ${code}, will restart in 3 seconds...`);
    state.videoProcess = null;
    setTimeout(() => {
      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        startVideoStream(cam);
      }
    }, 3000);
  });

  state.videoProcess.on('error', (err) => {
    console.error(`[CAM${cam.id}] Video process error:`, err.message);
    state.videoProcess = null;
    setTimeout(() => startVideoStream(cam), 3000);
  });
}

function stopVideoStream(cam) {
  const state = cameraState[cam.id];
  if (state.videoProcess) {
    console.log(`[CAM${cam.id}] Stopping video...`);
    state.videoProcess.kill('SIGTERM');
    state.videoProcess = null;
  }
}

// ============ AUDIO STREAMING VIA FFMPEG ============
function startAudioStream(cam) {
  const state = cameraState[cam.id];
  if (state.audioProcess) {
    console.log(`[CAM${cam.id}] Audio already running`);
    return;
  }

  const rtspUrl = `rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`;
  console.log(`[CAM${cam.id}] Starting audio stream`);

  state.audioProcess = spawn(FFMPEG, [
    '-timeout', '5000000',
    '-i', rtspUrl,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '32k',
    '-f', 'mp3',
    '-flush_packets', '1',
    '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let audioBuffer = Buffer.alloc(0);
  const CHUNK_SIZE = 2048;
  const audioMarker = getAudioMarker(cam.id);

  state.audioProcess.stdout.on('data', (chunk) => {
    audioBuffer = Buffer.concat([audioBuffer, chunk]);

    while (audioBuffer.length >= CHUNK_SIZE) {
      const audioChunk = audioBuffer.slice(0, CHUNK_SIZE);
      audioBuffer = audioBuffer.slice(CHUNK_SIZE);

      state.audioStats.sent++;
      state.audioStats.avgSize = Math.round((state.audioStats.avgSize * 0.9) + (audioChunk.length * 0.1));

      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        const packet = Buffer.concat([Buffer.from([audioMarker]), audioChunk]);
        vpsSocket.send(packet);
      }
    }
  });

  state.audioProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.log(`[CAM${cam.id}-AUDIO]`, msg.trim());
    }
  });

  state.audioProcess.on('close', (code) => {
    console.log(`[CAM${cam.id}] Audio exited with code ${code}`);
    state.audioProcess = null;
    setTimeout(() => {
      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        startAudioStream(cam);
      }
    }, 3000);
  });

  state.audioProcess.on('error', (err) => {
    console.error(`[CAM${cam.id}] Audio process error:`, err.message);
    state.audioProcess = null;
  });
}

function stopAudioStream(cam) {
  const state = cameraState[cam.id];
  if (state.audioProcess) {
    console.log(`[CAM${cam.id}] Stopping audio...`);
    state.audioProcess.kill('SIGTERM');
    state.audioProcess = null;
  }
}

// ============ ONVIF PTZ CONTROL ============
function sendOnvif(cam, body, isStop = false) {
  return new Promise((resolve) => {
    const cleanBody = body.replace(/\s+/g, ' ').trim();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${cam.username}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${cam.password}</Password></UsernameToken></Security></s:Header><s:Body>${cleanBody}</s:Body></s:Envelope>`;

    const curl = spawn(CURL, [
      '-s',
      '--connect-timeout', '3',
      '-X', 'POST',
      '-H', 'Content-Type: application/soap+xml; charset=utf-8',
      '-d', xml,
      `http://${cam.ip}:${cam.onvifPort}/onvif/ptz_service`
    ]);

    let stdout = '';
    curl.stdout.on('data', (data) => { stdout += data.toString(); });

    curl.on('close', (code) => {
      const success = stdout.includes('Response') || code === 52;
      console.log(`[CAM${cam.id}-ONVIF]`, isStop ? 'STOP' : 'MOVE', success ? 'OK' : 'FAILED');
      resolve({ success });
    });

    curl.on('error', (err) => {
      console.error(`[CAM${cam.id}-ONVIF] Error:`, err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

async function handlePTZ(cam, msg) {
  console.log(`[CAM${cam.id}-PTZ]`, msg.action);

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
    const result = await sendOnvif(cam, body, isStop);
    if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
      vpsSocket.send(JSON.stringify({ type: 'cam_ptz_result', camera: cam.id, ...result }));
    }
  }
}

// ============ CAMERA SETTINGS (CGI) ============
async function sendCgi(cam, path) {
  try {
    const url = `http://${cam.username}:${cam.password}@${cam.ip}${path}`;
    const response = await fetch(url);
    return { success: response.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSetting(cam, msg) {
  console.log(`[CAM${cam.id}-SETTING]`, msg.setting, msg);

  let result;

  switch (msg.setting) {
    case 'flip':
      result = await sendCgi(cam, `/cgi-bin/hi3510/param.cgi?cmd=setimageattr&-flip=${msg.flip ? 1 : 0}&-mirror=${msg.mirror ? 1 : 0}`);
      break;

    case 'nightvision':
      result = await sendCgi(cam, `/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${msg.mode}`);
      break;

    case 'motion':
      result = await sendCgi(cam, `/cgi-bin/hi3510/param.cgi?cmd=setmdattr&-enable=${msg.enabled ? 1 : 0}&-s=${msg.sensitivity || 5}`);
      break;
  }

  if (result && vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
    vpsSocket.send(JSON.stringify({ type: 'cam_setting_result', camera: cam.id, setting: msg.setting, ...result }));
  }
}

async function sendSnapshot(cam) {
  console.log(`[CAM${cam.id}] Capturing snapshot...`);

  try {
    const url = `http://${cam.username}:${cam.password}@${cam.ip}/tmpfs/auto.jpg`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
      vpsSocket.send(JSON.stringify({
        type: 'cam_snapshot_data',
        camera: cam.id,
        data: base64
      }));
    }
    console.log(`[CAM${cam.id}] Snapshot sent`, Math.round(base64.length / 1024), 'KB');
  } catch (err) {
    console.error(`[CAM${cam.id}] Snapshot error:`, err.message);
  }
}

// ============ STARTUP ============
console.log('========================================');
console.log('  Multi-Camera Relay');
console.log('========================================');
CONFIG.cameras.forEach(cam => {
  console.log(`Camera ${cam.id} (${cam.name}): ${cam.ip}`);
});
console.log('VPS:', CONFIG.vps.wsUrl);
console.log('========================================');

connectToVPS();

// Watchdog - check every 10 seconds if streaming should be running
setInterval(() => {
  if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
    CONFIG.cameras.forEach(cam => {
      const state = cameraState[cam.id];
      if (!state.videoProcess) {
        console.log(`[WATCHDOG] CAM${cam.id} video not running - restarting...`);
        startVideoStream(cam);
      }
      // Audio disabled for dual camera - causes lag
      // if (!state.audioProcess) {
      //   console.log(`[WATCHDOG] CAM${cam.id} audio not running - restarting...`);
      //   startAudioStream(cam);
      // }
    });
  }
}, 10000);

// Log stats every 10 seconds
setInterval(() => {
  CONFIG.cameras.forEach(cam => {
    const state = cameraState[cam.id];
    if (state.videoStats.sent > 0) {
      console.log(`[CAM${cam.id}] FPS: ${Math.round(state.videoStats.sent/10)}, Avg: ${Math.round(state.videoStats.avgSize/1024)}KB`);
      state.videoStats.sent = 0;
    }
  });
}, 10000);

// Cleanup
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  CONFIG.cameras.forEach(cam => {
    stopVideoStream(cam);
    stopAudioStream(cam);
  });
  if (vpsSocket) vpsSocket.close();
  process.exit(0);
});
