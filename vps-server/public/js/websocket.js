// ============ WEBSOCKET MESSAGE ROUTER ============
// Main WebSocket connection and message routing to modules
// v51 - Modular architecture

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
console.log('[WS] Creating WebSocket to:', wsProtocol + '//' + location.host);
const ws = new WebSocket(wsProtocol + '//' + location.host);
ws.binaryType = 'arraybuffer';
// Make ws globally accessible for inline scripts
window.ws = ws;
console.log('[WS] window.ws set:', window.ws);

// ============ MESSAGE HANDLER ============
ws.onopen = () => {
  // IMPORTANT: Identify as browser so server knows to send us broadcasts
  ws.send(JSON.stringify({ type: 'browser_hello' }));
  ws.send(JSON.stringify({ type: 'get_status' }));
  console.log('[WS] Connected and identified as browser');
  setTimeout(() => {
    if (window.camerasPtzModule && !window.camerasPtzModule.getCam1Active()) {
      window.camerasPtzModule.initCam1();
    }
  }, 1000);
  // Request semantic map data on connection (maps visible in all modes)
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'semantic_map_request' }));
    ws.send(JSON.stringify({ type: 'lookable_targets_request' }));
  }, 2000);
  // Send detection settings on startup (default: indoor filter, 5% confidence)
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'detection_settings',
      filter_mode: 'indoor',
      confidence: 0.05
    }));
    console.log('[DETECTION] Sent startup settings: indoor filter, 5% confidence');
  }, 1500);
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
    handleDetections(d.camera, d.detections, d.timestamp);
  }

  // Depth frames from Mac Mini processor
  if (d.type === 'depth_frame') {
    displayDepthFrame(d.camera, d.frame);
  }

  // ============ FINGERPRINT & 3D MAP PERSISTENCE ============
  // Receive saved fingerprints from server on connect
  if (d.type === 'saved_fingerprints') {
    if (window.lidar3dModule && window.lidar3dModule.handleSavedFingerprints) {
      window.lidar3dModule.handleSavedFingerprints(d.fingerprints);
    }
  }

  // Fingerprint saved confirmation
  if (d.type === 'fingerprint_saved') {
    console.log(`[FINGERPRINT] Saved to server: ${d.name}`);
  }

  // 3D map saved confirmation
  if (d.type === 'map_saved') {
    console.log(`[3D MAP] Saved to server: ${d.name}`);
  }

  // Loaded 3D map from server (when area recognized)
  if (d.type === 'loaded_3d_map') {
    console.log(`[3D MAP] Received from server: ${d.name}`);
    if (window.lidar3dModule && window.lidar3dModule.handleLoaded3DMap) {
      window.lidar3dModule.handleLoaded3DMap(d.name, d.mapData);
    }
  }

  // Failed to load 3D map
  if (d.type === 'load_3d_map_failed') {
    console.log(`[3D MAP] Not found on server: ${d.name}`);
  }

  // Autonomous mapping errors (only show if robot not connected)
  if (d.type === 'autonomous_error') {
    console.error('[AUTONOMOUS] Error:', d.error);
    alert('MAP MODE ERROR: ' + d.error);
    // Reset the MAP button UI
    if (typeof mapModeActive !== 'undefined') {
      mapModeActive = false;
      const btn = document.getElementById('mapModeBtn');
      if (btn) {
        btn.style.background = 'rgba(20,40,60,0.8)';
        btn.style.color = '#5af';
        btn.innerHTML = '🗺️ MAP';
      }
    }
  }

  // Autonomous status updates
  if (d.type === 'autonomous_status') {
    console.log('[AUTONOMOUS] Status:', d);
    const btn = document.getElementById('mapModeBtn');
    const status = document.getElementById('mapModeStatus');
    const statusText = document.getElementById('mapStatusText');
    const slamStats = document.getElementById('slamMapStats');

    if (d.running !== undefined) {
      // Update the global mapModeActive variable
      if (typeof mapModeActive !== 'undefined') {
        mapModeActive = d.running;
      }

      // Update MAP button appearance
      if (btn) {
        if (d.running) {
          btn.style.background = 'rgba(90,170,255,0.9)';
          btn.style.color = '#000';
          btn.style.borderColor = '#5af';
          btn.innerHTML = '🗺️ AUTO';
        } else {
          btn.style.background = 'rgba(20,40,60,0.8)';
          btn.style.color = '#5af';
          btn.style.borderColor = 'rgba(90,170,255,0.5)';
          btn.innerHTML = '🗺️ MAP';
        }
      }

      // Update status text
      if (status && statusText) {
        status.style.display = d.running ? 'block' : 'none';
        if (d.running) {
          statusText.textContent = d.mode === 'direct' ? 'Mapping (direct)' : 'Mapping';
          statusText.style.color = d.mode === 'direct' ? '#fc0' : '#5af';
        }
      }
    }
  }

  // Indoor SLAM map status updates
  if (d.type === 'map_status') {
    // Update map status display
    const mapStatic = document.getElementById('mapStaticCells');
    const mapTotal = document.getElementById('mapTotalCells');
    const mapCoverage = document.getElementById('mapCoverage');
    const mapPosX = document.getElementById('mapPosX');
    const mapPosY = document.getElementById('mapPosY');
    const mapHeading = document.getElementById('mapHeading');

    if (mapStatic) mapStatic.textContent = d.static_cells || 0;
    if (mapTotal) mapTotal.textContent = d.total_cells || 0;
    if (mapCoverage) mapCoverage.textContent = (d.map_coverage || 0).toFixed(1) + ' m²';
    if (mapPosX) mapPosX.textContent = ((d.robot_x || 0) / 100).toFixed(2) + 'm';
    if (mapPosY) mapPosY.textContent = ((d.robot_y || 0) / 100).toFixed(2) + 'm';
    if (mapHeading) mapHeading.textContent = (d.robot_heading || 0).toFixed(0) + '°';

    // Store for 3D visualization
    window.slamMapStatus = d;
  }

  // Map cells for 3D visualization
  if (d.type === 'map_cells') {
    // Pass to lidar3d module for rendering
    if (window.lidar3dModule && window.lidar3dModule.updateMapCells) {
      window.lidar3dModule.updateMapCells(d);
    }
  }

  // Visual mapping scan progress
  if (d.type === 'visual_scan_progress') {
    const progress = document.getElementById('visualScanProgress');
    const bar = document.getElementById('visualScanBar');
    if (progress) progress.style.display = 'block';
    if (bar) bar.style.width = `${(d.angle / d.total_angles) * 100}%`;
    console.log(`[VISUAL] Scan progress: ${d.angle}° / ${d.total_angles}°`);
  }

  // Visual mapping scan complete
  if (d.type === 'visual_scan_complete') {
    const progress = document.getElementById('visualScanProgress');
    const panorama = document.getElementById('visualPanorama');
    const panoramaImg = document.getElementById('visualPanoramaImg');

    if (progress) progress.style.display = 'none';
    if (panorama && d.thumbnail) {
      panorama.style.display = 'block';
      if (panoramaImg) panoramaImg.src = 'data:image/jpeg;base64,' + d.thumbnail;
    }
    console.log(`[VISUAL] Scan complete: ${d.frames_count} frames`);
  }

  // Visual map data
  if (d.type === 'visual_map_data') {
    window.visualMapData = d;
    console.log(`[VISUAL] Received map with ${d.panoramas?.length || 0} panoramas`);
  }

  // Robot Agent chat replies
  if (d.type === 'agent_reply' && window.handleAgentReply) {
    window.handleAgentReply(d);
  }

  // Robot Brain responses
  if (d.type === 'brain_status' && window.handleBrainStatus) {
    window.handleBrainStatus(d);
  }
  if (d.type === 'brain_result' && window.handleBrainResult) {
    window.handleBrainResult(d);
  }

  // Scene recognition result
  if (d.type === 'scene_recognition_result') {
    const indicator = document.getElementById('sceneRecognition');
    if (indicator) {
      if (d.recognized) {
        indicator.innerHTML = `🧠 <span style="color:#0f8">RECOGNIZED</span> ${(d.confidence * 100).toFixed(0)}%`;
      } else {
        indicator.innerHTML = `🧠 <span style="color:#888">New location</span>`;
      }
    }
  }

  // ==================== SEMANTIC MAP MESSAGES ====================

  // Full semantic map data
  if (d.type === 'semantic_map_data') {
    window.semanticMapData = d;
    console.log(`[SEMANTIC] Received map with ${d.zones?.length || 0} zones, ${d.objects?.length || 0} objects`);

    // Update stats
    if (typeof updateSemanticStats === 'function') {
      updateSemanticStats(d);
    }

    // Update zones list
    if (d.zones && typeof updateZonesList === 'function') {
      updateZonesList(d.zones);
    }
  }

  // Lookable targets list
  if (d.type === 'lookable_targets') {
    window.lookableTargets = d.targets || [];
    console.log(`[SEMANTIC] Received ${d.targets?.length || 0} lookable targets`);

    // Update dropdown
    if (typeof updateLookAtDropdown === 'function') {
      updateLookAtDropdown(d.targets || []);
    }
  }

  // Zone created
  if (d.type === 'zone_created' || d.type === 'semantic_zone_created') {
    console.log(`[SEMANTIC] Zone created: ${d.zone?.name}`);
    // Refresh the full map data
    if (typeof requestSemanticMap === 'function') {
      setTimeout(requestSemanticMap, 500);
    }
    if (typeof requestLookableTargets === 'function') {
      setTimeout(requestLookableTargets, 600);
    }
  }

  // Zone deleted
  if (d.type === 'semantic_zone_deleted') {
    console.log(`[SEMANTIC] Zone deleted: ${d.zone_id}`);
    // Refresh the full map data
    if (typeof requestSemanticMap === 'function') {
      setTimeout(requestSemanticMap, 500);
    }
  }

  // Look at result
  if (d.type === 'look_at_result') {
    console.log(`[SEMANTIC] Look at result: ${d.query} found=${d.found} angle=${d.pan_angle}`);
    if (typeof handleLookAtResult === 'function') {
      handleLookAtResult(d);
    }
  }

  // Location found
  if (d.type === 'location_found') {
    if (d.found !== false) {
      console.log(`[SEMANTIC] Location found: ${d.query} at (${d.x}, ${d.y})`);
    } else {
      console.log(`[SEMANTIC] Location not found: ${d.query}`);
    }
  }

  // ==================== MAC PROCESSOR ACCUMULATED MAP ====================

  // Processor status
  if (d.type === 'processor_status') {
    console.log(`[PROCESSOR] ${d.name} connected:`, d.connected);
  }

  // Accumulated 3D map from Mac processor (textured point cloud)
  if (d.type === 'accumulated_map') {
    if (window.lidar3dModule && window.lidar3dModule.updateAccumulatedMap) {
      window.lidar3dModule.updateAccumulatedMap(d);
    }
    // Log occasionally
    if (Math.random() < 0.05) {
      const pts = d.total || (d.points ? d.points.length : 0);
      console.log(`[3D MAP] Received ${pts} textured points from Mac processor`);
    }
  }

  // Frame history from Mac processor
  if (d.type === 'frame_history') {
    if (window.lidar3dModule && window.lidar3dModule.updateFrameHistory) {
      window.lidar3dModule.updateFrameHistory(d);
    }
  }

  // Semantic layout from semantic mapper (walls, doorways, objects)
  if (d.type === 'semantic_layout') {
    if (window.lidar3dModule && window.lidar3dModule.updateSemanticLayout) {
      window.lidar3dModule.updateSemanticLayout(d);
    }
    const stats = d.stats || {};
    if (Math.random() < 0.1) {
      console.log(`[SEMANTIC] ${stats.planes||0} planes, ${stats.doorways||0} doorways, ${stats.objects||0} objects`);
    }
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

  // Ultrasonic sensor data - update UI badges
  if (d.type === 'ultrasonic') {
    const flBadge = document.getElementById('usBadgeFL');
    const frBadge = document.getElementById('usBadgeFR');
    const rlBadge = document.getElementById('usBadgeRL');
    const rrBadge = document.getElementById('usBadgeRR');
    if (flBadge) flBadge.textContent = d.fl > 0 ? `FL: ${Math.round(d.fl)}cm` : 'FL: --';
    if (frBadge) frBadge.textContent = d.fr > 0 ? `FR: ${Math.round(d.fr)}cm` : 'FR: --';
    if (rlBadge) rlBadge.textContent = d.rl > 0 ? `RL: ${Math.round(d.rl)}cm` : 'RL: --';
    if (rrBadge) rrBadge.textContent = d.rr > 0 ? `RR: ${Math.round(d.rr)}cm` : 'RR: --';
    // Store for autonomous use
    window.ultrasonicState = { fl: d.fl, fr: d.fr, rl: d.rl, rr: d.rr, timestamp: d.timestamp };
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
// Matches iOS app style from project 601

// Stores current detections for each camera
let cameraDetections = { 1: [], 2: [] };

// FPS tracking
let detectionFrameCount = { 1: 0, 2: 0 };
let lastFpsUpdate = { 1: Date.now(), 2: Date.now() };
let currentFps = { 1: 0, 2: 0 };

// Text-to-speech state
let speechEnabled = false;
let lastSpokenByClass = {};  // Track last time each class was spoken
const SPEECH_COOLDOWN = 45000;  // 45 seconds per object class (matches iOS)
let speechSynthesis = window.speechSynthesis;

// Vibrant 10-color palette (matches iOS app)
const vibrantColors = [
  { r: 255, g: 51, b: 102 },   // Hot Pink
  { r: 0, g: 230, b: 255 },    // Cyan
  { r: 128, g: 255, b: 0 },    // Lime Green
  { r: 255, g: 128, b: 0 },    // Orange
  { r: 204, g: 0, b: 255 },    // Purple
  { r: 255, g: 255, b: 0 },    // Yellow
  { r: 0, g: 128, b: 255 },    // Sky Blue
  { r: 255, g: 0, b: 128 },    // Magenta
  { r: 0, g: 255, b: 128 },    // Spring Green
  { r: 255, g: 179, b: 0 }     // Gold
];

// Living creatures (get circle overlay like iOS app)
const livingClasses = new Set(['person', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'rabbit', 'duck', 'chicken', 'deer', 'turkey',
  'goose', 'owl', 'parrot', 'eagle', 'falcon', 'penguin', 'tiger', 'lion', 'fox', 'wolf',
  'monkey', 'panda', 'kangaroo', 'koala', 'squirrel', 'mouse', 'pig', 'goat', 'boy', 'girl',
  'man', 'woman', 'Human face', 'Human body']);

function handleDetections(cameraId, detections, serverTimestamp) {
  const now = Date.now();

  // Only process detections for the active camera (ignore stale detections from camera switches)
  const activeCamera = (typeof activeDetectionCamera !== 'undefined') ? activeDetectionCamera : 1;
  if (cameraId !== activeCamera) {
    // Clear this camera's overlay since it's not active
    const canvas = document.getElementById('overlayCanvas' + cameraId);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }

  // Validate timestamp - ignore stale detections (more than 2 seconds old)
  if (serverTimestamp && (now - serverTimestamp) > 2000) {
    console.log(`[DETECT] Ignoring stale detections from ${(now - serverTimestamp)/1000}s ago`);
    return;
  }

  // Update FPS counter
  detectionFrameCount[cameraId]++;
  if (now - lastFpsUpdate[cameraId] >= 1000) {
    currentFps[cameraId] = detectionFrameCount[cameraId];
    detectionFrameCount[cameraId] = 0;
    lastFpsUpdate[cameraId] = now;
    updateFpsDisplay(cameraId);
  }

  // Debug log
  if (detections.length > 0) {
    console.log(`[DETECT] Cam${cameraId}: ${detections.map(d => d.class + '(' + Math.round(d.confidence*100) + '%)').join(', ')}`);
  }

  cameraDetections[cameraId] = detections;
  lastDetectionServerTime[cameraId] = serverTimestamp || now;

  // Update detection overlay on camera canvas
  drawDetectionOverlay(cameraId, detections);

  // Update detection panel and object count
  updateDetectionPanel(cameraId, detections);
  updateObjectCount(cameraId, detections.length);

  // Text-to-speech announcements
  if (speechEnabled && detections.length > 0) {
    announceDetections(detections);
  }
}

// Get color for object based on index
function getObjectColor(index) {
  return vibrantColors[index % vibrantColors.length];
}

// Draw rounded rectangle (like iOS RoundedRectangle)
function roundRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Track last detection time per camera to clear stale overlays
let lastDetectionTime = { 1: 0, 2: 0 };
let lastDetectionServerTime = { 1: 0, 2: 0 };

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

  // Update detection time
  lastDetectionTime[cameraId] = Date.now();

  // If no detections, just clear and return
  if (!detections || detections.length === 0) return;

  // Sort detections by area (largest first, so smaller objects draw on top)
  const sortedDetections = [...detections].sort((a, b) => {
    const areaA = a.bbox.w * a.bbox.h;
    const areaB = b.bbox.w * b.bbox.h;
    return areaB - areaA;
  });

  // Track used label positions to avoid overlap
  const usedPositions = [];

  sortedDetections.forEach((det, index) => {
    const color = getObjectColor(index);

    // Calculate bounding box coordinates
    const x1 = det.bbox.x1 !== undefined ? det.bbox.x1 * w : (det.bbox.x - det.bbox.w/2) * w;
    const y1 = det.bbox.y1 !== undefined ? det.bbox.y1 * h : (det.bbox.y - det.bbox.h/2) * h;
    const x2 = det.bbox.x2 !== undefined ? det.bbox.x2 * w : (det.bbox.x + det.bbox.w/2) * w;
    const y2 = det.bbox.y2 !== undefined ? det.bbox.y2 * h : (det.bbox.y + det.bbox.h/2) * h;
    const bw = x2 - x1;
    const bh = y2 - y1;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    const isLiving = livingClasses.has(det.class) || livingClasses.has(det.class.toLowerCase());
    const cornerRadius = 8;

    if (isLiving) {
      // Living creatures: Draw circle around head area (like iOS app)
      const headRadius = Math.min(bw, bh) * 0.25;
      const headY = y1 + headRadius * 1.2;

      // Circle fill (15% opacity)
      ctx.beginPath();
      ctx.arc(cx, headY, headRadius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.15)`;
      ctx.fill();

      // Circle stroke (50% opacity, 2px)
      ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.5)`;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      // Non-living: Rounded rectangle (like iOS RoundedRectangle)
      // Fill with 15% opacity
      roundRect(ctx, x1, y1, bw, bh, cornerRadius);
      ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.15)`;
      ctx.fill();

      // Stroke with 50% opacity, 2px
      roundRect(ctx, x1, y1, bw, bh, cornerRadius);
      ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.5)`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Label: "ClassName 85%" - Capsule style like iOS
    const confPct = Math.round(det.confidence * 100);
    const label = `${det.class} ${confPct}%`;
    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    const labelWidth = ctx.measureText(label).width + 12;
    const labelHeight = 18;

    // Find best label position (try multiple positions like iOS)
    let textX = cx - labelWidth / 2;
    let textY = y1 - labelHeight - 4;  // Above the box

    // Keep in bounds
    textX = Math.max(4, Math.min(textX, w - labelWidth - 4));
    if (textY < labelHeight) {
      textY = y2 + 4;  // Below if not enough room above
    }

    // Collision avoidance
    for (let attempt = 0; attempt < 5; attempt++) {
      let collision = false;
      for (const pos of usedPositions) {
        if (textX < pos.x + pos.w && textX + labelWidth > pos.x &&
            textY < pos.y + pos.h && textY + labelHeight > pos.y) {
          collision = true;
          break;
        }
      }
      if (!collision) break;
      textY += labelHeight + 4;  // Move down
      if (textY > h - labelHeight) {
        textX += labelWidth / 2;
        textY = y1 - labelHeight - 4;
      }
    }

    // Record label position
    usedPositions.push({ x: textX, y: textY, w: labelWidth, h: labelHeight });

    // Draw capsule background (matching object color, 25% opacity)
    const capsuleRadius = labelHeight / 2;
    ctx.beginPath();
    ctx.moveTo(textX + capsuleRadius, textY);
    ctx.lineTo(textX + labelWidth - capsuleRadius, textY);
    ctx.arc(textX + labelWidth - capsuleRadius, textY + capsuleRadius, capsuleRadius, -Math.PI/2, Math.PI/2);
    ctx.lineTo(textX + capsuleRadius, textY + labelHeight);
    ctx.arc(textX + capsuleRadius, textY + capsuleRadius, capsuleRadius, Math.PI/2, -Math.PI/2);
    ctx.closePath();
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.35)`;
    ctx.fill();

    // Draw text (white, bold)
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillText(label, textX + 6, textY + labelHeight - 5);
    ctx.shadowBlur = 0;
  });
}

// Update FPS display (color-coded like iOS app)
function updateFpsDisplay(cameraId) {
  const fps = currentFps[cameraId];
  const el = document.getElementById('fpsDisplay' + cameraId);
  if (!el) return;

  // Color based on FPS (matches iOS app thresholds)
  let color;
  if (fps < 15) color = '#ff4444';       // Red - Critical
  else if (fps < 25) color = '#ffaa00';  // Orange - Poor
  else if (fps < 30) color = '#ffff00';  // Yellow - Fair
  else color = '#44ff44';                 // Green - Good

  el.innerHTML = `<span style="color:${color}">⚡</span> ${fps.toFixed(1)} <span style="opacity:0.7">FPS</span>`;
  el.style.borderColor = color;
}

// Update object count display (color-coded like iOS app)
function updateObjectCount(cameraId, count) {
  const el = document.getElementById('objectCount' + cameraId);
  if (!el) return;

  // Color based on count (matches iOS app)
  let color;
  if (count === 0) color = '#888888';      // Gray
  else if (count <= 3) color = '#5599ff';  // Blue
  else if (count <= 6) color = '#ffaa00';  // Orange
  else if (count <= 10) color = '#ff4444'; // Red
  else color = '#cc44ff';                   // Purple

  el.innerHTML = `<span style="color:${color}">👁</span> ${count}`;
  el.style.borderColor = color;
}

// Text-to-speech announcement (matches iOS app behavior)
function announceDetections(detections) {
  if (!speechSynthesis) return;

  const now = Date.now();
  const toAnnounce = [];

  for (const det of detections) {
    const className = det.class.toLowerCase();
    const lastSpoken = lastSpokenByClass[className] || 0;

    // 45-second cooldown per class (matches iOS app)
    if (now - lastSpoken >= SPEECH_COOLDOWN) {
      toAnnounce.push(className);
      lastSpokenByClass[className] = now;
    }
  }

  if (toAnnounce.length > 0 && !speechSynthesis.speaking) {
    const text = toAnnounce.slice(0, 3).join(', ');  // Max 3 at once
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;
    speechSynthesis.speak(utterance);
    console.log('[SPEECH]', text);
  }
}

// Toggle speech on/off
function toggleSpeech() {
  speechEnabled = !speechEnabled;
  const btn = document.getElementById('speechToggle');
  if (btn) {
    btn.style.borderColor = speechEnabled ? '#44ff44' : 'rgba(255,255,255,0.3)';
    btn.style.background = speechEnabled ? 'rgba(68,255,68,0.2)' : 'rgba(0,0,0,0.4)';
  }
  console.log('[SPEECH]', speechEnabled ? 'Enabled' : 'Disabled');

  // Announce state change
  if (speechEnabled) {
    const utterance = new SpeechSynthesisUtterance('Speech enabled');
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
  }
}

// Clear stale overlays only after 3 seconds of no updates (labels persist until replaced)
setInterval(() => {
  const now = Date.now();
  [1, 2].forEach(camId => {
    // Only clear if no detections for 3+ seconds (connection loss scenario)
    if (now - lastDetectionTime[camId] > 3000) {
      // Clear canvas overlay
      const canvas = document.getElementById(camId === 1 ? 'overlayCanvas1' : 'overlayCanvas2');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      // Clear detection panel
      const panel = document.getElementById('detectionPanel' + camId);
      if (panel && panel.innerHTML !== '') {
        panel.innerHTML = '';
      }
      // Clear stored detections
      if (cameraDetections[camId] && cameraDetections[camId].length > 0) {
        cameraDetections[camId] = [];
      }
    }
  });
}, 500);  // Check every 500ms (less CPU)

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

// ============ DEPTH FRAME DISPLAY ============
// Toggle between normal camera and depth view
let depthViewEnabled = { 1: true, 2: true };  // Depth ON by default
let latestDepthFrame = { 1: null, 2: null };

function displayDepthFrame(cameraId, base64Frame) {
  // Store latest depth frame
  latestDepthFrame[cameraId] = base64Frame;

  // If depth view is enabled for this camera, show it
  if (depthViewEnabled[cameraId]) {
    const imgId = cameraId === 1 ? 'camFrame1' : 'camFrame2';
    const img = document.getElementById(imgId);
    if (img) {
      img.src = 'data:image/jpeg;base64,' + base64Frame;
    }
  }
}

// Toggle depth view for a camera
window.toggleDepthView = function(cameraId) {
  depthViewEnabled[cameraId] = !depthViewEnabled[cameraId];

  // Update toggle button appearance
  const btn = document.getElementById('depthToggle' + cameraId);
  if (btn) {
    btn.style.background = depthViewEnabled[cameraId] ? '#0f8' : 'rgba(0,0,0,0.5)';
    btn.textContent = depthViewEnabled[cameraId] ? 'DEPTH ON' : 'DEPTH';
  }

  console.log(`[DEPTH] Camera ${cameraId} depth view: ${depthViewEnabled[cameraId] ? 'ON' : 'OFF'}`);
};

console.log('[WS] Modular WebSocket v55 - Depth estimation + mapping');
