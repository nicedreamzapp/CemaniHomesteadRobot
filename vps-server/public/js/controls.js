// ============ NAVIGATION CONTROL ============
console.log('[CONTROLS.JS] LOADED - Version 2024-12-28-v8 (modular)');
let currentDir = null;
let currentDist = null;
let gridOffsetX = 0;
let gridOffsetY = 0;
let robotHeading = 0;

const dirLabels = { F: 'FWD', B: 'BACK', L: 'LEFT', R: 'RIGHT' };
const PIXELS_PER_FOOT = 13;
const FEET_TO_METERS = 0.3048;

function updateDisplay() {
  document.getElementById('currentDir').textContent = currentDir ? dirLabels[currentDir] : '--';

  document.querySelectorAll('.compass-dir, .ctrl-dir-btn, .ctrl-round-btn, .tank-steer-btn, .tank-dir-btn').forEach(d => {
    d.classList.remove('active');
  });
  if (currentDir) {
    const el = document.getElementById('dir' + currentDir);
    if (el) el.classList.add('active');
  }

  document.querySelectorAll('.dist-btn').forEach(d => {
    d.style.background = 'rgba(81, 207, 102, 0.2)';
    d.style.color = '#51cf66';
  });
  if (currentDist) {
    document.querySelectorAll('.dist-btn').forEach(d => {
      if (parseFloat(d.dataset.dist) === currentDist) {
        d.style.background = '#51cf66';
        d.style.color = '#000';
      }
    });
  }

  updateChassisDisplay();

  if (currentDir && currentDist) {
    setStatus(dirLabels[currentDir] + ' ' + currentDist + 'ft - Press GO', 'idle');
  } else if (currentDir) {
    setStatus(dirLabels[currentDir] + ' - Tap distance', 'idle');
  } else if (currentDist) {
    setStatus(currentDist + 'ft - Tap direction', 'idle');
  } else {
    setStatus('Tap direction or distance', 'idle');
  }
}

function updateChassisDisplay() {
  const dirEl = document.getElementById('cmdDirLine');
  const distEl = document.getElementById('cmdDistLine');
  const boxEl = document.getElementById('ctrlQueueDisplay');

  if (dirEl) dirEl.textContent = currentDir ? dirLabels[currentDir] : '--';
  if (distEl) distEl.textContent = currentDist ? currentDist + 'ft' : '--';
  if (boxEl) boxEl.classList.remove('executing');
}

function updateRadarRobot() {
  const robot = document.getElementById('radarRobot');
  const grid = document.getElementById('radarGrid');
  if (robot) robot.style.transform = `translate(-50%, -50%) rotate(${robotHeading}deg)`;
  if (grid) grid.style.transform = `translate(${-gridOffsetX}px, ${-gridOffsetY}px)`;
}

function setStatus(text, type) {
  const el = document.getElementById('moveStatus');
  if (el) {
    el.textContent = text;
    el.className = 'move-status ' + (type || 'idle');
  }
}

function selectDirection(dir) {
  currentDir = dir;
  updateDisplay();
  // Direction only selects - movement happens when user presses GO
}

function selectDistance(distance) {
  currentDist = distance;
  updateDisplay();
  // SAFETY: Distance selection NEVER triggers movement
  // User MUST press GO button to execute
}

let goButtonPressed = false;  // SAFETY: Only true when GO button is physically clicked

function executeQueue() {
  goButtonPressed = true;  // Mark that GO was explicitly pressed

  if (!currentDir || !currentDist) {
    setStatus('Select direction and distance first!', 'error');
    goButtonPressed = false;
    return;
  }

  const cmd = { dir: currentDir, dist: currentDist };
  const serialDiv = document.getElementById('serial');
  if (serialDiv) {
    serialDiv.innerHTML += '<span style="color:#51cf66">[GO] Executing ' + dirLabels[cmd.dir] + ' ' + cmd.dist + 'ft</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }

  setStatus('EXECUTING ' + dirLabels[cmd.dir] + ' ' + cmd.dist + 'ft...', 'moving');

  const boxEl = document.getElementById('ctrlQueueDisplay');
  if (boxEl) boxEl.classList.add('executing');

  // SAFETY: Triple-check that GO was explicitly pressed before sending ANY movement
  if (!goButtonPressed) {
    console.error('[SAFETY] Movement blocked - GO button was not pressed!');
    setStatus('Press GO to move!', 'error');
    return;
  }
  goButtonPressed = false;  // Reset immediately after use

  const distanceCm = Math.round(cmd.dist * FEET_TO_METERS * 100);

  // Send drive command via WebSocket — server handles MODE_MAPPING + motor init
  if (window.ws && window.ws.readyState === 1) {
    const moveCmd = 'MOVEDIR,' + cmd.dir + ',' + distanceCm;
    window.ws.send(JSON.stringify({ type: 'serial_cmd_relay', cmd: moveCmd }));
    console.log('[CONTROLS] Sent ' + moveCmd);
  } else {
    console.error('[CONTROLS] WebSocket not connected!');
    setStatus('Not connected!', 'error');
  }

  const movePixels = cmd.dist * PIXELS_PER_FOOT;
  const headingRad = robotHeading * Math.PI / 180;

  if (cmd.dir === 'F') {
    gridOffsetX += Math.sin(headingRad) * movePixels;
    gridOffsetY -= Math.cos(headingRad) * movePixels;
  } else if (cmd.dir === 'B') {
    gridOffsetX -= Math.sin(headingRad) * movePixels;
    gridOffsetY += Math.cos(headingRad) * movePixels;
  } else if (cmd.dir === 'L') {
    robotHeading -= 90;
  } else if (cmd.dir === 'R') {
    robotHeading += 90;
  }
  updateRadarRobot();

  let totalTime = (cmd.dir === 'L' || cmd.dir === 'R') ? 9500 : cmd.dist * 100 * 200 + 500;

  setTimeout(function() {
    setStatus('Complete', 'idle');
    currentDir = null;
    currentDist = null;
    updateDisplay();
  }, totalTime);
}

function emergencyStop() {
  if (window.ws && window.ws.readyState === 1) {
    window.ws.send(JSON.stringify({ type: 'emergency_stop' }));
  }
  currentDir = null;
  currentDist = null;
  updateDisplay();
  setStatus('STOPPED', 'error');
}

// ============ LIGHT TOGGLE ============
let lightOn = false;
let strobeInterval = null;
let strobeActive = false;

function toggleLight() {
  if (strobeActive) stopStrobe();
  lightOn = !lightOn;

  const btn = document.getElementById('lightToggleBtn');
  if (btn) btn.classList.toggle('on', lightOn);

  const lightSwitch = document.getElementById('lightSwitch');
  if (lightSwitch) lightSwitch.classList.toggle('on', lightOn);

  if (typeof v380Light === 'function') {
    v380Light(lightOn ? 1 : 0);
  } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    if (window.ws) window.ws.send(JSON.stringify({ type: 'v380_light', state: lightOn ? 1 : 0 }));
  }
  console.log('[LIGHT] Toggled:', lightOn ? 'ON' : 'OFF');
}

function toggleStrobe() {
  strobeActive ? stopStrobe() : startStrobe();
}

function startStrobe() {
  strobeActive = true;
  const strobeBtn = document.getElementById('strobeBtn');
  if (strobeBtn) strobeBtn.classList.add('active');
  console.log('[STROBE] Started');

  strobeInterval = setInterval(() => {
    lightOn = !lightOn;
    if (typeof v380Light === 'function') {
      v380Light(lightOn ? 1 : 0);
    } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
      if (window.ws) window.ws.send(JSON.stringify({ type: 'v380_light', state: lightOn ? 1 : 0 }));
    }
  }, 500);
}

function stopStrobe() {
  strobeActive = false;
  if (strobeInterval) {
    clearInterval(strobeInterval);
    strobeInterval = null;
  }
  const strobeBtn = document.getElementById('strobeBtn');
  if (strobeBtn) strobeBtn.classList.remove('active');

  lightOn = false;
  const sendOff = () => {
    if (typeof v380Light === 'function') {
      v380Light(0);
    } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
      if (window.ws) window.ws.send(JSON.stringify({ type: 'v380_light', state: 0 }));
    }
  };
  sendOff();
  setTimeout(sendOff, 200);
  setTimeout(sendOff, 400);

  const lightSwitch = document.getElementById('lightSwitch');
  if (lightSwitch) lightSwitch.classList.remove('on');
  console.log('[STROBE] Stopped');
}

// ============ POPUPS ============
function toggleCodePopup() {
  const popup = document.getElementById('codePopup');
  if (popup) popup.classList.toggle('open');
}

function toggleSerialPopup() {
  const popup = document.getElementById('serialPopup');
  if (popup) popup.classList.toggle('open');
}

// Make popups draggable
function makeDraggable(popupId, headerId) {
  const popup = document.getElementById(popupId);
  const header = document.getElementById(headerId);
  if (!popup || !header) return;

  let isDragging = false;
  let offsetX = 0, offsetY = 0;

  header.addEventListener('mousedown', function(e) {
    isDragging = true;
    offsetX = e.clientX - popup.offsetLeft;
    offsetY = e.clientY - popup.offsetTop;
    popup.style.transition = 'none';
  });

  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    e.preventDefault();
    let x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - popup.offsetWidth));
    let y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('mouseup', () => isDragging = false);

  // Touch support
  header.addEventListener('touchstart', function(e) {
    isDragging = true;
    const touch = e.touches[0];
    offsetX = touch.clientX - popup.offsetLeft;
    offsetY = touch.clientY - popup.offsetTop;
    popup.style.transition = 'none';
  });

  document.addEventListener('touchmove', function(e) {
    if (!isDragging) return;
    const touch = e.touches[0];
    let x = Math.max(0, Math.min(touch.clientX - offsetX, window.innerWidth - popup.offsetWidth));
    let y = Math.max(0, Math.min(touch.clientY - offsetY, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('touchend', () => isDragging = false);
}

// Initialize draggable popups
makeDraggable('codePopup', 'codePopupHeader');
makeDraggable('serialPopup', 'serialPopupHeader');
makeDraggable('wifiPopup', 'wifiPopupHeader');

function clearQueue() {
  currentDir = null;
  currentDist = null;
  gridOffsetX = 0;
  gridOffsetY = 0;
  robotHeading = 0;
  updateRadarRobot();
  updateDisplay();
  setStatus('Cleared', 'idle');

  const serialDiv = document.getElementById('serial');
  if (serialDiv) {
    serialDiv.innerHTML += '<span style="color:#74c0fc">[CLEAR] Cleared</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }
}

// Direction button handlers
document.getElementById('dirF').onclick = () => selectDirection('F');
document.getElementById('dirR').onclick = () => selectDirection('R');
document.getElementById('dirB').onclick = () => selectDirection('B');
document.getElementById('dirL').onclick = () => selectDirection('L');

// Mobile D-pad direction handlers
const mobileDirF = document.getElementById('mobileDirF');
const mobileDirR = document.getElementById('mobileDirR');
const mobileDirB = document.getElementById('mobileDirB');
const mobileDirL = document.getElementById('mobileDirL');

function updateMobileDpad(dir) {
  document.querySelectorAll('.dpad-btn').forEach(btn => btn.classList.remove('selected'));
  const btn = document.getElementById('mobileDir' + dir);
  if (btn) btn.classList.add('selected');
}

if (mobileDirF) mobileDirF.onclick = () => { selectDirection('F'); updateMobileDpad('F'); };
if (mobileDirR) mobileDirR.onclick = () => { selectDirection('R'); updateMobileDpad('R'); };
if (mobileDirB) mobileDirB.onclick = () => { selectDirection('B'); updateMobileDpad('B'); };
if (mobileDirL) mobileDirL.onclick = () => { selectDirection('L'); updateMobileDpad('L'); };

// Distance button handlers
document.querySelectorAll('.dist-btn').forEach(btn => {
  btn.onclick = function() {
    selectDistance(parseFloat(this.dataset.dist));
  };
});

// Initialize display
updateDisplay();
updateRadarRobot();

function reset() {
  if (window.ws) window.ws.send(JSON.stringify({type:'command', data:'reset'}));
  const serialDiv = document.getElementById('serial');
  if (serialDiv) serialDiv.innerHTML = '[RESET]<br>';
  clearQueue();
  robotHeading = 0;
  updateRadarRobot();
}

// Serial command input
const cmdInput = document.getElementById('cmd');
if (cmdInput) {
  cmdInput.onkeypress = function(e) {
    if(e.key === 'Enter') {
      if (window.ws) window.ws.send(JSON.stringify({type:'command', data:e.target.value}));
      e.target.value = '';
    }
  };
}

// ============ CODE EDITOR ============
let currentTab = 'esp32';

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = function() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    currentTab = this.dataset.tab;
    const editor = document.getElementById('editor');
    if (editor) editor.placeholder = '// ' + currentTab.toUpperCase() + ' code...';
  };
});

const compileBtn = document.getElementById('compileBtn');
if (compileBtn) {
  compileBtn.onclick = () => {
    const code = document.getElementById('editor').value;
    if (!code.trim()) {
      alert('Please enter some code first');
      return;
    }
    if (window.ws) window.ws.send(JSON.stringify({type:'compile', target:currentTab, code:code}));
    const serialDiv = document.getElementById('serial');
    if (serialDiv) {
      serialDiv.innerHTML += '[COMPILING ' + currentTab.toUpperCase() + '...]<br>';
      serialDiv.scrollTop = serialDiv.scrollHeight;
    }
  };
}

const flashBtn = document.getElementById('flashPrebuiltBtn');
if (flashBtn) {
  flashBtn.onclick = () => {
    if (!confirm('Flash pre-built Teensy firmware? Robot will reboot.')) return;
    if (window.ws) window.ws.send(JSON.stringify({type:'flash_prebuilt'}));
    const serialDiv = document.getElementById('serial');
    if (serialDiv) {
      serialDiv.innerHTML += '[FLASHING PREBUILT TEENSY...]<br>';
      serialDiv.scrollTop = serialDiv.scrollHeight;
    }
  };
}

// ============ WIFI MANAGER ============
let wifiRelayConnected = false;
let selectedWifiSSID = '';

let wifiScanInterval = null;

function toggleWifiPopup() {
  const popup = document.getElementById('wifiPopup');
  if (popup) {
    popup.classList.toggle('open');
    if (popup.classList.contains('open')) {
      // Start auto-scanning when popup opens
      scanWifi();
      wifiScanInterval = setInterval(scanWifi, 10000); // Refresh every 10 seconds
    } else {
      // Stop scanning when popup closes
      if (wifiScanInterval) {
        clearInterval(wifiScanInterval);
        wifiScanInterval = null;
      }
    }
  }
}

function updateWifiRelayStatus(connected) {
  wifiRelayConnected = connected;
  const statusEl = document.getElementById('wifiRelayStatus');
  const noRelayEl = document.getElementById('wifiNoRelay');
  const scanBtn = document.getElementById('wifiScanBtn');

  if (statusEl) {
    statusEl.textContent = connected ? 'ON' : 'OFF';
    statusEl.style.color = connected ? '#0f8' : '#f44';
  }
  if (noRelayEl) {
    noRelayEl.style.display = connected ? 'none' : 'block';
  }
  if (scanBtn) {
    scanBtn.disabled = !connected;
    scanBtn.style.opacity = connected ? '1' : '0.5';
  }
}

function scanWifi() {
  // WiFi scan via WebSocket to Jetson camera relay
  console.log('[WIFI-UI] Scanning via WebSocket...');
  const scanningEl = document.getElementById('wifiScanning');

  // Show scanning message
  if (scanningEl) scanningEl.style.display = 'block';

  if (window.ws && window.ws.readyState === WebSocket.OPEN) {
    window.ws.send(JSON.stringify({ type: 'wifi_scan' }));
    // Response handled by websocket.js -> displayWifiNetworks
    // Set timeout to hide scanning indicator if no response
    setTimeout(() => {
      if (scanningEl && scanningEl.style.display === 'block') {
        scanningEl.style.display = 'none';
        console.log('[WIFI-UI] Scan timeout - no response');
      }
    }, 15000);
  } else {
    console.error('[WIFI-UI] WebSocket not connected');
    if (scanningEl) scanningEl.style.display = 'none';
    alert('WebSocket not connected');
  }
}

function displayWifiNetworks(networks) {
  const scanningEl = document.getElementById('wifiScanning');
  const knownList = document.getElementById('wifiKnownNetworks');
  const otherList = document.getElementById('wifiOtherNetworks');
  const currentNetworkEl = document.getElementById('wifiCurrentNetwork');
  const currentDetailEl = document.getElementById('wifiSignalStrength');

  if (scanningEl) scanningEl.style.display = 'none';

  // Clear existing items
  if (knownList) knownList.innerHTML = '';
  if (otherList) otherList.innerHTML = '';

  if (!networks || networks.length === 0) {
    if (otherList) otherList.innerHTML = '<div class="wifi-scanning">No networks found</div>';
    return;
  }

  // Sort by signal strength
  networks.sort((a, b) => (b.signal || 0) - (a.signal || 0));

  // Update current connection display
  const connected = networks.find(n => n.connected);
  if (connected && currentNetworkEl) {
    currentNetworkEl.textContent = connected.ssid;
    if (currentDetailEl) currentDetailEl.textContent = 'Connected • ' + connected.signal + ' dBm';
  }

  networks.forEach(network => {
    if (network.connected) return; // Skip connected network (shown at top)

    const item = document.createElement('div');
    item.className = 'wifi-network-item';

    const signal = network.signal || 0;
    const bars = signal > 70 ? '▂▄▆█' : signal > 50 ? '▂▄▆_' : signal > 30 ? '▂▄__' : '▂___';
    const security = network.security || 'Open';
    const lockIcon = security !== 'Open' ? '🔒 ' : '';

    item.innerHTML = `
      <div class="wifi-network-info">
        <span class="wifi-ssid">${lockIcon}${escapeHtml(network.ssid)}</span>
        <span class="wifi-details">${signal}%</span>
      </div>
      <span class="wifi-signal">${bars}</span>
    `;

    item.onclick = () => selectWifiNetwork(network.ssid, security === 'Open');

    // Put known/saved networks in known list, others in other list
    if (network.known && knownList) {
      knownList.appendChild(item);
    } else if (otherList) {
      otherList.appendChild(item);
    }
  });

  // Show message if no other networks
  if (otherList && otherList.children.length === 0) {
    otherList.innerHTML = '<div class="wifi-scanning" style="padding:10px;color:#666;">Searching for networks...</div>';
  }
}

function selectWifiNetwork(ssid, isOpen) {
  selectedWifiSSID = ssid;

  const connectForm = document.getElementById('wifiConnectForm');
  const selectedSSID = document.getElementById('wifiSelectedSSID');
  const passwordInput = document.getElementById('wifiPassword');

  if (selectedSSID) selectedSSID.textContent = ssid;
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.style.display = isOpen ? 'none' : 'block';
  }
  if (connectForm) connectForm.style.display = 'block';
}

function cancelWifiConnect() {
  const connectForm = document.getElementById('wifiConnectForm');
  if (connectForm) connectForm.style.display = 'none';
  selectedWifiSSID = '';
}

function connectWifi() {
  if (!selectedWifiSSID) return;

  const passwordInput = document.getElementById('wifiPassword');
  const password = passwordInput ? passwordInput.value : '';

  if (window.ws && window.ws.readyState === WebSocket.OPEN) {
    window.ws.send(JSON.stringify({
      type: 'wifi_connect',
      ssid: selectedWifiSSID,
      password: password
    }));
  }

  cancelWifiConnect();

  // Show connecting feedback
  const statusEl = document.getElementById('wifiCurrentNetwork');
  if (statusEl) statusEl.textContent = 'Connecting...';
}

function updateWifiStatus(status) {
  const networkEl = document.getElementById('wifiCurrentNetwork');
  const signalEl = document.getElementById('wifiSignalStrength');

  if (networkEl) {
    networkEl.textContent = status.ssid || '--';
  }
  if (signalEl && status.signal) {
    signalEl.textContent = status.signal + ' dBm';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export functions needed by other modules
window.controlsModule = {
  selectDirection,
  selectDistance,
  executeQueue,
  emergencyStop,
  clearQueue,
  reset,
  toggleLight,
  toggleStrobe,
  toggleCodePopup,
  toggleSerialPopup,
  toggleWifiPopup,
  updateWifiRelayStatus,
  displayWifiNetworks,
  updateWifiStatus,
  scanWifi,
  connectWifi,
  cancelWifiConnect
};

// For backwards compatibility, also expose updateXboxStatus from gamepad module
// This is called from websocket.js
function updateXboxStatus(connected) {
  if (window.gamepadControlModule) {
    window.gamepadControlModule.updateXboxStatus(connected);
  }
}
