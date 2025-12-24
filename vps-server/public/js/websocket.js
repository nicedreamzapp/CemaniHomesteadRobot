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
let isMuted = false;   // Default to unmuted
let isMuted2 = false;  // Default to unmuted

function initAudio() {
  if (audioContext) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

async function playAudioChunk(data) {
  if (!audioContext) return;
  try {
    const audioBuffer = await audioContext.decodeAudioData(data.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0);
  } catch (err) {
    console.log('[AUDIO] Error playing chunk:', err);
  }
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
      updateJetsonStatus(true);
    }
  }
}

function updateCamStatus(camId, connected, streaming) {
  const el = document.getElementById('cam' + camId + '-status');
  const txt = document.getElementById('cam' + camId + 'StatusText');
  const card = document.getElementById('cam' + camId + 'Card');

  if (!el) return;  // Element not found, skip update

  if (streaming) {
    el.textContent = 'LIVE';
    el.className = 'cam-status-badge live';
    el.style.background = '';  // Use CSS default (green)
    if (txt) txt.textContent = 'Live';
    if (card) card.className = 'device-chip online';
  } else {
    el.textContent = 'OFFLINE';
    el.className = 'cam-status-badge';
    el.style.background = '';  // Use CSS default (red)
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
}

// ============ PTZ ============
const PTZ_SPEED = 1.0;
let ptzMoving = { 1: false, 2: false };

function sendPtz(data) {
  if (ptzWs && ptzWs.readyState === WebSocket.OPEN) {
    ptzWs.send(JSON.stringify(data));
    return true;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
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

// Camera 1 PTZ - bind both old .ptz-btn and new PTZ pad elements
document.querySelectorAll('[data-ptz]').forEach(btn => {
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
      } else {
        // Audio packet
        if (cameraId === 2 && !isMuted2) {
          playAudioChunk(payload);
        } else if (cameraId === 1 && !isMuted) {
          playAudioChunk(payload);
        }
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

    // Check if this is SONAR data
    if (d.data && d.data.startsWith('SONAR,')) {
      parseSonarData(d.data);
      return;  // Don't show SONAR in serial monitor - updated on UI
    }

    // Don't show TEENSY_VERSION in serial monitor either
    if (d.data && d.data.startsWith('TEENSY_VERSION,')) {
      return;
    }

    // Check for Xbox controller status from ESP32
    if (d.data && (d.data.includes('Xbox Connected') || d.data.includes('Xbox connected') || d.data.includes('XBOX_CONNECTED'))) {
      updateXboxStatus(true);
    }
    if (d.data && (d.data.includes('Xbox Disconnected') || d.data.includes('Xbox disconnected') || d.data.includes('XBOX_DISCONNECTED'))) {
      updateXboxStatus(false);
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

  // ============ LIDAR DATA HANDLING ============
  if(d.type === 'lidar') {
    drawLidarPoints(d.points);
  }

  if(d.type === 'status') {
    // Update header status indicator
    document.getElementById('status').textContent = d.connected ? 'ONLINE' : 'OFFLINE';
    document.getElementById('status').className = 'status-text ' + (d.connected ? 'online' : '');

    // Update status dot
    const statusDot = document.getElementById('statusDot');
    if (statusDot) {
      statusDot.className = 'status-dot ' + (d.connected ? 'online' : 'offline');
    }

    // Update mini status cards in header
    const esp32Mini = document.getElementById('esp32StatusMini');
    const teensyMini = document.getElementById('teensyStatusMini');
    if (esp32Mini) esp32Mini.textContent = d.connected ? 'OK' : '--';
    if (teensyMini) teensyMini.textContent = d.teensyConnected ? 'OK' : '--';

    // Update ESP32 status card
    document.getElementById('esp32Status').textContent = d.connected ? 'Online' : 'Offline';
    document.getElementById('esp32Card').className = 'device-chip' + (d.connected ? ' online' : '');

    // Update Teensy status card
    if(d.teensyConnected !== undefined) {
      document.getElementById('teensyStatus').textContent = d.teensyConnected ? 'Online' : 'Offline';
      document.getElementById('teensyCard').className = 'device-chip' + (d.teensyConnected ? ' online' : '');
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

    // Check for Xbox controller status from ESP32
    // If robot is disconnected, controller is also disconnected
    if(!d.connected) {
      updateXboxStatus(false);
    } else if(d.controller) {
      updateXboxStatus(d.controller === 'connected');
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
        updateJetsonStatus(false);
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
  document.getElementById('status').className = 'status-text';

  // Update status dot
  const statusDot = document.getElementById('statusDot');
  if (statusDot) {
    statusDot.className = 'status-dot offline';
  }

  // Reset mini status cards
  const esp32Mini = document.getElementById('esp32StatusMini');
  const teensyMini = document.getElementById('teensyStatusMini');
  if (esp32Mini) esp32Mini.textContent = '--';
  if (teensyMini) teensyMini.textContent = '--';

  updateCam1Status(false, false);
  updateJetsonStatus(false);
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
    btn.innerHTML = "🔇";
    btn.classList.add("muted");
  } else {
    btn.innerHTML = "🔊";
    btn.classList.remove("muted");
  }
  console.log('[AUDIO] Cam2 muted:', isMuted2);
}

// ============ ULTRASONIC SONAR DISPLAY ============
// Parse SONAR data: SONAR,FL,FR,RL,RR (distances in cm)
function parseSonarData(data) {
  const parts = data.split(',');
  if (parts.length < 5) return;

  const fl = parseFloat(parts[1]) || 0;
  const fr = parseFloat(parts[2]) || 0;
  const rl = parseFloat(parts[3]) || 0;
  const rr = parseFloat(parts[4]) || 0;

  console.log('[SONAR] FL:', fl, 'FR:', fr, 'RL:', rl, 'RR:', rr);

  updateSonarDisplay('FL', fl);
  updateSonarDisplay('FR', fr);
  updateSonarDisplay('RL', rl);
  updateSonarDisplay('RR', rr);
}

// Test function - call from browser console: testSonar(50)
window.testSonar = function(distCm) {
  console.log('[SONAR TEST] Testing with distance:', distCm, 'cm');
  updateSonarDisplay('FL', distCm);
  updateSonarDisplay('FR', distCm);
  updateSonarDisplay('RL', distCm);
  updateSonarDisplay('RR', distCm);
};

// Track sonar data timeout per sensor
let sonarTimeouts = { FL: null, FR: null, RL: null, RR: null };

// Smoothing: keep last 3 readings and average them
let sonarHistory = { FL: [], FR: [], RL: [], RR: [] };
let sonarSmoothed = { FL: 0, FR: 0, RL: 0, RR: 0 };

function smoothReading(sensor, rawCm) {
  const history = sonarHistory[sensor];
  if (rawCm > 0) {
    history.push(rawCm);
    if (history.length > 3) history.shift(); // keep last 3
  }
  if (history.length === 0) return 0;
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  // Only update if change is > 5cm to reduce jitter
  if (Math.abs(avg - sonarSmoothed[sensor]) > 5 || sonarSmoothed[sensor] === 0) {
    sonarSmoothed[sensor] = avg;
  }
  return sonarSmoothed[sensor];
}

// Update individual sonar sensor display
function updateSonarDisplay(sensor, distCm) {
  const labelEl = document.getElementById('dist' + sensor);
  const waveEl = document.getElementById('sonar' + sensor);
  if (!labelEl || !waveEl) return;

  // Smooth the reading to reduce jitter
  distCm = smoothReading(sensor, distCm);

  // Convert cm to feet for display (1 decimal for readability)
  let distFt = distCm > 0 ? (distCm / 30.48).toFixed(1) : '--';
  labelEl.textContent = distFt + 'ft';

  // Mark as active (receiving data) - waves will animate
  waveEl.classList.add('active');

  // Clear previous timeout and set new one to remove active after 2s of no data
  if (sonarTimeouts[sensor]) clearTimeout(sonarTimeouts[sensor]);
  sonarTimeouts[sensor] = setTimeout(() => {
    waveEl.classList.remove('active');
    labelEl.textContent = '-- ft';
  }, 2000);

  // Get all waves in this sensor group
  const waves = waveEl.querySelectorAll('.sonar-wave');

  // Remove all color classes from waves first
  waves.forEach(w => {
    w.classList.remove('triggered', 'color-red', 'color-pink', 'color-orange', 'color-yellow');
  });

  // If object detected, trigger waves up to that distance with appropriate color
  if (distCm > 0 && distCm < 160) {  // Any reading within 5ft
    // Determine color based on distance
    let colorClass = '';
    if (distCm < 45) colorClass = 'color-red';         // <1.5ft
    else if (distCm < 75) colorClass = 'color-pink';   // 1.5-2.5ft
    else if (distCm < 105) colorClass = 'color-orange'; // 2.5-3.5ft
    else colorClass = 'color-yellow';                   // 3.5ft+

    // Each wave = 0.5ft = 15.24cm
    let triggerUpTo = Math.ceil(distCm / 15.24);
    if (triggerUpTo > 10) triggerUpTo = 10;
    if (triggerUpTo < 1) triggerUpTo = 1;

    // Add triggered + color class to waves
    for (let i = 1; i <= triggerUpTo; i++) {
      const wave = waveEl.querySelector('.w' + i);
      if (wave) {
        wave.classList.add('triggered', colorClass);
      }
    }
  }

  // Update position class (preserve active class)
  const posMap = { FL: 'front-left', FR: 'front-right', RL: 'rear-left', RR: 'rear-right' };
  waveEl.className = 'sonar-wave-group ' + posMap[sensor] + ' active';

  // Update label color based on closest detection
  let labelColor = '';
  if (distCm <= 0) labelColor = '';
  else if (distCm < 60) labelColor = 'danger';
  else if (distCm < 120) labelColor = 'warning';
  else labelColor = 'clear';
  labelEl.className = 'sonar-dist-label ' + posMap[sensor] + '-label' + (labelColor ? ' ' + labelColor : '');

  // Update bar graph
  const barEl = document.getElementById('bar' + sensor);
  const readingEl = document.getElementById('reading' + sensor);
  if (barEl && readingEl) {
    // Max range is 600cm (~20ft), scale bar width accordingly
    const maxCm = 600;
    const pct = distCm > 0 ? Math.min((distCm / maxCm) * 100, 100) : 0;
    barEl.style.width = pct + '%';

    // Color the bar based on distance
    if (distCm <= 0) {
      barEl.style.background = 'rgba(100,100,100,0.3)';
      barEl.style.borderColor = '#666';
      barEl.style.boxShadow = 'none';
    } else if (distCm < 60) {
      barEl.style.background = 'linear-gradient(to top, #f33, rgba(255,50,50,0.3))';
      barEl.style.borderColor = '#f33';
      barEl.style.boxShadow = '0 0 8px #f33';
    } else if (distCm < 150) {
      barEl.style.background = 'linear-gradient(to top, #fc0, rgba(255,200,0,0.3))';
      barEl.style.borderColor = '#fc0';
      barEl.style.boxShadow = '0 0 8px #fc0';
    } else {
      barEl.style.background = 'linear-gradient(to top, #0c6, rgba(0,200,100,0.3))';
      barEl.style.borderColor = '#0c6';
      barEl.style.boxShadow = '0 0 8px #0c6';
    }

    // Show reading
    readingEl.textContent = distCm > 0 ? (distCm / 30.48).toFixed(1) + 'ft' : '--';
  }

}

// ============ LIDAR DISPLAY ============
let lidarCanvas = null;
let lidarCtx = null;
let lidarLastPoints = [];

function initLidarCanvas() {
  lidarCanvas = document.getElementById('lidarCanvas');
  if (!lidarCanvas) return false;

  // Match canvas size to container
  const container = lidarCanvas.parentElement;
  lidarCanvas.width = container.offsetWidth;
  lidarCanvas.height = container.offsetHeight;
  lidarCtx = lidarCanvas.getContext('2d');
  return true;
}

function drawLidarPoints(points) {
  if (!lidarCtx && !initLidarCanvas()) return;
  if (!points || points.length === 0) return;

  // Resize canvas if needed
  const container = lidarCanvas.parentElement;
  if (lidarCanvas.width !== container.offsetWidth || lidarCanvas.height !== container.offsetHeight) {
    lidarCanvas.width = container.offsetWidth;
    lidarCanvas.height = container.offsetHeight;
  }

  const ctx = lidarCtx;
  const w = lidarCanvas.width;
  const h = lidarCanvas.height;
  const cx = w / 2;
  const cy = h / 2;

  // Scale: 5ft (1524mm) = half the display
  const scale = Math.min(w, h) / 2 / 1800;  // 1.8m radius visible

  // Clear canvas
  ctx.clearRect(0, 0, w, h);

  // Draw lidar points
  ctx.beginPath();
  let prevX = null, prevY = null;

  // Sort by angle for connected drawing
  points.sort((a, b) => a[0] - b[0]);

  for (const [angle, dist] of points) {
    // Convert to screen coords (0 = front = up)
    const rad = (angle - 90) * Math.PI / 180;
    const x = cx + dist * scale * Math.cos(rad);
    const y = cy + dist * scale * Math.sin(rad);

    // Color by distance
    let color;
    if (dist < 500) {
      color = '#ff3030';  // Red - close
    } else if (dist < 1000) {
      color = '#ff8c00';  // Orange
    } else if (dist < 2000) {
      color = '#ffdc00';  // Yellow
    } else {
      color = '#00dd66';  // Green - far
    }

    // Draw point
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Connect nearby points to show walls
    if (prevX !== null) {
      const dx = x - prevX;
      const dy = y - prevY;
      if (Math.sqrt(dx*dx + dy*dy) < 25) {
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    prevX = x;
    prevY = y;
  }

  // Store for sensor agreement checking
  lidarLastPoints = points;

  // Check sensor agreement with ultrasonic
  checkSensorAgreement();
}

// Check if lidar and sonar agree on objects in same direction
function checkSensorAgreement() {
  const container = document.querySelector('.sonar-robot-container');
  if (!container) return;

  // Remove old agreement markers
  container.querySelectorAll('.sensor-agreement').forEach(el => el.remove());

  // Directions and their angle ranges
  const directions = {
    FL: { minAngle: 300, maxAngle: 360, altMin: 0, altMax: 45 },
    FR: { minAngle: 45, maxAngle: 90 },
    RL: { minAngle: 180, maxAngle: 225 },
    RR: { minAngle: 135, maxAngle: 180 }
  };

  for (const [sensor, range] of Object.entries(directions)) {
    const sonarDist = sonarSmoothed[sensor];
    if (sonarDist <= 0) continue;

    // Find lidar points in this direction
    const sonarDistMm = sonarDist * 10;  // cm to mm
    let foundAgreement = false;

    for (const [angle, dist] of lidarLastPoints) {
      const inRange = (angle >= range.minAngle && angle <= range.maxAngle) ||
                      (range.altMin !== undefined && angle >= range.altMin && angle <= range.altMax);
      if (!inRange) continue;

      // Check if distances agree (within 30cm)
      if (Math.abs(dist - sonarDistMm) < 300) {
        foundAgreement = true;
        break;
      }
    }

    if (foundAgreement && sonarDist < 150) {  // Only highlight close objects
      // Add pulsing agreement marker
      const marker = document.createElement('div');
      marker.className = 'sensor-agreement';

      // Position based on sensor location
      const posMap = {
        FL: { top: '25%', left: '35%' },
        FR: { top: '25%', left: '65%' },
        RL: { top: '75%', left: '35%' },
        RR: { top: '75%', left: '65%' }
      };
      const pos = posMap[sensor];
      marker.style.top = pos.top;
      marker.style.left = pos.left;
      marker.style.width = '30px';
      marker.style.height = '30px';

      container.appendChild(marker);
    }
  }
}

