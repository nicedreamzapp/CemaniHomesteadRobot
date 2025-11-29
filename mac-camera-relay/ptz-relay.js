/**
 * PTZ Control Relay - Handles camera pan/tilt/zoom via ONVIF
 *
 * This runs alongside MediaMTX and only handles PTZ commands.
 * Video streaming is handled by MediaMTX WebRTC.
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

    // Announce as camera relay (for PTZ only)
    vpsSocket.send(JSON.stringify({
      type: 'camera_hello',
      camera: 1,
      ip: CONFIG.camera.ip,
      ptzOnly: true
    }));
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

// ============ ONVIF PTZ CONTROL ============
let lastMoveTime = 0;
let pendingStop = null;
let moveInProgress = false;
const MIN_MOVE_TIME = 400; // Minimum time to let camera move before stopping (ms)

function sendOnvif(body, isStop = false) {
  return new Promise((resolve) => {
    // Remove newlines and extra spaces from body
    const cleanBody = body.replace(/\s+/g, ' ').trim();
    // Include Security header with username/password like the original working relay.js
    const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${CONFIG.camera.username}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${CONFIG.camera.password}</Password></UsernameToken></Security></s:Header><s:Body>${cleanBody}</s:Body></s:Envelope>`;

    console.log('[ONVIF] Sending', isStop ? 'STOP' : 'MOVE', 'command...');

    const curl = spawn('curl', [
      '-s',
      '--connect-timeout', '3',
      '-X', 'POST',
      '-H', 'Content-Type: application/soap+xml; charset=utf-8',
      '-d', xml,
      `http://${CONFIG.camera.ip}:${CONFIG.camera.onvifPort}/onvif/ptz_service`
    ]);

    let stdout = '';
    let stderr = '';

    curl.stdout.on('data', (data) => { stdout += data.toString(); });
    curl.stderr.on('data', (data) => { stderr += data.toString(); });

    curl.on('close', (code) => {
      // code 52 = empty reply, which is normal for Stop commands on this camera
      const success = stdout.includes('Response') || code === 52;
      console.log('[ONVIF] Response:', success ? 'OK' : 'FAILED', 'code:', code);
      resolve({ success });
    });

    curl.on('error', (err) => {
      console.error('[ONVIF] Error:', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

async function handlePTZ(msg) {
  console.log('[PTZ]', msg.action, msg);

  let body = '';
  let isStop = false;

  switch (msg.action) {
    case 'move':
      // Cancel any pending stop
      if (pendingStop) {
        clearTimeout(pendingStop);
        pendingStop = null;
      }
      // Wait for any previous move to complete before starting new one
      moveInProgress = true;
      lastMoveTime = Date.now();
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
      // Ensure minimum move time before stopping
      const elapsed = Date.now() - lastMoveTime;
      if (elapsed < MIN_MOVE_TIME) {
        // Schedule stop after minimum time
        if (pendingStop) clearTimeout(pendingStop);
        pendingStop = setTimeout(() => {
          pendingStop = null;
          handlePTZ({ type: 'cam_ptz', action: 'stop' });
        }, MIN_MOVE_TIME - elapsed);
        console.log('[PTZ] Delaying stop by', MIN_MOVE_TIME - elapsed, 'ms');
        return;
      }
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
console.log('  PTZ Control Relay');
console.log('========================================');
console.log('Camera:', CONFIG.camera.ip);
console.log('VPS:', CONFIG.vps.wsUrl);
console.log('========================================');

connectToVPS();

// Cleanup
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (vpsSocket) vpsSocket.close();
  process.exit(0);
});
