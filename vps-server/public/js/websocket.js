// ============ WEBSOCKET MESSAGE ROUTER ============
// Main WebSocket connection and message routing to modules
// v51 - Modular architecture

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(wsProtocol + '//' + location.host);
ws.binaryType = 'arraybuffer';

// ============ MESSAGE HANDLER ============
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'get_status' }));
  setTimeout(() => {
    if (window.camerasPtzModule && !window.camerasPtzModule.getCam1Active()) {
      window.camerasPtzModule.initCam1();
    }
  }, 1000);
};

ws.onmessage = function(e) {
  // Binary frames (video/audio)
  if (e.data instanceof ArrayBuffer) {
    handleBinaryData(new Uint8Array(e.data));
    return;
  }
  if (e.data instanceof Blob) {
    e.data.arrayBuffer().then(buffer => handleBinaryData(new Uint8Array(buffer)));
    return;
  }

  // JSON messages
  var d = JSON.parse(e.data);

  // Serial data
  if (d.type === 'serial') {
    handleSerialData(d);
  }

  // LIDAR data
  if (d.type === 'lidar') {
    if (window.lidar3dModule) window.lidar3dModule.updateLidar3D(d.points);
    if (window.lidar2dModule) window.lidar2dModule.drawLidarPoints(d.points);
  }

  // Dead reckoning (encoder-based position)
  if (d.type === 'dead_reckoning') {
    handleDeadReckoning(d);
  }

  // Status updates
  if (d.type === 'status') {
    handleStatusUpdate(d);
  }

  // Camera status
  if (d.type === 'camera_status') {
    if (window.camerasPtzModule) {
      window.camerasPtzModule.updateCam1Status(d.connected, d.streaming);
      if (d.streaming && !window.camerasPtzModule.getCam1Active()) {
        window.camerasPtzModule.initCam1();
      }
    }
  }

  // Camera streams
  if (d.type === 'camera_streams') {
    if (d.cameras && window.camerasPtzModule) {
      if (d.cameras[1] && !d.cameras[1].streaming) {
        window.camerasPtzModule.setCam1Active(false);
        window.camerasPtzModule.updateCamStatus(1, false, false);
      }
      if (d.cameras[2] && !d.cameras[2].streaming) {
        window.camerasPtzModule.setCam2Active(false);
        window.camerasPtzModule.updateCamStatus(2, false, false);
        window.camerasPtzModule.updateJetsonStatus(false);
      }
    }
  }

  // Driver telemetry
  if (d.type === 'telemetry' || d.type === 'driver_status' || d.type === 'teensy_telemetry') {
    if (typeof updateDriverTelemetry === 'function') {
      updateDriverTelemetry(d);
    }

    // Sync odomState with server telemetry
    if (d.odomX !== undefined && d.odomY !== undefined && window.odomState) {
      window.odomState.x = d.odomX;
      window.odomState.y = d.odomY;
      window.odomState.heading = d.odomHeading;
      window.odomState.totalDistance = d.odomDistance || window.odomState.totalDistance;
      if (d.odomTrail) window.odomState.trail = d.odomTrail;
    }
  }
};

ws.onclose = () => {
  document.getElementById('status').textContent = 'DISCONNECTED';
  document.getElementById('status').className = 'status-text';

  const statusDot = document.getElementById('statusDot');
  if (statusDot) statusDot.className = 'status-dot offline';

  const esp32Mini = document.getElementById('esp32StatusMini');
  const teensyMini = document.getElementById('teensyStatusMini');
  if (esp32Mini) esp32Mini.textContent = '--';
  if (teensyMini) teensyMini.textContent = '--';

  if (window.camerasPtzModule) {
    window.camerasPtzModule.updateCam1Status(false, false);
    window.camerasPtzModule.updateJetsonStatus(false);
  }
};

// ============ BINARY DATA HANDLER ============
function handleBinaryData(data) {
  if (data.length < 2) return;

  const packetType = data[0];
  const payload = data.slice(1);
  const cameraId = Math.floor(packetType / 2) + 1;
  const isVideo = packetType % 2 === 0;

  if (isVideo) {
    if (window.camerasPtzModule) {
      window.camerasPtzModule.displayFrame(new Blob([payload], { type: 'image/jpeg' }), cameraId);
    }
  } else {
    // Audio
    if (window.audioPlayerModule) {
      if (cameraId === 1 && !window.audioPlayerModule.isMuted()) {
        window.audioPlayerModule.playAudioChunk(payload);
      } else if (cameraId === 2 && !window.audioPlayerModule.isMuted2()) {
        window.audioPlayerModule.playAudioChunk(payload);
      }
    }
  }
}

// ============ SERIAL DATA HANDLER ============
function handleSerialData(d) {
  // Parse TELEM data
  if (typeof parseTelemFromSerial === 'function') {
    var telemData = parseTelemFromSerial(d.data);
    if (telemData) {
      if (typeof updateDriverTelemetry === 'function') {
        updateDriverTelemetry(telemData);
      }
      return;
    }
  }

  // Parse SONAR data
  if (d.data && d.data.startsWith('SONAR,')) {
    if (window.sonarDisplayModule) {
      window.sonarDisplayModule.parseSonarData(d.data);
    }
    return;
  }

  // Skip version in serial
  if (d.data && d.data.startsWith('TEENSY_VERSION,')) return;

  // Check Xbox controller status
  if (d.data && (d.data.includes('Xbox Connected') || d.data.includes('Xbox connected') || d.data.includes('XBOX_CONNECTED'))) {
    if (typeof updateXboxStatus === 'function') updateXboxStatus(true);
  }
  if (d.data && (d.data.includes('Xbox Disconnected') || d.data.includes('Xbox disconnected') || d.data.includes('XBOX_DISCONNECTED'))) {
    if (typeof updateXboxStatus === 'function') updateXboxStatus(false);
  }

  // Show in serial monitor
  var serialDiv = document.getElementById('serial');
  if (serialDiv) {
    serialDiv.innerHTML += d.data + '<br>';
    var lines = serialDiv.innerHTML.split('<br>');
    if (lines.length > 50) {
      serialDiv.innerHTML = lines.slice(-50).join('<br>');
    }
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }
}

// ============ DEAD RECKONING HANDLER ============
function handleDeadReckoning(d) {
  console.warn('[GRID MOVE] x=' + d.odomX + 'mm, y=' + d.odomY + 'mm');

  if (window.odomState) {
    window.odomState.x = d.odomX;
    window.odomState.y = d.odomY;
    window.odomState.heading = d.odomHeading;
    window.odomState.totalDistance = d.odomDistance || 0;
    if (d.odomTrail) window.odomState.trail = d.odomTrail;

    // Update position display
    const xFt = (d.odomX / 304.8).toFixed(1);
    const yFt = (d.odomY / 304.8).toFixed(1);
    const debugZ = document.getElementById('debugContainerZ');
    const debugX = document.getElementById('debugContainerX');
    if (debugZ) debugZ.textContent = yFt + 'ft';
    if (debugX) debugX.textContent = xFt + 'ft';
  }
}

// ============ STATUS UPDATE HANDLER ============
function handleStatusUpdate(d) {
  document.getElementById('status').textContent = d.connected ? 'ONLINE' : 'OFFLINE';
  document.getElementById('status').className = 'status-text ' + (d.connected ? 'online' : '');

  const statusDot = document.getElementById('statusDot');
  if (statusDot) statusDot.className = 'status-dot ' + (d.connected ? 'online' : 'offline');

  const esp32Mini = document.getElementById('esp32StatusMini');
  const teensyMini = document.getElementById('teensyStatusMini');
  if (esp32Mini) esp32Mini.textContent = d.connected ? 'OK' : '--';
  if (teensyMini) teensyMini.textContent = d.teensyConnected ? 'OK' : '--';

  document.getElementById('esp32Status').textContent = d.connected ? 'Online' : 'Offline';
  document.getElementById('esp32Card').className = 'device-chip' + (d.connected ? ' online' : '');

  const mobileEsp = document.getElementById('mobileEsp32');
  if (mobileEsp) mobileEsp.className = 'mobile-dev' + (d.connected ? ' online' : '');

  if (d.teensyConnected !== undefined) {
    document.getElementById('teensyStatus').textContent = d.teensyConnected ? 'Online' : 'Offline';
    document.getElementById('teensyCard').className = 'device-chip' + (d.teensyConnected ? ' online' : '');
    const mobileTeensy = document.getElementById('mobileTeensy');
    if (mobileTeensy) mobileTeensy.className = 'mobile-dev' + (d.teensyConnected ? ' online' : '');
  }
  if (d.teensyVersion) {
    document.getElementById('teensyVersion').textContent = 'v' + d.teensyVersion;
  }

  if (d.connected) {
    if (d.wifi && d.wifi !== 'unknown') document.getElementById('wifi').textContent = d.wifi;
    if (d.rssi) document.getElementById('rssi').textContent = d.rssi + ' dBm';
    if (d.ip && d.ip !== 'unknown') document.getElementById('ip').textContent = d.ip;
    if (d.version && d.version !== 'unknown') {
      document.getElementById('version').textContent = 'v' + d.version;
      document.getElementById('esp32Version').textContent = 'v' + d.version;
    }
    if (d.uptime) {
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

  if (d.camera && window.camerasPtzModule) {
    window.camerasPtzModule.updateCam1Status(d.camera.connected, d.camera.streaming);
    if (d.camera.streaming && !window.camerasPtzModule.getCam1Active()) {
      window.camerasPtzModule.initCam1();
    }
  }

  if (!d.connected) {
    if (typeof updateXboxStatus === 'function') updateXboxStatus(false);
  } else if (d.controller) {
    if (typeof updateXboxStatus === 'function') updateXboxStatus(d.controller === 'connected');
  }
}

// ============ GLOBAL FUNCTIONS ============
// Toggle mute functions that delegate to audio module
function toggleMute() {
  if (window.audioPlayerModule) window.audioPlayerModule.toggleMute();
}

function toggleMute2() {
  if (window.audioPlayerModule) window.audioPlayerModule.toggleMute2();
}

// Fullscreen toggle for 3D LIDAR view
function toggleLidar3DFullscreen() {
  if (window.lidar3dModule) window.lidar3dModule.toggleLidar3DFullscreen();
}

console.log('[WS] Modular WebSocket v51 loaded');
