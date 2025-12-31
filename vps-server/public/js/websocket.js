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

  // Object detection from Jetson
  if (d.type === 'detections') {
    handleDetections(d.camera, d.detections);
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

  // Compass auto-calibration status
  if (d.type === 'compass_cal') {
    updateCompassCalStatus(d.status);
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

  // Parse COMPASS data: COMPASS,heading,x,y,z
  if (d.data && d.data.startsWith('COMPASS,')) {
    const parts = d.data.split(',');
    if (parts.length >= 5 && window.lidar3dModule) {
      const heading = parseFloat(parts[1]);
      const x = parseInt(parts[2]);
      const y = parseInt(parts[3]);
      const z = parseInt(parts[4]);
      window.lidar3dModule.updateCompass(heading, x, y, z);
    }
    return;
  }

  // Parse GPS data: GPS,valid,lat,lon,sats,lastLat,lastLon
  if (d.data && d.data.startsWith('GPS,')) {
    const parts = d.data.split(',');
    if (parts.length >= 7 && window.lidar3dModule) {
      const valid = parseInt(parts[1]) === 1;
      const lat = parseFloat(parts[2]);
      const lon = parseFloat(parts[3]);
      const sats = parseInt(parts[4]);
      const lastLat = parseFloat(parts[5]);
      const lastLon = parseFloat(parts[6]);
      window.lidar3dModule.updateGps(valid, lat, lon, sats, lastLat, lastLon);
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

// ============ STATUS UPDATE HANDLER (with debouncing) ============
let lastEsp32Online = false;  // Start false so first status update triggers UI
let lastTeensyOnline = false;
let esp32OfflineTimeout = null;
let teensyOfflineTimeout = null;
const STATUS_DEBOUNCE_MS = 5000;  // Don't show offline for 5 seconds

function handleStatusUpdate(d) {
  // Debounced ESP32 status - only show offline after 5 seconds
  if (d.connected) {
    if (esp32OfflineTimeout) { clearTimeout(esp32OfflineTimeout); esp32OfflineTimeout = null; }
    if (!lastEsp32Online) {
      lastEsp32Online = true;
      updateEsp32UI(true);
    }
  } else {
    if (lastEsp32Online && !esp32OfflineTimeout) {
      esp32OfflineTimeout = setTimeout(() => {
        lastEsp32Online = false;
        updateEsp32UI(false);
      }, STATUS_DEBOUNCE_MS);
    }
  }

  // Debounced Teensy status
  if (d.teensyConnected !== undefined) {
    if (d.teensyConnected) {
      if (teensyOfflineTimeout) { clearTimeout(teensyOfflineTimeout); teensyOfflineTimeout = null; }
      if (!lastTeensyOnline) {
        lastTeensyOnline = true;
        updateTeensyUI(true, d.teensyVersion);
      }
    } else {
      if (lastTeensyOnline && !teensyOfflineTimeout) {
        teensyOfflineTimeout = setTimeout(() => {
          lastTeensyOnline = false;
          updateTeensyUI(false);
        }, STATUS_DEBOUNCE_MS);
      }
    }
  }
  if (d.teensyVersion) {
    document.getElementById('teensyVersion').textContent = 'v' + d.teensyVersion;
  }

  // Always update other info if connected
  if (d.connected) {
    if (d.wifi && d.wifi !== 'unknown') document.getElementById('wifi').textContent = d.wifi;
    if (d.rssi) document.getElementById('rssi').textContent = d.rssi + ' dBm';
    if (d.ip && d.ip !== 'unknown') document.getElementById('ip').textContent = d.ip;
    if (d.version && d.version !== 'unknown') {
      document.getElementById('version').textContent = 'v' + d.version;
      const v = document.getElementById('esp32Version');
      if (v) v.textContent = 'v' + d.version;
    }
    if (d.uptime) {
      var mins = Math.floor(d.uptime / 60);
      document.getElementById('uptime').textContent = mins + 'm';
    }
  }

  if (d.camera && window.camerasPtzModule) {
    window.camerasPtzModule.updateCam1Status(d.camera.connected, d.camera.streaming);
  }

  if (d.controller && typeof updateXboxStatus === 'function') {
    updateXboxStatus(d.controller === 'connected');
  }
}

function updateEsp32UI(online) {
  document.getElementById('status').textContent = online ? 'ONLINE' : 'OFFLINE';
  document.getElementById('status').className = 'status-text ' + (online ? 'online' : '');
  const statusDot = document.getElementById('statusDot');
  if (statusDot) statusDot.className = 'status-dot ' + (online ? 'online' : 'offline');
  const esp32Mini = document.getElementById('esp32StatusMini');
  if (esp32Mini) esp32Mini.textContent = online ? 'OK' : '--';
  document.getElementById('esp32Status').textContent = online ? 'Online' : 'Offline';
  document.getElementById('esp32Card').className = 'device-chip' + (online ? ' online' : '');
  const mobileEsp = document.getElementById('mobileEsp32');
  if (mobileEsp) mobileEsp.className = 'mobile-dev' + (online ? ' online' : '');
}

function updateTeensyUI(online, version) {
  const teensyMini = document.getElementById('teensyStatusMini');
  if (teensyMini) teensyMini.textContent = online ? 'OK' : '--';
  document.getElementById('teensyStatus').textContent = online ? 'Online' : 'Offline';
  document.getElementById('teensyCard').className = 'device-chip' + (online ? ' online' : '');
  const mobileTeensy = document.getElementById('mobileTeensy');
  if (mobileTeensy) mobileTeensy.className = 'mobile-dev' + (online ? ' online' : '');
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

// Auto-calibration status handler (compass auto-calibrates while driving)
function updateCompassCalStatus(status) {
  const calState = document.getElementById('calState');
  if (!calState) return;

  if (status === 'SAVED' || status === 'COMPLETE') {
    calState.textContent = '✓';
    calState.style.color = '#0f8';
  } else if (status === 'CALIBRATING') {
    calState.textContent = '...';
    calState.style.color = '#fc0';
  } else {
    calState.textContent = '--';
    calState.style.color = '#888';
  }
}

// ============ OBJECT DETECTION HANDLER ============
// Stores current detections for each camera
let cameraDetections = { 1: [], 2: [] };

// Living creatures (drawn with circle around head)
const livingClasses = ['person', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'rabbit', 'duck', 'chicken', 'deer'];

function handleDetections(cameraId, detections) {
  cameraDetections[cameraId] = detections;

  // Update detection overlay on camera canvas
  drawDetectionOverlay(cameraId, detections);

  // Update detection list panel
  updateDetectionPanel(cameraId, detections);
}

function drawDetectionOverlay(cameraId, detections) {
  const canvasId = cameraId === 1 ? 'overlayCanvas1' : 'overlayCanvas2';
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Match canvas size to container
  const container = canvas.parentElement;
  if (container) {
    canvas.width = container.clientWidth || 320;
    canvas.height = container.clientHeight || 180;
  }

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // Clear previous overlays
  ctx.clearRect(0, 0, w, h);

  detections.forEach(det => {
    const cx = det.bbox.x * w;
    const cy = det.bbox.y * h;
    const bw = det.bbox.w * w;
    const bh = det.bbox.h * h;
    const x1 = cx - bw/2;
    const y1 = cy - bh/2;

    // Label: "ClassName 0.85" (like original - no % sign)
    const label = det.class + ' ' + det.confidence.toFixed(2);
    const textX = Math.max(0, Math.min(cx - 50, w - 100));

    if (livingClasses.includes(det.class)) {
      // Living: gold circle around head, label above
      const headRadius = bw * 0.2;
      const headY = y1 + headRadius;

      ctx.beginPath();
      ctx.arc(cx, headY, headRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgb(255, 196, 64)';  // Gold (BGR 255,196,64)
      ctx.lineWidth = 2;
      ctx.stroke();

      const textY = Math.max(headY - headRadius - 10, 20);
      ctx.font = '500 12px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(label, textX, textY);
    } else {
      // Non-living: just label at center
      const textY = Math.max(cy, 20);
      ctx.font = '500 12px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(label, textX, textY);
    }
  });
}

function updateDetectionPanel(cameraId, detections) {
  const panel = document.getElementById('detectionPanel' + cameraId);
  if (!panel) return;

  if (detections.length === 0) {
    panel.innerHTML = '';
    return;
  }

  // Group by class and show count - clean white text
  const counts = {};
  detections.forEach(d => {
    counts[d.class] = (counts[d.class] || 0) + 1;
  });

  let items = [];
  for (const [cls, count] of Object.entries(counts)) {
    items.push(cls + (count > 1 ? ' x' + count : ''));
  }
  panel.innerHTML = items.join(', ');
}

console.log('[WS] Modular WebSocket v54 - Object detection + mapping mode');
