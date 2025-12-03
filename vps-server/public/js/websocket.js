// ============ DUAL WEBSOCKET ARCHITECTURE ============
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(wsProtocol + '//' + location.host);
ws.binaryType = 'arraybuffer';

// PTZ via /ptz path
let ptzWs = null;
let ptzConnected = false;

function connectPtzWs() {
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
    } catch (err) {}
  };

  ptzWs.onclose = () => {
    ptzConnected = false;
    setTimeout(connectPtzWs, 2000);
  };

  ptzWs.onerror = () => {};
}

connectPtzWs();

// ============ AUDIO PLAYER ============
let audioContext = null;
let isMuted = false;
let isMuted2 = false;

function initAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

async function playAudioChunk(data) {
  if (!audioContext || isMuted) return;
  try {
    const audioBuffer = await audioContext.decodeAudioData(data.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0);
  } catch (err) {}
}

// ============ CAMERA PLAYERS ============
let cam1Image = null;
let cam2Image = null;
let cam1Active = false;
let cam2Active = false;

function initCam1() {
  const container = document.getElementById('cam1-video');
  if (!cam1Image) {
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
  if (!cam2Image) {
    cam2Image = document.createElement('img');
    cam2Image.style.width = '100%';
    cam2Image.style.height = '100%';
    cam2Image.style.objectFit = 'contain';
    cam2Image.style.background = '#000';
    container.innerHTML = '';
    container.appendChild(cam2Image);
  }
}

let pendingFrameUrl = { 1: null, 2: null };

function displayFrame(blob, camId) {
  if (pendingFrameUrl[camId]) {
    URL.revokeObjectURL(pendingFrameUrl[camId]);
  }

  const url = URL.createObjectURL(blob);
  pendingFrameUrl[camId] = url;

  if (camId === 1) {
    if (!cam1Image) initCam1();
    cam1Image.src = url;
    cam1Image.onload = () => {
      URL.revokeObjectURL(url);
      if (pendingFrameUrl[1] === url) pendingFrameUrl[1] = null;
    };
    if (!cam1Active) {
      cam1Active = true;
      updateCamStatus(1, true, true);
    }
  } else if (camId === 2) {
    if (!cam2Image) initCam2();
    cam2Image.src = url;
    cam2Image.onload = () => {
      URL.revokeObjectURL(url);
      if (pendingFrameUrl[2] === url) pendingFrameUrl[2] = null;
    };
    if (!cam2Active) {
      cam2Active = true;
      updateCamStatus(2, true, true);
    }
  }
}

function updateCamStatus(camId, connected, streaming) {
  const el = document.getElementById('cam' + camId + '-status');
  const txt = document.getElementById('cam' + camId + 'StatusText');
  const card = document.getElementById('cam' + camId + 'Card');

  if (streaming) {
    el.textContent = 'LIVE';
    el.className = 'cam-status-badge live';
    txt.textContent = 'Live';
    card.className = 'status-card';
  } else if (connected) {
    el.textContent = 'READY';
    el.className = 'cam-status-badge';
    el.style.background = 'rgba(245,159,0,0.9)';
    txt.textContent = 'Ready';
    card.className = 'status-card warning';
  } else {
    el.textContent = 'OFFLINE';
    el.className = 'cam-status-badge';
    txt.textContent = 'Offline';
    card.className = 'status-card offline';
  }
}

function updateCam1Status(connected, streaming) {
  updateCamStatus(1, connected, streaming);
}

// ============ PTZ ============
const PTZ_SPEED = 1.0;
let ptzMoving = { 1: false, 2: false };

function sendPtz(data) {
  if (ptzWs && ptzWs.readyState === WebSocket.OPEN) {
    ptzWs.send(JSON.stringify(data));
    return true;
  }
  ws.send(JSON.stringify(data));
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

// Camera 1 PTZ
document.querySelectorAll('.ptz-btn').forEach(btn => {
  const action = btn.dataset.ptz;
  if (!action) return;

  btn.onmousedown = btn.ontouchstart = function(e) {
    e.preventDefault();
    switch(action) {
      case 'up': ptzMove(1, 0, PTZ_SPEED); break;
      case 'down': ptzMove(1, 0, -PTZ_SPEED); break;
      case 'left': ptzMove(1, -PTZ_SPEED, 0); break;
      case 'right': ptzMove(1, PTZ_SPEED, 0); break;
    }
  };
  btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
    if (['up','down','left','right'].includes(action)) ptzStop(1);
  };
});

// Camera 2 PTZ
document.querySelectorAll('[data-ptz2]').forEach(btn => {
  const action = btn.dataset.ptz2;
  if (!action) return;

  btn.onmousedown = btn.ontouchstart = function(e) {
    e.preventDefault();
    switch(action) {
      case 'up': ptzMove(2, 0, PTZ_SPEED); break;
      case 'down': ptzMove(2, 0, -PTZ_SPEED); break;
      case 'left': ptzMove(2, -PTZ_SPEED, 0); break;
      case 'right': ptzMove(2, PTZ_SPEED, 0); break;
    }
  };
  btn.onmouseup = btn.ontouchend = btn.onmouseleave = function() {
    if (['up','down','left','right'].includes(action)) ptzStop(2);
  };
});

// ============ WEBSOCKET MESSAGE HANDLER ============
ws.onopen = () => {
  ws.send(JSON.stringify({type: 'get_status'}));
  setTimeout(() => { if (!cam1Active) initCam1(); }, 1000);
};

ws.onmessage = function(e) {
  // Binary frames
  if (e.data instanceof ArrayBuffer) {
    const data = new Uint8Array(e.data);
    if (data.length < 2) return;

    const packetType = data[0];
    const payload = data.slice(1);
    const cameraId = Math.floor(packetType / 2) + 1;
    const isVideo = packetType % 2 === 0;

    if (isVideo) {
      displayFrame(new Blob([payload], {type: 'image/jpeg'}), cameraId);
    } else {
      if (cameraId === 1 && !isMuted) {
        playAudioChunk(payload);
      } else if (cameraId === 2 && !isMuted2) {
        playAudioChunk(payload);
      }
    }
    return;
  }
  if (e.data instanceof Blob) {
    e.data.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      if (data.length < 2) return;
      const packetType = data[0];
      const payload = data.slice(1);
      const cameraId = Math.floor(packetType / 2) + 1;
      const isVideo = packetType % 2 === 0;
      if (isVideo) {
        displayFrame(new Blob([payload], {type: 'image/jpeg'}), cameraId);
      } else if (cameraId === 1 && !isMuted) {
        playAudioChunk(payload);
      } else if (cameraId === 2 && !isMuted2) {
        playAudioChunk(payload);
      }
    });
    return;
  }

  var d = JSON.parse(e.data);

  if(d.type === 'serial') {
    // Check if this is TELEM data and parse it (but don't display in serial monitor)
    var telemData = parseTelemFromSerial(d.data);
    if (telemData) {
      updateDriverTelemetry(telemData);
      return;  // Don't show TELEM in serial monitor - it's just noise
    }

    // Don't show TEENSY_VERSION in serial monitor either
    if (d.data && d.data.startsWith('TEENSY_VERSION,')) {
      return;
    }

    // Show other serial messages
    var serialDiv = document.getElementById('serial');
    serialDiv.innerHTML += d.data + '<br>';
    var lines = serialDiv.innerHTML.split('<br>');
    if (lines.length > 50) {
      serialDiv.innerHTML = lines.slice(-50).join('<br>');
    }
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }

  if(d.type === 'status') {
    document.getElementById('status').textContent = d.connected ? 'ONLINE' : 'OFFLINE';
    document.getElementById('status').className = 'status ' + (d.connected ? 'online' : '');

    // Update ESP32 status card
    document.getElementById('esp32Status').textContent = d.connected ? 'Online' : 'Offline';
    document.getElementById('esp32Card').className = 'status-card' + (d.connected ? '' : ' offline');

    // Update Teensy status card
    if(d.teensyConnected !== undefined) {
      document.getElementById('teensyStatus').textContent = d.teensyConnected ? 'Online' : 'Offline';
      document.getElementById('teensyCard').className = 'status-card' + (d.teensyConnected ? '' : ' offline');
    }
    if(d.teensyVersion) {
      document.getElementById('teensyVersion').textContent = 'v' + d.teensyVersion;
    }

    if(d.connected) {
      if(d.wifi && d.wifi !== 'unknown') document.getElementById('wifi').textContent = d.wifi;
      if(d.rssi) document.getElementById('rssi').textContent = d.rssi + ' dBm';
      if(d.ip && d.ip !== 'unknown') document.getElementById('ip').textContent = d.ip;
      if(d.version && d.version !== 'unknown') {
        document.getElementById('version').textContent = 'v' + d.version;
        // Also show ESP32 version on its card
        document.getElementById('esp32Version').textContent = 'v' + d.version;
      }
      if(d.uptime) {
        var mins = Math.floor(d.uptime / 60);
        document.getElementById('uptime').textContent = mins + 'm';
      }
    } else {
      document.getElementById('wifi').textContent = '--';
      document.getElementById('rssi').textContent = '--';
      document.getElementById('ip').textContent = '--';
      document.getElementById('version').textContent = '--';
      document.getElementById('uptime').textContent = '--';
    }

    if(d.camera) {
      updateCam1Status(d.camera.connected, d.camera.streaming);
      if(d.camera.streaming && !cam1Active) initCam1();
    }
  }

  if(d.type === 'camera_status') {
    updateCam1Status(d.connected, d.streaming);
    if(d.streaming && !cam1Active) initCam1();
  }

  if(d.type === 'camera_streams') {
    if(d.cameras) {
      if(d.cameras[1] && !d.cameras[1].streaming) {
        cam1Active = false;
        updateCamStatus(1, false, false);
      }
      if(d.cameras[2] && !d.cameras[2].streaming) {
        cam2Active = false;
        updateCamStatus(2, false, false);
      }
    }
  }

  // Driver telemetry
  if(d.type === 'telemetry' || d.type === 'driver_status' || d.type === 'teensy_telemetry') {
    updateDriverTelemetry(d);
  }
};

ws.onclose = () => {
  document.getElementById('status').textContent = 'DISCONNECTED';
  document.getElementById('status').className = 'status';
  updateCam1Status(false, false);
};

// ============ AUDIO TOGGLE ============
function toggleMute() {
  initAudio();
  isMuted = !isMuted;
  const btn = document.getElementById("speakerBtn");
  if (isMuted) {
    btn.innerHTML = "&#128264;";
    btn.style.color = "#ff4444";
    btn.style.opacity = "0.5";
  } else {
    btn.innerHTML = "&#128266;";
    btn.style.color = "#44ff44";
    btn.style.opacity = "0.7";
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({type: "audio_mute", muted: isMuted}));
  }
}

document.addEventListener('click', function() {
  initAudio();
}, { once: true });

function toggleMute2() {
  initAudio();
  isMuted2 = !isMuted2;
  const btn = document.getElementById("speakerBtn2");
  if (isMuted2) {
    btn.innerHTML = "&#128264;";
    btn.style.color = "#ff4444";
    btn.style.opacity = "0.5";
  } else {
    btn.innerHTML = "&#128266;";
    btn.style.color = "#44ff44";
    btn.style.opacity = "0.7";
  }
}
