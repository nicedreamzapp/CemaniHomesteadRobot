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

  // INSTANT DRIVE: Send immediate short move command when clicking direction
  const INSTANT_DRIVE_DISTANCE = 0.3;  // 0.3 meters (~1 foot)
  if (window.ws && window.ws.readyState === 1) {
    // For L/R, send turn commands instead
    if (dir === 'L' || dir === 'R') {
      const turnAngle = dir === 'L' ? -30 : 30;
      window.ws.send(JSON.stringify({
        type: 'serial_cmd',
        cmd: `TURN,${turnAngle}`
      }));
      console.log('[DRIVE] Turning', turnAngle, 'degrees');
    } else {
      // FWD/BACK - send serial_cmd for immediate response
      const cmd = dir === 'F' ? 'FWD,30' : 'BACK,30';  // 30 RPM speed
      window.ws.send(JSON.stringify({
        type: 'serial_cmd',
        cmd: cmd
      }));
      console.log('[DRIVE] Sent', cmd);
      // Auto-stop after 0.5 seconds
      setTimeout(() => {
        if (window.ws && window.ws.readyState === 1) {
          window.ws.send(JSON.stringify({ type: 'serial_cmd', cmd: 'STOP' }));
        }
      }, 500);
    }
  }
}

function selectDistance(distance) {
  currentDist = distance;
  updateDisplay();
}

function executeQueue() {
  if (!currentDir || !currentDist) {
    setStatus('Select direction and distance first!', 'error');
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

  const distanceMeters = cmd.dist * FEET_TO_METERS;
  if (window.ws && window.ws.readyState === 1) {
    window.ws.send(JSON.stringify({
      type: 'move_command',
      distance: distanceMeters,
      direction: cmd.dir
    }));
    console.log('[CONTROLS] Sent move_command:', cmd.dir, distanceMeters + 'm');
  } else {
    console.error('[CONTROLS] WebSocket not connected!');
    setStatus('WebSocket not connected!', 'error');
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
  toggleSerialPopup
};

// For backwards compatibility, also expose updateXboxStatus from gamepad module
// This is called from websocket.js
function updateXboxStatus(connected) {
  if (window.gamepadControlModule) {
    window.gamepadControlModule.updateXboxStatus(connected);
  }
}
