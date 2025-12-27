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
  // Mobile status
  const mobileJetson = document.getElementById('mobileJetson');
  if (mobileJetson) mobileJetson.className = 'mobile-dev' + (online ? ' online' : '');
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
    updateLidar3D(d.points);  // Use 3D visualization
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
    // Mobile status
    const mobileEsp = document.getElementById('mobileEsp32');
    if (mobileEsp) mobileEsp.className = 'mobile-dev' + (d.connected ? ' online' : '');

    // Update Teensy status card
    if(d.teensyConnected !== undefined) {
      document.getElementById('teensyStatus').textContent = d.teensyConnected ? 'Online' : 'Offline';
      document.getElementById('teensyCard').className = 'device-chip' + (d.teensyConnected ? ' online' : '');
      // Mobile status
      const mobileTeensy = document.getElementById('mobileTeensy');
      if (mobileTeensy) mobileTeensy.className = 'mobile-dev' + (d.teensyConnected ? ' online' : '');
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

  // Also update 3D view ultrasonic badges
  updateUltrasonicBadges('FL', fl);
  updateUltrasonicBadges('FR', fr);
  updateUltrasonicBadges('RL', rl);
  updateUltrasonicBadges('RR', rr);

  // Update 3D ultrasonic cones
  updateUltrasonic3D('FL', fl);
  updateUltrasonic3D('FR', fr);
  updateUltrasonic3D('RL', rl);
  updateUltrasonic3D('RR', rr);
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

// ============ LIDAR THERMAL MAP DISPLAY ============
let lidarCanvas = null;
let lidarCtx = null;
let lidarLastPoints = [];
let lidarHistory = [];  // Keep last few frames for smoothing
const LIDAR_HISTORY_SIZE = 3;

function initLidarCanvas() {
  lidarCanvas = document.getElementById('lidarCanvas');
  if (!lidarCanvas) return false;

  const container = lidarCanvas.parentElement;
  // Use 2x resolution for crisp rendering
  const dpr = window.devicePixelRatio || 1;
  lidarCanvas.width = container.offsetWidth * dpr;
  lidarCanvas.height = container.offsetHeight * dpr;
  lidarCanvas.style.width = container.offsetWidth + 'px';
  lidarCanvas.style.height = container.offsetHeight + 'px';
  lidarCtx = lidarCanvas.getContext('2d');
  lidarCtx.scale(dpr, dpr);
  return true;
}

// Thermal color gradient - like infrared camera
function getThermalColor(dist, maxDist) {
  const ratio = Math.min(dist / maxDist, 1);
  // Infrared palette: white (hot/close) -> yellow -> orange -> red -> purple -> blue -> black (cold/far)
  if (ratio < 0.15) {
    // Very close - bright white/yellow (HOT)
    const t = ratio / 0.15;
    return `rgb(255, ${Math.floor(255 - t * 30)}, ${Math.floor(255 - t * 200)})`;
  } else if (ratio < 0.3) {
    // Close - orange/red
    const t = (ratio - 0.15) / 0.15;
    return `rgb(255, ${Math.floor(225 - t * 150)}, ${Math.floor(55 - t * 55)})`;
  } else if (ratio < 0.5) {
    // Medium - red to magenta
    const t = (ratio - 0.3) / 0.2;
    return `rgb(${Math.floor(255 - t * 50)}, ${Math.floor(75 - t * 75)}, ${Math.floor(t * 150)})`;
  } else if (ratio < 0.7) {
    // Far - purple to blue
    const t = (ratio - 0.5) / 0.2;
    return `rgb(${Math.floor(205 - t * 155)}, 0, ${Math.floor(150 + t * 105)})`;
  } else {
    // Very far - dark blue to near black (COLD)
    const t = (ratio - 0.7) / 0.3;
    return `rgb(${Math.floor(50 - t * 40)}, 0, ${Math.floor(255 - t * 200)})`;
  }
}

function drawLidarPoints(points) {
  if (!lidarCtx && !initLidarCanvas()) return;
  if (!points || points.length === 0) return;

  // Resize canvas if needed
  const container = lidarCanvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = container.offsetWidth;
  const h = container.offsetHeight;

  if (Math.abs(lidarCanvas.width - w * dpr) > 5) {
    lidarCanvas.width = w * dpr;
    lidarCanvas.height = h * dpr;
    lidarCanvas.style.width = w + 'px';
    lidarCanvas.style.height = h + 'px';
    lidarCtx.scale(dpr, dpr);
  }

  const ctx = lidarCtx;
  const cx = w / 2;
  const cy = h / 2;

  // Scale: 2.5m radius visible (about 8ft)
  const maxDist = 2500;  // mm
  const scale = Math.min(w, h) / 2 / maxDist * 0.9;

  // Add to history for smoothing
  lidarHistory.push(points);
  if (lidarHistory.length > LIDAR_HISTORY_SIZE) lidarHistory.shift();

  // Merge recent frames
  const mergedPoints = [];
  const angleMap = new Map();
  for (const frame of lidarHistory) {
    for (const [angle, dist] of frame) {
      const key = Math.round(angle);
      if (!angleMap.has(key) || dist < angleMap.get(key)) {
        angleMap.set(key, dist);
      }
    }
  }
  angleMap.forEach((dist, angle) => mergedPoints.push([angle, dist]));
  mergedPoints.sort((a, b) => a[0] - b[0]);

  // Clear canvas (transparent)
  ctx.clearRect(0, 0, w, h);

  // ============ DRAW LIDAR POINTS AND WALLS ============
  if (mergedPoints.length > 2) {
    // First pass: draw wall lines connecting nearby points
    ctx.beginPath();
    let firstPoint = true;
    let lastX, lastY, lastDist;

    for (let i = 0; i < mergedPoints.length; i++) {
      const [angle, dist] = mergedPoints[i];
      const rad = (angle - 90) * Math.PI / 180;
      const x = cx + dist * scale * Math.cos(rad);
      const y = cy + dist * scale * Math.sin(rad);

      if (firstPoint) {
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        // Check if this is a continuous wall or a gap
        const dx = x - lastX;
        const dy = y - lastY;
        const screenDist = Math.sqrt(dx*dx + dy*dy);

        if (screenDist < 40) {
          ctx.lineTo(x, y);
        } else {
          // Gap - start new path segment
          ctx.moveTo(x, y);
        }
      }
      lastX = x;
      lastY = y;
      lastDist = dist;
    }

    // Thick glowing wall line
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.9)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#00ffc8';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ============ DRAW COLORED POINTS ============
    for (const [angle, dist] of mergedPoints) {
      const rad = (angle - 90) * Math.PI / 180;
      const x = cx + dist * scale * Math.cos(rad);
      const y = cy + dist * scale * Math.sin(rad);

      // Color by distance - thermal style
      let color, glowColor;
      if (dist < 400) {
        color = '#ff3030';  // Red - very close
        glowColor = 'rgba(255, 50, 50, 0.8)';
      } else if (dist < 800) {
        color = '#ff8800';  // Orange - close
        glowColor = 'rgba(255, 136, 0, 0.6)';
      } else if (dist < 1200) {
        color = '#ffcc00';  // Yellow - medium
        glowColor = 'rgba(255, 200, 0, 0.4)';
      } else if (dist < 1800) {
        color = '#00dd66';  // Green - far
        glowColor = 'rgba(0, 220, 100, 0.3)';
      } else {
        color = '#00aaff';  // Blue - very far
        glowColor = 'rgba(0, 170, 255, 0.2)';
      }

      // Draw glowing point
      ctx.beginPath();
      ctx.arc(x, y, dist < 600 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = dist < 600 ? 10 : 5;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Extra highlight for danger zone
      if (dist < 500) {
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 50, 50, 0.3)';
        ctx.fill();
      }
    }
  }

  // Store for sensor agreement checking
  lidarLastPoints = mergedPoints;

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

// ============ INTEGRATED 3D LIDAR VIEW ============
let lidar3dScene, lidar3dCamera, lidar3dRenderer, lidar3dControls;
let lidar3dRobot, lidar3dWalls = [], lidar3dPointCloud;
let lidar3dPositionTrail = [];
let lidar3dTrailLine = null;
let lidar3dTrailGeom = null;
let lidar3dInitialized = false;
let lidar3dFrameCount = 0;
let lidar3dGrid = null;

// Ultrasonic sensor cones in 3D view
let lidar3dUltrasonicCones = { FL: null, FR: null, RL: null, RR: null };

// World container - moves under robot (robot stays centered)
let lidar3dWorldContainer = null;

// SLAM-style accumulated map
let lidar3dSlamPoints = [];  // Accumulated world-space points
let lidar3dSlamCloud = null;  // Three.js point cloud for SLAM map
let lidar3dLastRobotPos = { x: 0, y: 0, heading: 0 };
const SLAM_MAX_POINTS = 50000;  // Limit for performance
const SLAM_POINT_SPACING = 0.03;  // Minimum distance between stored points (meters)

// Clear SLAM map (called from reset button)
window.clearLidarSlamMap = function() {
  lidar3dSlamPoints = [];
  lidar3dPositionTrail = [];
  if (lidar3dTrailGeom) {
    lidar3dTrailGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  }
  if (lidar3dSlamCloud) {
    lidar3dSlamCloud.geometry.dispose();
    lidar3dSlamCloud.geometry = new THREE.BufferGeometry();
  }
  // Reset world container position (robot stays at center)
  if (lidar3dWorldContainer) {
    lidar3dWorldContainer.position.set(0, 0, 0);
    lidar3dWorldContainer.rotation.y = 0;
  }
  console.log('[SLAM] Map cleared');
};

function initLidar3D() {
  const container = document.getElementById('lidar3dContainer');
  if (!container || lidar3dInitialized) return;

  // Scene
  lidar3dScene = new THREE.Scene();
  lidar3dScene.background = new THREE.Color(0x0a0a12);
  lidar3dScene.fog = new THREE.Fog(0x0a0a12, 6, 15);

  // Camera
  const w = container.clientWidth;
  const h = container.clientHeight;
  lidar3dCamera = new THREE.PerspectiveCamera(55, w / h, 0.1, 50);
  lidar3dCamera.position.set(3, 4, 3);
  lidar3dCamera.lookAt(0, 0, 0);

  // Renderer
  lidar3dRenderer = new THREE.WebGLRenderer({ antialias: true });
  lidar3dRenderer.setSize(w, h);
  lidar3dRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.insertBefore(lidar3dRenderer.domElement, container.firstChild);

  // Controls
  lidar3dControls = new THREE.OrbitControls(lidar3dCamera, lidar3dRenderer.domElement);
  lidar3dControls.enableDamping = true;
  lidar3dControls.dampingFactor = 0.05;
  lidar3dControls.maxPolarAngle = Math.PI / 2.1;
  lidar3dControls.minDistance = 1.5;
  lidar3dControls.maxDistance = 10;

  // Lighting
  lidar3dScene.add(new THREE.AmbientLight(0x404040, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(5, 8, 5);
  lidar3dScene.add(dirLight);

  // DEBUG: Fixed reference grid removed - was for debugging only
  // The cyan grid in worldContainer is the only grid now

  // World container - this moves/rotates while robot stays centered
  lidar3dWorldContainer = new THREE.Group();
  lidar3dScene.add(lidar3dWorldContainer);

  // Grid - each square = 1 sq ft (0.3048m)
  // 30 ft x 30 ft grid = 9.144m, 30 divisions
  const gridSizeFt = 30;
  const gridSizeM = gridSizeFt * 0.3048;  // feet to meters
  lidar3dGrid = new THREE.GridHelper(gridSizeM, gridSizeFt, 0x00ffff, 0x006666);  // Cyan grid
  lidar3dGrid.position.y = 0.005;
  lidar3dWorldContainer.add(lidar3dGrid);

  // Ground (larger) - added to world container
  const groundGeom = new THREE.PlaneGeometry(30, 30);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a1520, transparent: true, opacity: 0.7 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  lidar3dWorldContainer.add(ground);

  // Robot stays at center (0,0,0) - only rotates to show heading
  lidar3dRobot = createRobot3D();
  lidar3dScene.add(lidar3dRobot);  // Added to scene, NOT world container

  // Yellow path trail line - added to world container
  lidar3dTrailGeom = new THREE.BufferGeometry();
  const trailMat = new THREE.LineBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.8,
    linewidth: 3
  });
  lidar3dTrailLine = new THREE.Line(lidar3dTrailGeom, trailMat);
  lidar3dWorldContainer.add(lidar3dTrailLine);

  // SLAM accumulated point cloud (starts empty) - added to world container
  lidar3dSlamCloud = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.04, vertexColors: true, transparent: true, opacity: 0.5 })
  );
  lidar3dWorldContainer.add(lidar3dSlamCloud);

  lidar3dInitialized = true;
  animateLidar3D();
}

function createRobot3D() {
  const group = new THREE.Group();

  // Body
  const bodyGeom = new THREE.BoxGeometry(0.35, 0.2, 0.45);
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x1a5a3a, emissive: 0x0a2a1a });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.12;
  group.add(body);

  // Body edge glow
  const edges = new THREE.EdgesGeometry(bodyGeom);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00ff88 }));
  line.position.y = 0.12;
  group.add(line);

  // Wheels
  const wheelGeom = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12);
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
  [[-0.18, 0.06, 0.15], [0.18, 0.06, 0.15], [-0.18, 0.06, -0.15], [0.18, 0.06, -0.15]].forEach(pos => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(...pos);
    group.add(wheel);
  });

  // Front arrow
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.12);
  arrowShape.lineTo(-0.06, 0);
  arrowShape.lineTo(0.06, 0);
  arrowShape.closePath();
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(arrowShape),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.23, -0.3);
  group.add(arrow);

  // Lidar sensor
  const lidarGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12);
  const lidarMat = new THREE.MeshPhongMaterial({ color: 0x333333, emissive: 0x00ff88, emissiveIntensity: 0.3 });
  const lidar = new THREE.Mesh(lidarGeom, lidarMat);
  lidar.position.y = 0.24;
  group.add(lidar);

  // Ultrasonic sensor cones (FL, FR, RL, RR)
  // JSN-SR04T range: 21-600cm, ~30° beam angle
  const conePositions = {
    FL: { x: -0.12, z: -0.22, rotY: Math.PI * 0.15 },   // Front-left, angled outward
    FR: { x: 0.12, z: -0.22, rotY: -Math.PI * 0.15 },   // Front-right, angled outward
    RL: { x: -0.12, z: 0.22, rotY: Math.PI - Math.PI * 0.15 },  // Rear-left
    RR: { x: 0.12, z: 0.22, rotY: Math.PI + Math.PI * 0.15 }    // Rear-right
  };

  Object.keys(conePositions).forEach(sensor => {
    const pos = conePositions[sensor];
    // Cone: radiusTop, radiusBottom, height, radialSegments
    const coneGeom = new THREE.ConeGeometry(0.15, 0.5, 16, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const cone = new THREE.Mesh(coneGeom, coneMat);
    cone.rotation.x = Math.PI / 2;  // Point forward (along Z)
    cone.rotation.z = pos.rotY;
    cone.position.set(pos.x, 0.1, pos.z);
    cone.visible = false;  // Start hidden, show when data arrives
    cone.userData.sensor = sensor;
    group.add(cone);
    lidar3dUltrasonicCones[sensor] = cone;
  });

  return group;
}

function getDistanceColor3D(dist) {
  if (dist < 400) return new THREE.Color(0xff2020);
  if (dist < 800) return new THREE.Color(0xff8800);
  if (dist < 1200) return new THREE.Color(0xffcc00);
  if (dist < 1800) return new THREE.Color(0x00dd66);
  return new THREE.Color(0x00aaff);
}

// Update ultrasonic cone in 3D view
function updateUltrasonic3D(sensor, distCm) {
  const cone = lidar3dUltrasonicCones[sensor];
  if (!cone) return;

  // Hide if no valid reading
  if (distCm <= 0 || distCm > 600) {
    cone.visible = false;
    return;
  }

  cone.visible = true;

  // Scale cone length based on distance (max 6m = 600cm)
  // Convert cm to meters, scale to reasonable visual size
  const distM = distCm / 100;
  const coneLength = Math.min(distM * 0.8, 4);  // Cap at 4m visual
  const coneRadius = 0.08 + (distM * 0.05);  // Wider at longer distances

  // Update cone geometry scale
  cone.scale.set(coneRadius / 0.15, coneLength / 0.5, coneRadius / 0.15);

  // Color based on distance (red=close, yellow=mid, cyan=far)
  let color;
  if (distCm < 50) {
    color = 0xff0000;  // Red - danger close
  } else if (distCm < 100) {
    color = 0xff8800;  // Orange - caution
  } else if (distCm < 200) {
    color = 0xffff00;  // Yellow - attention
  } else {
    color = 0x00ffff;  // Cyan - clear
  }
  cone.material.color.setHex(color);

  // Opacity based on distance (more visible when close)
  cone.material.opacity = distCm < 100 ? 0.5 : 0.25;
}

function updateLidar3D(points) {
  if (!lidar3dInitialized) initLidar3D();
  if (!lidar3dScene) return;

  lidar3dFrameCount++;
  document.getElementById('lidar3dStatus').textContent = 'LIDAR: ' + points.length + ' pts';

  // Get current robot position from odometry (from telemetry.js odomState)
  const robotX = (typeof odomState !== 'undefined' && odomState.x) ? odomState.x / 1000 : 0;  // mm to meters
  const robotZ = (typeof odomState !== 'undefined' && odomState.y) ? odomState.y / 1000 : 0;  // y is forward = z in 3D
  const robotHeading = (typeof odomState !== 'undefined' && odomState.heading) ? odomState.heading : 0;

  // ROBOT-CENTERED VIEW: Robot stays at origin, world moves under it
  if (lidar3dRobot) {
    // Robot stays at center, only rotates to show current heading
    lidar3dRobot.position.set(0, 0, 0);
    lidar3dRobot.rotation.y = 0;  // Robot always points "up" in view, world rotates
  }

  // Move world container in opposite direction - robot appears stationary
  if (lidar3dWorldContainer) {
    lidar3dWorldContainer.position.x = -robotX;
    lidar3dWorldContainer.position.z = robotZ;
    lidar3dWorldContainer.rotation.y = robotHeading;
  }

  // Update yellow path trail (in world coordinates)
  if (typeof odomState !== 'undefined' && odomState.trail && odomState.trail.length > 0) {
    const trailPositions = [];
    odomState.trail.forEach(p => {
      trailPositions.push(p.x / 1000, 0.05, -p.y / 1000);  // mm to meters, slight Y offset
    });
    // Add current position
    trailPositions.push(robotX, 0.05, -robotZ);

    if (lidar3dTrailGeom) {
      lidar3dTrailGeom.setAttribute('position', new THREE.Float32BufferAttribute(trailPositions, 3));
      lidar3dTrailGeom.attributes.position.needsUpdate = true;
    }
  }

  // Clear old walls and point cloud
  lidar3dWalls.forEach(m => {
    if (m.parent) m.parent.remove(m);
  });
  lidar3dWalls = [];
  if (lidar3dPointCloud && lidar3dPointCloud.parent) {
    lidar3dPointCloud.parent.remove(lidar3dPointCloud);
  }

  points.sort((a, b) => a[0] - b[0]);

  // Current scan positions (relative to robot at center)
  const positions = [], colors = [];
  // SLAM: accumulate in absolute world coordinates
  const slamNewPoints = [];

  for (const [angle, dist] of points) {
    // Local coordinates (relative to robot facing forward)
    // LIDAR 0° = front of robot = -Z in Three.js
    const rad = (angle - 90) * Math.PI / 180;  // Flipped back
    const localX = (dist / 1000) * Math.cos(rad);
    const localZ = (dist / 1000) * Math.sin(rad);

    // Current scan: show relative to robot (robot is at origin, points around it)
    positions.push(localX, 0.24, localZ);  // No negation needed now
    const c = getDistanceColor3D(dist);
    colors.push(c.r, c.g, c.b);

    // SLAM: Transform to world coordinates (absolute position in world)
    const worldX = robotX + localX * Math.cos(robotHeading) - localZ * Math.sin(robotHeading);
    const worldZ = -robotZ + localX * Math.sin(robotHeading) + localZ * Math.cos(robotHeading);

    // Add to SLAM accumulator (with spacing check)
    if (dist > 100 && dist < 5000) {  // Only valid range points
      slamNewPoints.push({ x: worldX, z: worldZ, color: c });
    }
  }

  // Add new SLAM points (with spacing filter)
  for (const np of slamNewPoints) {
    let tooClose = false;
    // Check distance to recent points only (for performance)
    const checkStart = Math.max(0, lidar3dSlamPoints.length - 500);
    for (let i = checkStart; i < lidar3dSlamPoints.length; i++) {
      const sp = lidar3dSlamPoints[i];
      const dx = np.x - sp.x, dz = np.z - sp.z;
      if (dx*dx + dz*dz < SLAM_POINT_SPACING * SLAM_POINT_SPACING) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      lidar3dSlamPoints.push(np);
    }
  }

  // Trim SLAM points if too many
  while (lidar3dSlamPoints.length > SLAM_MAX_POINTS) {
    lidar3dSlamPoints.shift();
  }

  // Update SLAM point cloud visualization
  if (lidar3dSlamCloud && lidar3dSlamPoints.length > 0) {
    const slamPos = [], slamCol = [];
    for (const sp of lidar3dSlamPoints) {
      slamPos.push(sp.x, 0.01, sp.z);  // Ground level
      slamCol.push(sp.color.r * 0.6, sp.color.g * 0.6, sp.color.b * 0.6);  // Dimmer
    }
    const slamGeom = new THREE.BufferGeometry();
    slamGeom.setAttribute('position', new THREE.Float32BufferAttribute(slamPos, 3));
    slamGeom.setAttribute('color', new THREE.Float32BufferAttribute(slamCol, 3));
    lidar3dSlamCloud.geometry.dispose();
    lidar3dSlamCloud.geometry = slamGeom;
  }

  // Current scan point cloud - added to scene (relative to robot at center)
  const pointGeom = new THREE.BufferGeometry();
  pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  pointGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  lidar3dPointCloud = new THREE.Points(pointGeom, new THREE.PointsMaterial({ size: 0.06, vertexColors: true }));
  lidar3dScene.add(lidar3dPointCloud);  // Scene, not world container - stays with robot

  // Walls (relative to robot at center)
  for (let i = 0; i < points.length - 1; i++) {
    const [a1, d1] = points[i], [a2, d2] = points[i + 1];
    let diff = a2 - a1; if (diff < 0) diff += 360;
    if (diff > 6) continue;

    const r1 = (a1 - 90) * Math.PI / 180, r2 = (a2 - 90) * Math.PI / 180;
    const x1 = (d1 / 1000) * Math.cos(r1), z1 = (d1 / 1000) * Math.sin(r1);
    const x2 = (d2 / 1000) * Math.cos(r2), z2 = (d2 / 1000) * Math.sin(r2);

    const wallH = 0.6;
    const wallGeom = new THREE.BufferGeometry();
    wallGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      x1, 0, z1, x2, 0, z2, x2, wallH, z2, x1, 0, z1, x2, wallH, z2, x1, wallH, z1
    ]), 3));
    wallGeom.computeVertexNormals();

    const wallMat = new THREE.MeshBasicMaterial({
      color: getDistanceColor3D((d1 + d2) / 2),
      transparent: true, opacity: 0.35, side: THREE.DoubleSide
    });
    const wall = new THREE.Mesh(wallGeom, wallMat);
    lidar3dScene.add(wall);  // Scene, stays with robot
    lidar3dWalls.push(wall);

    // Top edge
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x1, wallH, z1, x2, wallH, z2]), 3));
    const edge = new THREE.Line(edgeGeom, new THREE.LineBasicMaterial({ color: getDistanceColor3D((d1 + d2) / 2) }));
    lidar3dScene.add(edge);  // Scene, stays with robot
    lidar3dWalls.push(edge);
  }
}

function animateLidar3D() {
  if (!lidar3dInitialized) return;
  requestAnimationFrame(animateLidar3D);
  lidar3dControls.update();
  lidar3dRenderer.render(lidar3dScene, lidar3dCamera);
}

// Update ultrasonic badges
function updateUltrasonicBadges(sensor, distCm) {
  const badge = document.getElementById('usBadge' + sensor);
  if (!badge) return;
  const ft = distCm > 0 ? (distCm / 30.48).toFixed(1) : '--';
  badge.textContent = sensor + ': ' + ft + 'ft';
  badge.classList.remove('danger', 'warning');
  if (distCm > 0 && distCm < 50) badge.classList.add('danger');
  else if (distCm > 0 && distCm < 100) badge.classList.add('warning');
}

// Update position badge
function updatePositionBadge(x, y) {
  const badge = document.getElementById('posBadge');
  if (badge) badge.textContent = 'X: ' + x.toFixed(1) + ' Y: ' + y.toFixed(1);
}

// Fullscreen toggle
function toggleLidar3DFullscreen() {
  const container = document.querySelector('.light-cam-wide');
  if (container) {
    container.classList.toggle('lidar3d-fullscreen');
    setTimeout(() => {
      if (lidar3dRenderer && lidar3dCamera) {
        const c = document.getElementById('lidar3dContainer');
        lidar3dRenderer.setSize(c.clientWidth, c.clientHeight);
        lidar3dCamera.aspect = c.clientWidth / c.clientHeight;
        lidar3dCamera.updateProjectionMatrix();
      }
    }, 100);
  }
}

// Handle resize
window.addEventListener('resize', () => {
  if (lidar3dRenderer && lidar3dCamera && lidar3dInitialized) {
    const c = document.getElementById('lidar3dContainer');
    if (c) {
      lidar3dRenderer.setSize(c.clientWidth, c.clientHeight);
      lidar3dCamera.aspect = c.clientWidth / c.clientHeight;
      lidar3dCamera.updateProjectionMatrix();
    }
  }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', initLidar3D);
setTimeout(initLidar3D, 500);

