/**
 * Mac Camera Relay - Bridges local Sricams to VPS
 * Simplified version: VIDEO ONLY, no audio/microphone
 */

const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// SINGLETON: Only allow one instance - but be smart about stale locks
const LOCKFILE = '/tmp/relay.lock';
try {
  // Check if another instance is running
  if (fs.existsSync(LOCKFILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCKFILE, 'utf8'));
    try {
      process.kill(oldPid, 0); // Test if process exists
      // Process exists - check if it's actually a relay.js process
      const { execSync } = require('child_process');
      try {
        const psOutput = execSync(`ps -p ${oldPid} -o command= 2>/dev/null`, { encoding: 'utf8' });
        if (psOutput.includes('relay.js')) {
          console.log(`[ERROR] Another relay instance running (PID ${oldPid}). Exiting.`);
          process.exit(1);
        } else {
          // PID exists but it's not a relay - stale lock
          console.log(`[INFO] Stale lock (PID ${oldPid} is not relay.js), removing...`);
          fs.unlinkSync(LOCKFILE);
        }
      } catch (e) {
        // ps failed, probably the process is gone
        fs.unlinkSync(LOCKFILE);
      }
    } catch (e) {
      // Old process is dead, remove stale lock
      console.log('[INFO] Removing stale lock file');
      fs.unlinkSync(LOCKFILE);
    }
  }
  fs.writeFileSync(LOCKFILE, String(process.pid));
} catch (e) {
  console.error('[ERROR] Could not create lock file:', e.message);
}
process.on('exit', () => { try { fs.unlinkSync(LOCKFILE); } catch (e) {} });
process.on('SIGTERM', () => { try { fs.unlinkSync(LOCKFILE); } catch (e) {} process.exit(0); });

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// Load config
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('ERROR: config.json not found!');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Connections
let vpsSocket = null;
let ptzSocket = null;
let reconnectTimer = null;
let ptzReconnectTimer = null;

// Per-camera state
const cameraState = {};
CONFIG.cameras.forEach(cam => {
  cameraState[cam.id] = {
    videoProcess: null,
    audioProcess: null,
    videoStarting: false,
    audioStarting: false,
    stats: { sent: 0, avgSize: 0 },
    lastFrameTime: 0  // Track when we last received a frame
  };
});

// Packet marker bytes: Cam1: 0x00=video, 0x01=audio | Cam2: 0x02=video, 0x03=audio
function getVideoMarker(camId) { return (camId - 1) * 2; }
function getAudioMarker(camId) { return (camId - 1) * 2 + 1; }

// Kill any existing ffmpeg processes for this camera
function killExistingFfmpeg(camIp) {
  try {
    execSync(`pkill -9 -f "rtsp://${camIp}" 2>/dev/null`, { stdio: 'ignore' });
  } catch (e) { /* no processes to kill */ }
}

// Count ffmpeg processes for a camera IP
function countFfmpegProcesses(camIp) {
  try {
    const result = execSync(`pgrep -f "rtsp://${camIp}" 2>/dev/null`, { encoding: 'utf8' });
    return result.trim().split('\n').filter(p => p).length;
  } catch (e) { return 0; }
}

// Kill duplicate ffmpeg processes (keep only the one we're tracking)
function killDuplicates(cam) {
  const state = cameraState[cam.id];
  // Skip if we're already starting a stream (prevents cleanup loop)
  if (state.videoStarting) return;

  const count = countFfmpegProcesses(cam.ip);
  // We expect 1 combined process per camera now
  if (count > 1 && state.videoProcess) {
    const ourPid = state.videoProcess.pid;

    console.log(`[CLEANUP] CAM${cam.id} has ${count} ffmpeg processes (ours: ${ourPid}), killing duplicates...`);

    try {
      const result = execSync(`pgrep -f "rtsp://${cam.ip}" 2>/dev/null`, { encoding: 'utf8' });
      const pids = result.trim().split('\n').filter(p => p && parseInt(p) !== ourPid);
      pids.forEach(pid => {
        try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) {}
      });
      if (pids.length > 0) console.log(`[CLEANUP] Killed duplicate PIDs: ${pids.join(', ')}`);
    } catch (e) {}
  }
}

function connectToVPS() {
  if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) return;

  console.log('[VPS] Connecting to', CONFIG.vps.wsUrl);

  try {
    vpsSocket = new WebSocket(CONFIG.vps.wsUrl);
  } catch (err) {
    console.error('[VPS] Error:', err.message);
    scheduleReconnect();
    return;
  }

  vpsSocket.on('open', () => {
    console.log('[VPS] Connected!');
    if (vpsSocket._socket) vpsSocket._socket.setNoDelay(true);

    vpsSocket.send(JSON.stringify({
      type: 'camera_hello',
      cameras: CONFIG.cameras.map(c => ({ id: c.id, name: c.name, ip: c.ip }))
    }));

    // Stop any existing streams and start fresh
    CONFIG.cameras.forEach(cam => {
      stopVideoStream(cam);
      stopAudioStream(cam);
      killExistingFfmpeg(cam.ip);
    });

    setTimeout(async () => {
      console.log('[VPS] Starting streams with staggered initialization...');

      // Start cameras sequentially with delays to avoid RTSP race conditions
      for (const cam of CONFIG.cameras) {
        console.log(`[CAM${cam.id}] Initiating stream...`);
        startVideoStream(cam);
        startAudioStream(cam);
        // Wait 3 seconds between cameras to avoid RTSP/network contention
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      console.log('[VPS] All camera streams initiated');
    }, 2000);
  });

  vpsSocket.on('message', async (data, isBinary) => {
    // Ignore binary (video frames)
    if (isBinary || Buffer.isBuffer(data)) return;

    const str = data.toString();
    // Log all text messages that might be PTZ
    if (str.includes('ptz') || str.includes('cam')) {
      console.log('[VPS-MSG] Received:', str.substring(0, 200));
    }

    try {
      const msg = JSON.parse(str);

      if (msg.type === 'cam_ptz') {
        console.log('[PTZ] Executing PTZ:', JSON.stringify(msg));
        const cam = CONFIG.cameras.find(c => c.id === (msg.camera || 1));
        if (cam) {
          console.log('[PTZ] Found camera:', cam.id, cam.ip);
          await handlePTZ(cam, msg);
        } else {
          console.log('[PTZ] ERROR: Camera not found for id:', msg.camera);
        }
      }

      if (msg.type === 'cam_setting') {
        const cam = CONFIG.cameras.find(c => c.id === (msg.camera || 1));
        if (cam) await handleSetting(cam, msg);
      }

      if (msg.type === 'cam_snapshot') {
        const cam = CONFIG.cameras.find(c => c.id === (msg.camera || 1));
        if (cam) await sendSnapshot(cam);
      }
    } catch (err) {
      // Ignore parse errors from binary data
    }
  });

  vpsSocket.on('close', () => {
    console.log('[VPS] Disconnected');
    vpsSocket = null;
    CONFIG.cameras.forEach(cam => {
      stopVideoStream(cam);
      stopAudioStream(cam);
    });
    scheduleReconnect();
  });

  vpsSocket.on('error', (err) => console.error('[VPS] Error:', err.message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToVPS();
  }, 5000);
}

// PTZ priority channel
function getPtzUrl() {
  try {
    const url = new URL(CONFIG.vps.wsUrl);
    url.port = '3002';
    return url.toString();
  } catch (e) {
    const host = CONFIG.vps.wsUrl.replace('ws://', '').split(':')[0].split('/')[0];
    return `ws://${host}:3002`;
  }
}

function connectToPtzChannel() {
  if (ptzSocket && ptzSocket.readyState === WebSocket.OPEN) return;

  const ptzUrl = getPtzUrl();
  console.log('[PTZ] Connecting to', ptzUrl);

  try {
    ptzSocket = new WebSocket(ptzUrl);
  } catch (err) {
    schedulePtzReconnect();
    return;
  }

  ptzSocket.on('open', () => {
    console.log('[PTZ] Connected!');
    if (ptzSocket._socket) ptzSocket._socket.setNoDelay(true);
    ptzSocket.send(JSON.stringify({
      type: 'ptz_relay_hello',
      cameras: CONFIG.cameras.map(c => ({ id: c.id, name: c.name }))
    }));
  });

  ptzSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'cam_ptz') {
        const cam = CONFIG.cameras.find(c => c.id === (msg.camera || 1));
        if (cam) await handlePTZ(cam, msg, true);
      }
    } catch (err) {}
  });

  ptzSocket.on('close', () => {
    ptzSocket = null;
    schedulePtzReconnect();
  });

  ptzSocket.on('error', () => {});
}

function schedulePtzReconnect() {
  if (ptzReconnectTimer) return;
  ptzReconnectTimer = setTimeout(() => {
    ptzReconnectTimer = null;
    connectToPtzChannel();
  }, 2000);
}

// VIDEO STREAMING - cam1 video only, cam2 video+audio
function startVideoStream(cam) {
  const state = cameraState[cam.id];

  if (state.videoProcess) {
    console.log(`[CAM${cam.id}] Already running`);
    return;
  }

  if (state.videoStarting) {
    console.log(`[CAM${cam.id}] Already starting`);
    return;
  }

  state.videoStarting = true;
  const rtspUrl = `rtsp://${cam.username}:${cam.password}@${cam.ip}:${cam.rtspPort}${cam.rtspPath}`;

  let proc;

  if (cam.id === 1) {
    // CAM 1: VIDEO ONLY - no audio
    // This camera requires UDP (rejects TCP with "Nonmatching transport")
    console.log(`[CAM${cam.id}] Starting video only (UDP): rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`);
    proc = spawn(FFMPEG, [
      '-rtsp_transport', 'udp',
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',  // Analyze for 1 second max
      '-probesize', '500000',
      '-i', rtspUrl,
      '-map', '0:v',
      '-vf', `scale=${CONFIG.stream.scale}`,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '10',
      '-r', '12',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // CAM 2: VIDEO + AUDIO
    // Use UDP - this camera also rejects TCP with "Nonmatching transport"
    console.log(`[CAM${cam.id}] Starting video+audio (UDP): rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`);
    proc = spawn(FFMPEG, [
      '-rtsp_transport', 'udp',
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',  // Analyze for 1 second max
      '-probesize', '500000',
      '-i', rtspUrl,
      // Video output -> stdout
      '-map', '0:v',
      '-vf', `scale=${CONFIG.stream.scale}`,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '10',
      '-r', '12',
      'pipe:1',
      // Audio output -> fd3
      '-map', '0:a?',
      '-acodec', 'libmp3lame',
      '-ar', '22050',
      '-ac', '1',
      '-b:a', '32k',
      '-f', 'mp3',
      'pipe:3'
    ], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    });
  }

  state.videoProcess = proc;
  state.videoProcess.startTime = Date.now();  // Track when process started for watchdog
  state.videoStarting = false;
  console.log(`[CAM${cam.id}] Started (pid ${proc.pid})`);

  // VIDEO from stdout
  let frameBuffer = Buffer.alloc(0);
  const JPEG_START = Buffer.from([0xFF, 0xD8]);
  const JPEG_END = Buffer.from([0xFF, 0xD9]);
  const videoMarker = getVideoMarker(cam.id);
  let lastVideoSent = 0;

  proc.stdout.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    let frame = null;
    while (true) {
      const start = frameBuffer.indexOf(JPEG_START);
      if (start === -1) break;
      const end = frameBuffer.indexOf(JPEG_END, start);
      if (end === -1) break;
      frame = frameBuffer.slice(start, end + 2);
      frameBuffer = frameBuffer.slice(end + 2);
    }

    const now = Date.now();
    if (frame && (now - lastVideoSent) >= 80) {
      lastVideoSent = now;
      state.stats.sent++;
      state.stats.avgSize = Math.round((state.stats.avgSize * 0.9) + (frame.length * 0.1));
      state.lastFrameTime = now;  // Track frame receipt for health check

      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        if (vpsSocket.bufferedAmount < 50000) {
          vpsSocket.send(Buffer.concat([Buffer.from([videoMarker]), frame]));
        }
      }
    }

    if (frameBuffer.length > 100000) {
      frameBuffer = Buffer.alloc(0);
    }
  });

  // AUDIO from fd3 - only for cam2
  if (cam.id === 2 && proc.stdio[3]) {
    const audioMarker = getAudioMarker(cam.id);
    let audioBuffer = Buffer.alloc(0);

    proc.stdio[3].on('data', (chunk) => {
      audioBuffer = Buffer.concat([audioBuffer, chunk]);

      if (audioBuffer.length >= 600) {
        if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
          if (vpsSocket.bufferedAmount < 30000) {
            vpsSocket.send(Buffer.concat([Buffer.from([audioMarker]), audioBuffer]));
          }
        }
        audioBuffer = Buffer.alloc(0);
      }
    });
  }

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error') || msg.includes('failed')) {
      console.log(`[CAM${cam.id}]`, msg.trim().substring(0, 100));
    }
  });

  proc.on('close', (code) => {
    console.log(`[CAM${cam.id}] Exited (${code})`);
    state.videoProcess = null;
    state.videoStarting = false;
    setTimeout(() => {
      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN && !state.videoProcess) {
        startVideoStream(cam);
      }
    }, 3000);
  });

  proc.on('error', (err) => {
    console.error(`[CAM${cam.id}] Error:`, err.message);
    state.videoProcess = null;
    state.videoStarting = false;
  });
}

function stopVideoStream(cam) {
  const state = cameraState[cam.id];
  state.videoStarting = false;
  if (state.videoProcess) {
    console.log(`[CAM${cam.id}] Stopping...`);
    state.videoProcess.kill('SIGKILL');
    state.videoProcess = null;
  }
}

// No-ops - audio handled in video stream for cam2
function startAudioStream(cam) {}
function stopAudioStream(cam) {}

// PTZ Control - Fire and forget for instant response
function sendOnvifFireAndForget(cam, body, isStop = false) {
  const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${cam.username}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${cam.password}</Password></UsernameToken></Security></s:Header><s:Body>${body.replace(/\s+/g, ' ')}</s:Body></s:Envelope>`;

  const req = http.request({
    hostname: cam.ip,
    port: cam.onvifPort,
    path: '/onvif/ptz_service',
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml', 'Content-Length': Buffer.byteLength(xml) },
    timeout: 500
  }, (res) => {
    // Just log, don't wait for full response
    console.log(`[CAM${cam.id}]`, isStop ? 'STOP' : 'MOVE', res.statusCode === 200 ? 'OK' : 'FAIL');
  });

  // Disable Nagle's algorithm for instant send
  req.on('socket', (socket) => { socket.setNoDelay(true); });
  req.on('error', () => {});  // Ignore errors for fire-and-forget
  req.on('timeout', () => { req.destroy(); });
  req.write(xml);
  req.end();

  return { success: true };  // Assume success for instant response
}

// Legacy async version for settings that need response
function sendOnvif(cam, body, isStop = false) {
  return new Promise((resolve) => {
    const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${cam.username}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${cam.password}</Password></UsernameToken></Security></s:Header><s:Body>${body.replace(/\s+/g, ' ')}</s:Body></s:Envelope>`;

    const req = http.request({
      hostname: cam.ip,
      port: cam.onvifPort,
      path: '/onvif/ptz_service',
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml', 'Content-Length': Buffer.byteLength(xml) },
      timeout: 500
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ success: res.statusCode === 200 });
      });
    });

    req.on('socket', (socket) => { socket.setNoDelay(true); });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.write(xml);
    req.end();
  });
}

function handlePTZ(cam, msg, usePtzSocket = false) {
  let body = '', isStop = false;

  switch (msg.action) {
    case 'move':
      body = `<tptz:ContinuousMove><tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${msg.pan||0}" y="${msg.tilt||0}"/><tt:Zoom x="${msg.zoom||0}"/></tptz:Velocity></tptz:ContinuousMove>`;
      break;
    case 'stop':
      isStop = true;
      body = `<tptz:Stop><tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`;
      break;
    case 'goto_preset':
      body = `<tptz:GotoPreset><tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken><tptz:PresetToken>${msg.preset}</tptz:PresetToken></tptz:GotoPreset>`;
      break;
  }

  if (body) {
    // Fire and forget - don't wait for camera response
    const result = sendOnvifFireAndForget(cam, body, isStop);
    // Send immediate "success" to browser so UI feels instant
    const socket = usePtzSocket && ptzSocket?.readyState === WebSocket.OPEN ? ptzSocket : vpsSocket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'cam_ptz_result', camera: cam.id, ...result }));
    }
  }
}

async function handleSetting(cam, msg) {
  let path = '';
  switch (msg.setting) {
    case 'flip':
      path = `/cgi-bin/hi3510/param.cgi?cmd=setimageattr&-flip=${msg.flip?1:0}&-mirror=${msg.mirror?1:0}`;
      break;
    case 'nightvision':
      path = `/cgi-bin/hi3510/param.cgi?cmd=setinfrared&-infraredstat=${msg.mode}`;
      break;
  }
  if (path) {
    try {
      await fetch(`http://${cam.username}:${cam.password}@${cam.ip}${path}`);
    } catch (e) {}
  }
}

async function sendSnapshot(cam) {
  try {
    const res = await fetch(`http://${cam.username}:${cam.password}@${cam.ip}/tmpfs/auto.jpg`);
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    if (vpsSocket?.readyState === WebSocket.OPEN) {
      vpsSocket.send(JSON.stringify({ type: 'cam_snapshot_data', camera: cam.id, data: base64 }));
    }
  } catch (e) {}
}

// STARTUP
console.log('=================================');
console.log('  Camera Relay (Video + Audio)');
console.log('=================================');
CONFIG.cameras.forEach(c => console.log(`CAM${c.id}: ${c.ip}`));
console.log('VPS:', CONFIG.vps.wsUrl);
console.log('=================================');

// Kill any existing ffmpeg processes first
CONFIG.cameras.forEach(cam => killExistingFfmpeg(cam.ip));

connectToVPS();
connectToPtzChannel();

// Watchdog - restart dead or stalled streams
// Give more time for initial connection (30s) and stall detection (15s)
const INITIAL_TIMEOUT_MS = 30000;  // Wait longer for initial connection
const STALL_TIMEOUT_MS = 15000;    // Restart if no frames for 15 seconds
let watchdogEnabled = false;

// Delay watchdog startup to let initial connections settle
setTimeout(() => { watchdogEnabled = true; console.log('[WATCHDOG] Enabled'); }, 20000);

setInterval(() => {
  if (!watchdogEnabled) return;
  if (vpsSocket?.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  CONFIG.cameras.forEach(cam => {
    const state = cameraState[cam.id];

    // Skip if already starting
    if (state.videoStarting) return;

    // Restart if no process running
    if (!state.videoProcess) {
      console.log(`[WATCHDOG] CAM${cam.id} not running, restarting...`);
      killExistingFfmpeg(cam.ip);
      setTimeout(() => startVideoStream(cam), 500);
      return;
    }

    // Check for stall - but use longer timeout for initial connection
    const timeSinceStart = now - (state.videoProcess.startTime || now);
    const timeout = state.lastFrameTime === 0 ? INITIAL_TIMEOUT_MS : STALL_TIMEOUT_MS;
    const stalled = (now - Math.max(state.lastFrameTime, state.videoProcess.startTime || 0)) > timeout;

    if (stalled) {
      const reason = state.lastFrameTime === 0 ? 'never received frames' : `no frames for ${Math.round((now - state.lastFrameTime)/1000)}s`;
      console.log(`[WATCHDOG] CAM${cam.id} ${reason}, restarting...`);
      stopVideoStream(cam);
      killExistingFfmpeg(cam.ip);
      setTimeout(() => startVideoStream(cam), 2000);
    }
  });
}, 5000);  // Check every 5 seconds

// Process cleanup - kill duplicates every 5 seconds
setInterval(() => {
  CONFIG.cameras.forEach(cam => killDuplicates(cam));
}, 5000);

// Stats
setInterval(() => {
  CONFIG.cameras.forEach(cam => {
    const s = cameraState[cam.id].stats;
    if (s.sent > 0) {
      console.log(`[CAM${cam.id}] ${Math.round(s.sent/10)}fps ${Math.round(s.avgSize/1024)}KB`);
      s.sent = 0;
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
  vpsSocket?.close();
  ptzSocket?.close();
  process.exit(0);
});
