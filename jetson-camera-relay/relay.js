/**
 * Jetson Camera Relay - Streams cameras from robot to VPS
 * Runs ON the Jetson Orin Nano Super mounted on the robot
 *
 * This replaces mac-camera-relay - cameras now work ANYWHERE the robot goes!
 *
 * Key differences from Mac version:
 * - FFmpeg uses system path (not homebrew)
 * - Can use Jetson hardware acceleration (NVENC/NVDEC)
 * - Cameras are local to robot network
 *
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║  SAFETY RULES - HARDCODED:                                                    ║
 * ║  1. Xbox controller ALWAYS has priority over autonomous commands              ║
 * ║  2. Claude Code is NEVER allowed to initiate robot movement or MAP 1          ║
 * ║  3. Only the USER can start mapping by clicking buttons in the web UI         ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 */

const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// SINGLETON: Only allow one instance
const LOCKFILE = '/tmp/jetson-relay.lock';
try {
  if (fs.existsSync(LOCKFILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCKFILE, 'utf8'));
    try {
      process.kill(oldPid, 0);
      try {
        const psOutput = execSync(`ps -p ${oldPid} -o command= 2>/dev/null`, { encoding: 'utf8' });
        if (psOutput.includes('relay.js')) {
          console.log(`[ERROR] Another relay instance running (PID ${oldPid}). Exiting.`);
          process.exit(1);
        } else {
          console.log(`[INFO] Stale lock (PID ${oldPid} is not relay.js), removing...`);
          fs.unlinkSync(LOCKFILE);
        }
      } catch (e) {
        fs.unlinkSync(LOCKFILE);
      }
    } catch (e) {
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

// FFmpeg - use system path on Jetson (installed via apt)
const FFMPEG = 'ffmpeg';

// Load config
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('ERROR: config.json not found! Copy config.example.json and edit it.');
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
    lastFrameTime: 0
  };
});

// Detection camera tracking - reduces quality on non-detection camera
let activeDetectionCamera = 1;

function getStreamQuality(camId) {
  // Detection camera gets full quality, other gets reduced
  if (camId === activeDetectionCamera) {
    return { scale: '960:540', fps: 12, quality: 10 };  // Full quality
  } else {
    return { scale: '480:270', fps: 6, quality: 15 };   // Reduced quality
  }
}

function restartCameraForDetection(newActiveCamera) {
  if (newActiveCamera === activeDetectionCamera) return;

  console.log('[DETECT-Q] Switching detection camera:', activeDetectionCamera, '->', newActiveCamera);
  activeDetectionCamera = newActiveCamera;

  // Restart both cameras with appropriate quality
  CONFIG.cameras.filter(c => c.id <= 2).forEach(cam => {
    const state = cameraState[cam.id];
    if (state && state.videoProcess) {
      const q = getStreamQuality(cam.id);
      console.log(`[DETECT-Q] Restarting CAM${cam.id}: ${q.scale} @ ${q.fps}fps`);
      stopVideoStream(cam);
      setTimeout(() => startVideoStream(cam), 500);
    }
  });
}

// Packet markers: Cam1: 0x00=video, 0x01=audio | Cam2: 0x02=video, 0x03=audio
function getVideoMarker(camId) { return (camId - 1) * 2; }
function getAudioMarker(camId) { return (camId - 1) * 2 + 1; }

// =============================================================================
// LOCAL DETECTION - Send frames to detect.py via TCP
// Protocol: [4-byte length BE][1-byte cam_id][jpeg_data]
// =============================================================================
const net = require('net');
let detectSocket = null;
let detectConnected = false;

function connectToDetection() {
  try {
    detectSocket = new net.Socket();

    detectSocket.connect(9998, '127.0.0.1', () => {
      detectConnected = true;
      console.log('[DETECT-TCP] Connected to local detection server');
    });

    detectSocket.on('close', () => {
      detectConnected = false;
      console.log('[DETECT-TCP] Disconnected, reconnecting in 2s...');
      setTimeout(connectToDetection, 2000);
    });

    detectSocket.on('error', (err) => {
      detectConnected = false;
    });
  } catch (e) {
    setTimeout(connectToDetection, 2000);
  }
}

function sendFrameToDetection(camId, jpegBuffer) {
  if (!detectConnected || !detectSocket) return;
  try {
    // Protocol: [4-byte length][1-byte marker][jpeg]
    const marker = getVideoMarker(camId);
    const payload = Buffer.concat([Buffer.from([marker]), jpegBuffer]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    detectSocket.write(Buffer.concat([header, payload]));
  } catch (e) {}
}

// Start detection connection after 2 seconds (give detect.py time to start)
setTimeout(connectToDetection, 2000);

function killExistingFfmpeg(camIp) {
  try {
    execSync(`pkill -9 -f "rtsp://${camIp}" 2>/dev/null`, { stdio: 'ignore' });
  } catch (e) {}
}

function countFfmpegProcesses(camIp) {
  try {
    const result = execSync(`pgrep -f "rtsp://${camIp}" 2>/dev/null`, { encoding: 'utf8' });
    return result.trim().split('\n').filter(p => p).length;
  } catch (e) { return 0; }
}

function killDuplicates(cam) {
  const state = cameraState[cam.id];
  if (state.videoStarting) return;

  const count = countFfmpegProcesses(cam.ip);
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

    const helloMsg = JSON.stringify({
      type: 'camera_hello',
      source: 'jetson',  // Identify as Jetson relay
      cameras: CONFIG.cameras.map(c => ({ id: c.id, name: c.name, ip: c.ip }))
    });
    console.log('[VPS] Sending camera_hello:', helloMsg);
    vpsSocket.send(helloMsg);

    // Stop existing streams and start fresh
    CONFIG.cameras.forEach(cam => {
      stopVideoStream(cam);
      stopAudioStream(cam);
      killExistingFfmpeg(cam.ip);
    });

    setTimeout(async () => {
      console.log('[VPS] Starting streams with staggered initialization...');
      for (const cam of CONFIG.cameras) {
        console.log(`[CAM${cam.id}] Initiating stream...`);
        startVideoStream(cam);
        startAudioStream(cam);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      console.log('[VPS] All camera streams initiated');
    }, 2000);
  });

  vpsSocket.on('message', async (data, isBinary) => {
    if (isBinary || Buffer.isBuffer(data)) return;

    const str = data.toString();
    console.log('[VPS-MSG-ALL] Type:', str.substring(0, 100));

    if (str.includes('v380') || str.includes('V380')) {
      console.log('[VPS-MSG] V380 message:', str.substring(0, 200));
    }
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

      // Handle detection camera changes - adjust stream quality
      if (msg.type === 'DETECTION_SETTINGS' || msg.type === 'detection_settings') {
        if (msg.active_camera && msg.active_camera !== activeDetectionCamera) {
          restartCameraForDetection(msg.active_camera);
        }
      }

      if (msg.type === 'cam_snapshot') {
        const cam = CONFIG.cameras.find(c => c.id === (msg.camera || 1));
        if (cam) await sendSnapshot(cam);
      }

      if (msg.type === 'v380_light') {
        console.log('[V380] Light command received:', msg.state);
        handleV380Light(msg.state);
      }

      if (msg.type === 'v380_music') {
        handleV380Music(msg.action, msg.volume || 25);
      }

      if (msg.type === 'v380_talk_start') {
        handleV380Talk('start');
      }

      if (msg.type === 'v380_talk_stop') {
        handleV380Talk('stop');
      }

      // WiFi scanning and management (via Alfa adapter)
      if (msg.type === 'wifi_scan') {
        console.log('[WIFI] Scan requested');
        try {
          // Rescan using Alfa adapter (no sudo needed for nmcli)
          execSync('nmcli device wifi rescan ifname wlx00c0caab495d 2>/dev/null || true', { timeout: 5000 });

          // Wait for scan to complete
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Get network list
          const output = execSync('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlx00c0caab495d 2>/dev/null || nmcli -t -f SSID,SIGNAL,SECURITY device wifi list', {
            encoding: 'utf8',
            timeout: 10000
          });

          // Get known connections
          const knownOutput = execSync('nmcli -t -f NAME,TYPE connection show 2>/dev/null || true', { encoding: 'utf8' });
          const knownNetworks = knownOutput.split('\n')
            .filter(line => line.includes(':wifi') || line.includes(':802-11-wireless'))
            .map(line => line.split(':')[0]);

          // Get current connection
          const statusOutput = execSync('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null || true', { encoding: 'utf8' });
          let currentNetwork = null;
          statusOutput.split('\n').forEach(line => {
            const parts = line.split(':');
            if (parts[1] && parts[1].includes('wlx')) {
              currentNetwork = parts[0];
            }
          });

          // Parse networks
          const networks = [];
          const seen = new Set();
          output.split('\n').forEach(line => {
            if (!line.trim()) return;
            const parts = line.split(':');
            const ssid = parts[0];
            if (!ssid || seen.has(ssid)) return;
            seen.add(ssid);

            networks.push({
              ssid: ssid,
              signal: parseInt(parts[1]) || 0,
              security: parts[2] || 'Open',
              known: knownNetworks.includes(ssid),
              connected: ssid === currentNetwork
            });
          });

          // Sort: connected first, then known, then by signal
          networks.sort((a, b) => {
            if (a.connected !== b.connected) return b.connected ? 1 : -1;
            if (a.known !== b.known) return b.known ? 1 : -1;
            return b.signal - a.signal;
          });

          console.log('[WIFI] Found', networks.length, 'networks');
          if (vpsSocket && vpsSocket.readyState === 1) {
            vpsSocket.send(JSON.stringify({
              type: 'wifi_networks',
              networks: networks
            }));
          }
        } catch (err) {
          console.error('[WIFI] Scan error:', err.message);
          if (vpsSocket && vpsSocket.readyState === 1) {
            vpsSocket.send(JSON.stringify({
              type: 'wifi_error',
              error: 'Scan failed: ' + err.message
            }));
          }
        }
      }

      if (msg.type === 'wifi_connect') {
        const ssid = msg.ssid;
        const password = msg.password;
        console.log('[WIFI] Connect requested:', ssid);

        try {
          let cmd;
          if (password) {
            // Connect with password
            cmd = `nmcli device wifi connect "${ssid}" password "${password}" ifname wlx00c0caab495d`;
          } else {
            // Connect to known network
            cmd = `nmcli connection up "${ssid}"`;
          }

          execSync(cmd, { timeout: 30000 });
          console.log('[WIFI] Connected to', ssid);

          if (vpsSocket && vpsSocket.readyState === 1) {
            vpsSocket.send(JSON.stringify({
              type: 'wifi_connected',
              ssid: ssid
            }));
          }
        } catch (err) {
          console.error('[WIFI] Connect error:', err.message);
          if (vpsSocket && vpsSocket.readyState === 1) {
            vpsSocket.send(JSON.stringify({
              type: 'wifi_error',
              error: 'Connection failed: ' + err.message
            }));
          }
        }
      }

      if (msg.type === 'wifi_status') {
        try {
          const output = execSync('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null || true', { encoding: 'utf8' });
          let currentNetwork = null;
          output.split('\n').forEach(line => {
            const parts = line.split(':');
            if (parts[1] && parts[1].includes('wlx')) {
              currentNetwork = parts[0];
            }
          });

          if (vpsSocket && vpsSocket.readyState === 1) {
            vpsSocket.send(JSON.stringify({
              type: 'wifi_status',
              connected: !!currentNetwork,
              ssid: currentNetwork
            }));
          }
        } catch (err) {
          console.error('[WIFI] Status error:', err.message);
        }
      }

      // Remote service control (start/restart LIDAR, etc)
      if (msg.type === 'jetson_service') {
        const service = msg.service;
        const action = msg.action || 'restart';
        const allowed = ['robot-lidar', 'robot-detection', 'robot-camera'];
        if (allowed.includes(service)) {
          console.log(`[JETSON] Service command: ${action} ${service}`);
          try {
            execSync(`sudo systemctl ${action} ${service}`, { timeout: 10000 });
            console.log(`[JETSON] ${service} ${action} SUCCESS`);
            if (vpsSocket && vpsSocket.readyState === 1) {
              vpsSocket.send(JSON.stringify({
                type: 'jetson_service_result',
                service: service,
                action: action,
                success: true
              }));
            }
          } catch (err) {
            console.error(`[JETSON] ${service} ${action} FAILED:`, err.message);
            if (vpsSocket && vpsSocket.readyState === 1) {
              vpsSocket.send(JSON.stringify({
                type: 'jetson_service_result',
                service: service,
                action: action,
                success: false,
                error: err.message
              }));
            }
          }
        }
      }
    } catch (err) {}
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
      source: 'jetson',
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
      if (msg.type === 'v380_light') {
        console.log('[V380] Light command via PTZ channel:', msg.state);
        handleV380Light(msg.state);
      }

      if (msg.type === 'v380_music') {
        console.log('[V380] Music command via PTZ channel:', msg.action);
        handleV380Music(msg.action, msg.volume || 25);
      }

      if (msg.type === 'v380_talk_start') {
        console.log('[V380] Talk start via PTZ channel');
        handleV380Talk('start');
      }

      if (msg.type === 'v380_talk_stop') {
        console.log('[V380] Talk stop via PTZ channel');
        handleV380Talk('stop');
      }

      if (msg.type === 'v380_talk_audio') {
        console.log('[V380] Talk audio received via PTZ channel:', msg.audio ? msg.audio.length : 0, 'chars');
        handleV380TalkAudio(msg.audio, msg.volume || 25);
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

// VIDEO STREAMING
// Jetson can use hardware acceleration with NVDEC for decoding
// For now using software encoding (mjpeg) for compatibility
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
    // CAM 1: VIDEO ONLY (UDP transport) - quality based on detection camera
    const q = getStreamQuality(cam.id);
    console.log(`[CAM${cam.id}] Starting (${q.scale} @ ${q.fps}fps): rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`);
    proc = spawn(FFMPEG, [
      '-rtsp_transport', 'udp',
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',
      '-probesize', '500000',
      '-i', rtspUrl,
      '-map', '0:v',
      '-vf', `scale=${q.scale}`,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', String(q.quality),
      '-r', String(q.fps),
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (cam.id === 3) {
    // CAM 3: V380 Light Bulb Camera (no auth, square format)
    const v380RtspUrl = `rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`;
    console.log(`[CAM${cam.id}] Starting V380 (TCP): ${v380RtspUrl}`);
    proc = spawn(FFMPEG, [
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',
      '-probesize', '500000',
      '-i', v380RtspUrl,
      '-map', '0:v',
      '-vf', 'scale=240:240',
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '8',
      '-r', '10',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // CAM 2: VIDEO + AUDIO (UDP) - quality based on detection camera
    const q = getStreamQuality(cam.id);
    console.log(`[CAM${cam.id}] Starting (${q.scale} @ ${q.fps}fps): rtsp://${cam.ip}:${cam.rtspPort}${cam.rtspPath}`);
    proc = spawn(FFMPEG, [
      '-rtsp_transport', 'udp',
      '-fflags', 'nobuffer+discardcorrupt',
      '-flags', 'low_delay',
      '-analyzeduration', '1000000',
      '-probesize', '500000',
      '-i', rtspUrl,
      '-map', '0:v',
      '-vf', `scale=${q.scale}`,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', String(q.quality),
      '-r', String(q.fps),
      'pipe:1',
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
  state.videoProcess.startTime = Date.now();
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
      state.lastFrameTime = now;

      if (vpsSocket && vpsSocket.readyState === WebSocket.OPEN) {
        if (vpsSocket.bufferedAmount < 50000) {
          vpsSocket.send(Buffer.concat([Buffer.from([videoMarker]), frame]));
        }
      }

      // Send to local detection server (shares camera stream = faster!)
      sendFrameToDetection(cam.id, frame);
    }

    if (frameBuffer.length > 100000) {
      frameBuffer = Buffer.alloc(0);
    }
  });

  // AUDIO from fd3 (cam2 only)
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

function startAudioStream(cam) {}
function stopAudioStream(cam) {}

// PTZ Control - Fire and forget
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
    console.log(`[CAM${cam.id}]`, isStop ? 'STOP' : 'MOVE', res.statusCode === 200 ? 'OK' : 'FAIL');
  });

  req.on('socket', (socket) => { socket.setNoDelay(true); });
  req.on('error', () => {});
  req.on('timeout', () => { req.destroy(); });
  req.write(xml);
  req.end();

  return { success: true };
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
    const result = sendOnvifFireAndForget(cam, body, isStop);
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

// V380 Light Control
const V380_LIGHT_SCRIPT = path.join(__dirname, 'v380-light.js');

function handleV380Light(state) {
  const actions = ['off', 'on', 'auto'];
  const action = actions[state] || 'on';

  console.log(`[V380] Sending light command: ${action}`);

  // Use node from PATH on Jetson
  const v380 = spawn('node', [V380_LIGHT_SCRIPT, action], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  });

  v380.stdout.on('data', (data) => {
    console.log('[V380] stdout:', data.toString().trim());
  });

  v380.stderr.on('data', (data) => {
    console.log('[V380] stderr:', data.toString().trim());
  });

  v380.on('error', (err) => {
    console.error('[V380] Error:', err.message);
  });

  setTimeout(() => {
    if (!v380.killed) {
      v380.kill('SIGTERM');
      console.log('[V380] Killed after timeout');
    }
  }, 10000);

  v380.on('close', (code) => {
    console.log('[V380] Light command completed, exit code:', code);
  });
}

// V380 Music Control
const V380_PLAY_SCRIPT = path.join(__dirname, 'v380-play.js');
const V380_TALK_SCRIPT = path.join(__dirname, 'v380-talk.js');
const MUSIC_FILE = '/home/jetson/music/Chrome_Sparks_-_Send_the_Pain_On.mp3';  // Music file on Jetson
let musicProcess = null;

function handleV380Music(action, volume = 25) {
  console.log(`[V380] Music command: ${action} at ${volume}%`);

  if (action === 'stop' && musicProcess) {
    musicProcess.kill('SIGTERM');
    musicProcess = null;
    console.log('[V380] Music stopped');
    return;
  }

  if (action === 'play') {
    // Kill any existing music process
    if (musicProcess) {
      musicProcess.kill('SIGTERM');
      musicProcess = null;
    }

    // Start playing music
    musicProcess = spawn('node', [V380_PLAY_SCRIPT, MUSIC_FILE, String(volume)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    musicProcess.stdout.on('data', (data) => {
      console.log('[V380-MUSIC]', data.toString().trim());
    });

    musicProcess.stderr.on('data', (data) => {
      console.log('[V380-MUSIC] Error:', data.toString().trim());
    });

    musicProcess.on('close', (code) => {
      console.log('[V380] Music finished, exit code:', code);
      musicProcess = null;
      // Notify VPS that music ended so UI can update
      if (ptzSocket && ptzSocket.readyState === 1) {
        ptzSocket.send(JSON.stringify({ type: 'v380_music_ended' }));
        console.log('[V380] Sent music_ended notification');
      }
    });
  }
}

function handleV380Talk(action) {
  console.log(`[V380] Talk command: ${action}`);
  // Just a beep for button feedback (old behavior)
  if (action === 'start') {
    const v380 = spawn('node', [V380_TALK_SCRIPT, 'beep', '15'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    v380.on('close', () => console.log('[V380] Talk beep sent'));
  }
}

// Handle recorded voice audio from browser
function handleV380TalkAudio(base64Audio, volume = 25) {
  if (!base64Audio) {
    console.log('[V380] No audio data received');
    return;
  }

  console.log(`[V380] Processing talk audio (${base64Audio.length} chars base64) at ${volume}%`);

  const tempDir = '/tmp';
  const webmFile = path.join(tempDir, 'talk_audio.webm');
  const wavFile = path.join(tempDir, 'talk_audio.wav');

  try {
    // Decode base64 to binary
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    fs.writeFileSync(webmFile, audioBuffer);
    console.log('[V380] Saved webm file:', audioBuffer.length, 'bytes');

    // Convert webm to wav using ffmpeg (8kHz mono for V380)
    const ffmpeg = spawn('ffmpeg', [
      '-y',                    // Overwrite output
      '-i', webmFile,          // Input webm
      '-ar', '8000',           // 8kHz sample rate
      '-ac', '1',              // Mono
      '-acodec', 'pcm_s16le',  // 16-bit PCM
      wavFile
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('[V380] Converted to wav, now playing through camera');
        // Play the converted audio through the V380 camera
        const v380Play = spawn('node', [V380_PLAY_SCRIPT, wavFile, String(volume)], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        v380Play.stdout.on('data', (data) => {
          console.log('[V380-TALK]', data.toString().trim());
        });

        v380Play.stderr.on('data', (data) => {
          console.log('[V380-TALK] Error:', data.toString().trim());
        });

        v380Play.on('close', (playCode) => {
          console.log('[V380] Talk audio playback finished, code:', playCode);
          // Cleanup temp files
          try {
            fs.unlinkSync(webmFile);
            fs.unlinkSync(wavFile);
          } catch (e) {}
        });
      } else {
        console.log('[V380] ffmpeg conversion failed, code:', code);
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg outputs to stderr normally
    });

  } catch (err) {
    console.error('[V380] Talk audio error:', err.message);
  }
}

// STARTUP
console.log('==========================================');
console.log('  Jetson Camera Relay v1.0.0');
console.log('  Cameras work ANYWHERE the robot goes!');
console.log('==========================================');
CONFIG.cameras.forEach(c => console.log(`CAM${c.id}: ${c.ip}`));
console.log('VPS:', CONFIG.vps.wsUrl);
console.log('==========================================');

CONFIG.cameras.forEach(cam => killExistingFfmpeg(cam.ip));

connectToVPS();
connectToPtzChannel();

// Watchdog
const INITIAL_TIMEOUT_MS = 30000;
const STALL_TIMEOUT_MS = 15000;
let watchdogEnabled = false;

setTimeout(() => { watchdogEnabled = true; console.log('[WATCHDOG] Enabled'); }, 20000);

setInterval(() => {
  if (!watchdogEnabled) return;
  if (vpsSocket?.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  CONFIG.cameras.forEach(cam => {
    const state = cameraState[cam.id];

    if (state.videoStarting) return;

    if (!state.videoProcess) {
      console.log(`[WATCHDOG] CAM${cam.id} not running, restarting...`);
      killExistingFfmpeg(cam.ip);
      setTimeout(() => startVideoStream(cam), 500);
      return;
    }

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
}, 5000);

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
