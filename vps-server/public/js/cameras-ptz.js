// ============ CAMERA PLAYERS AND PTZ CONTROLS ============
// Handles camera display, status updates, and PTZ movement

let cam1Image = null;
let cam2Image = null;
let cam1Active = false;
let cam2Active = false;
let pendingFrameUrl = { 1: null, 2: null };

// PTZ WebSocket connection
let ptzWs = null;
let ptzConnected = false;
const PTZ_SPEED = 1.0;
let ptzMoving = { 1: false, 2: false };

function initCam1() {
  const container = document.getElementById('cam1-video');
  if (!cam1Image && container) {
    cam1Image = document.createElement('img');
    cam1Image.style.width = '100%';
    cam1Image.style.height = '100%';
    cam1Image.style.objectFit = 'contain';
    cam1Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam1Image);
  }
}

function initCam2() {
  const container = document.getElementById('cam2-video');
  if (!cam2Image && container) {
    cam2Image = document.createElement('img');
    cam2Image.style.width = '100%';
    cam2Image.style.height = '100%';
    cam2Image.style.objectFit = 'contain';
    cam2Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam2Image);
  }
}

function displayFrame(blob, camId) {
  if (pendingFrameUrl[camId]) {
    URL.revokeObjectURL(pendingFrameUrl[camId]);
  }

  const url = URL.createObjectURL(blob);
  pendingFrameUrl[camId] = url;

  if (camId === 1) {
    if (!cam1Image) initCam1();
    if (cam1Image) {
      cam1Image.src = url;
      cam1Image.onload = () => {
        URL.revokeObjectURL(url);
        if (pendingFrameUrl[1] === url) pendingFrameUrl[1] = null;
      };
    }
    if (!cam1Active) {
      cam1Active = true;
      updateCamStatus(1, true, true);
    }
  } else if (camId === 2) {
    if (!cam2Image) initCam2();
    if (cam2Image) {
      cam2Image.src = url;
      cam2Image.onload = () => {
        URL.revokeObjectURL(url);
        if (pendingFrameUrl[2] === url) pendingFrameUrl[2] = null;
      };
    }
    if (!cam2Active) {
      cam2Active = true;
      updateCamStatus(2, true, true);
      updateJetsonStatus(true);
    }
  }
}

function updateCamStatus(camId, connected, streaming) {
  const el = document.getElementById('cam' + camId + '-status');
  const txt = document.getElementById('cam' + camId + 'StatusText');
  const card = document.getElementById('cam' + camId + 'Card');

  if (!el) return;

  if (streaming) {
    el.textContent = 'LIVE';
    el.className = 'cam-status-badge live';
    el.style.background = '';
    if (txt) txt.textContent = 'Live';
    if (card) card.className = 'device-chip online';
  } else {
    el.textContent = 'OFFLINE';
    el.className = 'cam-status-badge';
    el.style.background = '';
    if (txt) txt.textContent = 'Offline';
    if (card) card.className = 'device-chip';
  }
}

function updateCam1Status(connected, streaming) {
  updateCamStatus(1, connected, streaming);
}

function updateJetsonStatus(online) {
  const statusEl = document.getElementById('jetsonStatus');
  const versionEl = document.getElementById('jetsonVersion');
  const cardEl = document.getElementById('jetsonCard');

  if (statusEl) statusEl.textContent = online ? 'Online' : 'Offline';
  if (cardEl) cardEl.className = 'device-chip' + (online ? ' online' : '');
  if (versionEl && online) versionEl.textContent = 'Ubuntu 22.04';

  const mobileJetson = document.getElementById('mobileJetson');
  if (mobileJetson) mobileJetson.className = 'mobile-dev' + (online ? ' online' : '');
}

// ============ PTZ CONTROLS ============
function connectPtzWs() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ptzUrl = wsProtocol + '//' + location.host + '/ptz';
  ptzWs = new WebSocket(ptzUrl);

  ptzWs.onopen = () => {
    ptzConnected = true;
    ptzWs.send(JSON.stringify({ type: 'ptz_browser_hello' }));
  };

  ptzWs.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'ptz_relay_status') {
        console.log('[PTZ] Relay:', data.connected ? 'OK' : 'DISCONNECTED');
      }
    } catch (err) { }
  };

  ptzWs.onclose = () => {
    ptzConnected = false;
    setTimeout(connectPtzWs, 2000);
  };

  ptzWs.onerror = () => { };
}

function sendPtz(data) {
  if (ptzWs && ptzWs.readyState === WebSocket.OPEN) {
    ptzWs.send(JSON.stringify(data));
    return true;
  }
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return false;
  }
  return false;
}

function ptzMove(camId, pan, tilt) {
  ptzMoving[camId] = true;
  sendPtz({ type: 'cam_ptz', camera: camId, action: 'move', pan, tilt, zoom: 0 });
}

function ptzStop(camId) {
  if (!ptzMoving[camId]) return;
  sendPtz({ type: 'cam_ptz', camera: camId, action: 'stop' });
  ptzMoving[camId] = false;
}

// Initialize PTZ button handlers
function initPtzButtons() {
  // Camera 1 PTZ
  document.querySelectorAll('[data-ptz]').forEach(btn => {
    const action = btn.dataset.ptz;
    if (!action) return;

    btn.onmousedown = btn.ontouchstart = function(e) {
      e.preventDefault();
      switch (action) {
        case 'up': ptzMove(1, 0, PTZ_SPEED); break;
        case 'down': ptzMove(1, 0, -PTZ_SPEED); break;
        case 'left': ptzMove(1, -PTZ_SPEED, 0); break;
        case 'right': ptzMove(1, PTZ_SPEED, 0); break;
      }
    };
    btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
      if (['up', 'down', 'left', 'right'].includes(action)) ptzStop(1);
    };
  });

  // Camera 2 PTZ
  document.querySelectorAll('[data-ptz2]').forEach(btn => {
    const action = btn.dataset.ptz2;
    if (!action) return;

    btn.onmousedown = btn.ontouchstart = function(e) {
      e.preventDefault();
      switch (action) {
        case 'up': ptzMove(2, 0, PTZ_SPEED); break;
        case 'down': ptzMove(2, 0, -PTZ_SPEED); break;
        case 'left': ptzMove(2, -PTZ_SPEED, 0); break;
        case 'right': ptzMove(2, PTZ_SPEED, 0); break;
      }
    };
    btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
      if (['up', 'down', 'left', 'right'].includes(action)) ptzStop(2);
    };
  });
}

// Initialize on load
document.addEventListener('DOMContentLoaded', function() {
  initPtzButtons();
  connectPtzWs();
});

// Export module
window.camerasPtzModule = {
  initCam1,
  initCam2,
  displayFrame,
  updateCamStatus,
  updateCam1Status,
  updateJetsonStatus,
  ptzMove,
  ptzStop,
  sendPtz,
  getCam1Active: () => cam1Active,
  getCam2Active: () => cam2Active,
  setCam1Active: (v) => { cam1Active = v; },
  setCam2Active: (v) => { cam2Active = v; }
};
