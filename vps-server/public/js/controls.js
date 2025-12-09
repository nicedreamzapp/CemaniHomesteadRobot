// ============ NAVIGATION CONTROL ============
console.log('[CONTROLS.JS] LOADED - Version 2024-12-05-v7');
let currentDir = null;
let currentDist = null;
let gridOffsetX = 0;
let gridOffsetY = 0;
let robotHeading = 0;

const dirLabels = { F: 'FWD', B: 'BACK', L: 'LEFT', R: 'RIGHT' };
const PIXELS_PER_FOOT = 13;
const FEET_TO_METERS = 0.3048;

function updateDisplay() {
  // Update hidden element for compatibility
  document.getElementById('currentDir').textContent = currentDir ? dirLabels[currentDir] : '--';

  // Highlight active direction button
  document.querySelectorAll('.compass-dir, .ctrl-dir-btn, .ctrl-round-btn, .tank-steer-btn, .tank-dir-btn').forEach(d => {
    d.classList.remove('active');
  });
  if (currentDir) {
    const el = document.getElementById('dir' + currentDir);
    if (el) el.classList.add('active');
  }

  // Highlight active distance button
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

  // Update chassis display
  updateChassisDisplay();

  // Update status message
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
  const chassis = document.getElementById('ctrlQueueDisplay');
  if (!chassis) {
    console.log('[CHASSIS] Element not found!');
    return;
  }

  // Always show what's selected in the chassis
  let html = '';
  if (currentDir) {
    html += '<div class="tank-cmd-line">' + dirLabels[currentDir] + '</div>';
  }
  if (currentDist) {
    html += '<div class="tank-cmd-line">' + currentDist + '\'</div>';
  }
  chassis.innerHTML = html;
  console.log('[CHASSIS] Updated:', html);
}

function removeFromQueue(index) {
  // Legacy - no longer used
}

function updateRadarRobot() {
  const robot = document.getElementById('radarRobot');
  const grid = document.getElementById('radarGrid');
  if (robot) robot.style.transform = `translate(-50%, -50%) rotate(${robotHeading}deg)`;
  if (grid) grid.style.transform = `translate(${-gridOffsetX}px, ${-gridOffsetY}px)`;
}

function setStatus(text, type) {
  const el = document.getElementById('moveStatus');
  el.textContent = text;
  el.className = 'move-status ' + (type || 'idle');
}

function selectDirection(dir) {
  currentDir = dir;
  updateDisplay();
}

function selectDistance(distance) {
  currentDist = distance;
  updateDisplay();
}

function executeQueue() {
  // Must have both direction and distance
  if (!currentDir || !currentDist) {
    setStatus('Select direction and distance first!', 'error');
    return;
  }

  // Save the command
  const cmd = { dir: currentDir, dist: currentDist };

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#51cf66">[GO] Executing ' + dirLabels[cmd.dir] + ' ' + cmd.dist + 'ft</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;

  setStatus('EXECUTING ' + dirLabels[cmd.dir] + ' ' + cmd.dist + 'ft...', 'moving');

  // Show command in YELLOW (executing)
  const chassis = document.getElementById('ctrlQueueDisplay');
  if (chassis) {
    chassis.innerHTML = '<div class="tank-cmd-line executing">' + dirLabels[cmd.dir] + '</div><div class="tank-cmd-line executing">' + cmd.dist + '\'</div>';
  }

  // Convert feet to meters for the robot command
  const distanceMeters = cmd.dist * FEET_TO_METERS;
  ws.send(JSON.stringify({
    type: 'move_command',
    distance: distanceMeters,
    direction: cmd.dir
  }));

  // Update radar/position tracker
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

  // Calculate execution time
  let totalTime;
  if (cmd.dir === 'L' || cmd.dir === 'R') {
    totalTime = 90 * 100 + 500;
  } else {
    totalTime = cmd.dist * 100 * 200 + 500;
  }

  // Complete after execution time
  setTimeout(function() {
    setStatus('Complete', 'idle');
    currentDir = null;
    currentDist = null;
    const chassis = document.getElementById('ctrlQueueDisplay');
    if (chassis) chassis.innerHTML = '';
    updateDisplay();
  }, totalTime);
}

function emergencyStop() {
  ws.send(JSON.stringify({ type: 'emergency_stop' }));
  currentDir = null;
  currentDist = null;
  const chassis = document.getElementById('ctrlQueueDisplay');
  if (chassis) chassis.innerHTML = '';
  updateDisplay();
}

// ============ LIGHT TOGGLE ============
let lightOn = false;
let strobeInterval = null;
let strobeActive = false;

function toggleLight() {
  // Stop strobe if running
  if (strobeActive) {
    stopStrobe();
  }
  lightOn = !lightOn;
  // Update old button if exists
  const btn = document.getElementById('lightToggleBtn');
  if (btn) {
    btn.classList.toggle('on', lightOn);
  }
  // Update new light switch overlay
  const lightSwitch = document.getElementById('lightSwitch');
  if (lightSwitch) {
    lightSwitch.classList.toggle('on', lightOn);
  }
  // Use the v380Light function from websocket.js (0 = off, 1 = on)
  if (typeof v380Light === 'function') {
    v380Light(lightOn ? 1 : 0);
  } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    // Fallback to direct websocket with correct format
    ws.send(JSON.stringify({ type: 'v380_light', state: lightOn ? 1 : 0 }));
  }
  console.log('[LIGHT] Toggled:', lightOn ? 'ON' : 'OFF');
}

function toggleStrobe() {
  if (strobeActive) {
    stopStrobe();
  } else {
    startStrobe();
  }
}

function startStrobe() {
  strobeActive = true;
  const strobeBtn = document.getElementById('strobeBtn');
  if (strobeBtn) strobeBtn.classList.add('active');

  console.log('[STROBE] Started');

  // Strobe at 500ms intervals (2Hz) - slow enough for relay to keep up
  strobeInterval = setInterval(() => {
    lightOn = !lightOn;
    if (typeof v380Light === 'function') {
      v380Light(lightOn ? 1 : 0);
    } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'v380_light', state: lightOn ? 1 : 0 }));
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

  // Turn light off when stopping strobe - send multiple times to ensure it stops
  lightOn = false;
  const sendOff = () => {
    if (typeof v380Light === 'function') {
      v380Light(0);
    } else if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'v380_light', state: 0 }));
    }
  };
  sendOff();
  setTimeout(sendOff, 200);
  setTimeout(sendOff, 400);

  const lightSwitch = document.getElementById('lightSwitch');
  if (lightSwitch) lightSwitch.classList.remove('on');

  console.log('[STROBE] Stopped');
}

// ============ CODE POPUP ============
function toggleCodePopup() {
  const popup = document.getElementById('codePopup');
  if (popup) {
    popup.classList.toggle('open');
  }
}

// Make code popup draggable
(function() {
  const popup = document.getElementById('codePopup');
  const header = document.getElementById('codePopupHeader');
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
    let x = e.clientX - offsetX;
    let y = e.clientY - offsetY;
    x = Math.max(0, Math.min(x, window.innerWidth - popup.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('mouseup', function() {
    isDragging = false;
  });

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
    let x = touch.clientX - offsetX;
    let y = touch.clientY - offsetY;
    x = Math.max(0, Math.min(x, window.innerWidth - popup.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('touchend', function() {
    isDragging = false;
  });
})();

function clearQueue() {
  currentDir = null;
  currentDist = null;
  gridOffsetX = 0;
  gridOffsetY = 0;
  robotHeading = 0;
  const chassis = document.getElementById('ctrlQueueDisplay');
  if (chassis) chassis.innerHTML = '';
  updateRadarRobot();
  updateDisplay();
  setStatus('Cleared', 'idle');

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#74c0fc">[CLEAR] Cleared</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;
}

// Direction button handlers
document.getElementById('dirF').onclick = () => selectDirection('F');
document.getElementById('dirR').onclick = () => selectDirection('R');
document.getElementById('dirB').onclick = () => selectDirection('B');
document.getElementById('dirL').onclick = () => selectDirection('L');

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
  ws.send(JSON.stringify({type:'command', data:'reset'}));
  document.getElementById('serial').innerHTML = '[RESET]<br>';
  clearQueue();
  robotHeading = 0;
  updateRadarRobot();
}

// Serial command input
document.getElementById('cmd').onkeypress = function(e) {
  if(e.key === 'Enter') {
    ws.send(JSON.stringify({type:'command', data:e.target.value}));
    e.target.value = '';
  }
};

// ============ CODE EDITOR ============
let currentTab = 'esp32';

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = function() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    currentTab = this.dataset.tab;
    document.getElementById('editor').placeholder = '// ' + currentTab.toUpperCase() + ' code...';
  };
});

document.getElementById('compileBtn').onclick = () => {
  const code = document.getElementById('editor').value;
  if (!code.trim()) {
    alert('Please enter some code first');
    return;
  }
  ws.send(JSON.stringify({type:'compile', target:currentTab, code:code}));
  document.getElementById('serial').innerHTML += '[COMPILING ' + currentTab.toUpperCase() + '...]<br>';
  document.getElementById('serial').scrollTop = document.getElementById('serial').scrollHeight;
};

document.getElementById('flashPrebuiltBtn').onclick = () => {
  if (!confirm('Flash pre-built Teensy firmware? Robot will reboot.')) return;
  ws.send(JSON.stringify({type:'flash_prebuilt'}));
  document.getElementById('serial').innerHTML += '[FLASHING PREBUILT TEENSY...]<br>';
  document.getElementById('serial').scrollTop = document.getElementById('serial').scrollHeight;
};

// ============ XBOX CONTROLLER DETECTION ============
// Track ROBOT's Xbox controller status (from ESP32), NOT browser's local gamepad
// Using var instead of let to avoid temporal dead zone issues when called from websocket.js
var robotXboxConnected = false;
var localGamepadConnected = false;

function updateXboxStatus(connected) {
  // This is called when ROBOT reports controller status from ESP32
  robotXboxConnected = connected;
  const statusEl = document.getElementById('xboxStatus');
  const stateEl = document.getElementById('xboxState');
  const chipEl = document.getElementById('xboxChip');

  if (stateEl) {
    stateEl.textContent = connected ? '✓ Connected' : 'Offline';
  }
  if (statusEl) {
    if (connected) {
      statusEl.classList.add('connected');
    } else {
      statusEl.classList.remove('connected');
    }
  }
  if (chipEl) {
    if (connected) {
      chipEl.classList.add('online');
    } else {
      chipEl.classList.remove('online');
    }
  }
}

function checkLocalGamepads() {
  // Check for LOCAL browser gamepad (used for browser-side PTZ control)
  // This does NOT affect the Xbox status display - that shows ROBOT's controller
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  let found = false;

  for (const gp of gamepads) {
    if (gp && gp.connected) {
      found = true;
      break;
    }
  }

  if (found !== localGamepadConnected) {
    localGamepadConnected = found;
    console.log('[GAMEPAD] Local browser gamepad:', found ? 'connected' : 'disconnected');
  }
}

// Listen for local browser gamepad events (for browser-side PTZ control)
window.addEventListener('gamepadconnected', (e) => {
  console.log('[GAMEPAD] Local gamepad connected:', e.gamepad.id);
  localGamepadConnected = true;
});

window.addEventListener('gamepaddisconnected', (e) => {
  console.log('[GAMEPAD] Local gamepad disconnected:', e.gamepad.id);
  checkLocalGamepads(); // Check if any are still connected
});

// Poll for local gamepads (some browsers need this for PTZ control)
setInterval(checkLocalGamepads, 1000);

// ============ XBOX CONTROLLER PTZ CONTROL ============
// D-pad controls camera pan/tilt, Y button switches between cam1 and cam2
let activePtzCamera = 1;  // Start with camera 1
let lastDpadState = { up: false, down: false, left: false, right: false };
let lastYButton = false;

function updateActiveCameraIndicator() {
  // Update UI to show which camera is being controlled
  const cam1Card = document.getElementById('cam1Card');
  const cam2Card = document.getElementById('cam2Card');
  const cam1Label = document.querySelector('#cam1Card .cam-label');
  const cam2Label = document.querySelector('#cam2Card .cam-label');

  if (cam1Card && cam2Card) {
    if (activePtzCamera === 1) {
      cam1Card.style.boxShadow = '0 0 10px 2px #00ff88';
      cam2Card.style.boxShadow = '';
    } else {
      cam1Card.style.boxShadow = '';
      cam2Card.style.boxShadow = '0 0 10px 2px #00ff88';
    }
  }

  // Log camera switch to serial
  const serialDiv = document.getElementById('serial');
  if (serialDiv) {
    serialDiv.innerHTML += '<span style="color:#ffd43b">[GAMEPAD] PTZ control: Camera ' + activePtzCamera + '</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }
}

function pollGamepadForPtz() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];

  for (const gp of gamepads) {
    if (!gp || !gp.connected) continue;

    // Debug: log pressed buttons once (not every frame)
    for (let i = 0; i < gp.buttons.length; i++) {
      if (gp.buttons[i] && gp.buttons[i].pressed) {
        if (!window._lastBtn || window._lastBtn !== i) {
          window._lastBtn = i;
          console.log('[GAMEPAD] Button ' + i + ' pressed');
          const serialDiv = document.getElementById('serial');
          if (serialDiv) {
            serialDiv.innerHTML += '<span style="color:#ff9900">[GAMEPAD] Button ' + i + ' pressed</span><br>';
            serialDiv.scrollTop = serialDiv.scrollHeight;
          }
        }
      }
    }
    // Clear last button when nothing pressed
    let anyPressed = false;
    for (let i = 0; i < gp.buttons.length; i++) {
      if (gp.buttons[i] && gp.buttons[i].pressed) anyPressed = true;
    }
    if (!anyPressed) window._lastBtn = null;

    // Also check axes (some controllers report D-pad as axes 6 and 7)
    // Axis 6 = horizontal D-pad, Axis 7 = vertical D-pad
    if (gp.axes.length > 7) {
      const axisH = gp.axes[6];  // -1 = left, 1 = right
      const axisV = gp.axes[7];  // -1 = up, 1 = down
      if (Math.abs(axisH) > 0.5 || Math.abs(axisV) > 0.5) {
        if (!window._lastAxis) {
          window._lastAxis = true;
          const serialDiv = document.getElementById('serial');
          if (serialDiv) {
            serialDiv.innerHTML += '<span style="color:#ff00ff">[GAMEPAD] D-pad via axes: H=' + axisH.toFixed(1) + ' V=' + axisV.toFixed(1) + '</span><br>';
            serialDiv.scrollTop = serialDiv.scrollHeight;
          }
        }
      } else {
        window._lastAxis = false;
      }
    }

    // Xbox controller button mapping:
    // D-pad: buttons 12 (up), 13 (down), 14 (left), 15 (right)
    // Y button: button 3
    const dpadUp = gp.buttons[12] && gp.buttons[12].pressed;
    const dpadDown = gp.buttons[13] && gp.buttons[13].pressed;
    const dpadLeft = gp.buttons[14] && gp.buttons[14].pressed;
    const dpadRight = gp.buttons[15] && gp.buttons[15].pressed;
    const yButton = gp.buttons[3] && gp.buttons[3].pressed;

    // Y button toggles between cameras (on press, not hold)
    if (yButton && !lastYButton) {
      activePtzCamera = activePtzCamera === 1 ? 2 : 1;
      updateActiveCameraIndicator();
    }
    lastYButton = yButton;

    // Handle D-pad PTZ control
    // Check for state changes to send move/stop commands

    // UP
    if (dpadUp && !lastDpadState.up) {
      console.log('[DPAD] UP pressed - calling ptzMove for cam', activePtzCamera);
      const serialDiv = document.getElementById('serial');
      if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[DPAD] UP - cam' + activePtzCamera + '</span><br>';
      if (typeof ptzMove === 'function') {
        ptzMove(activePtzCamera, 0, 1.0);  // Tilt up
      } else {
        console.error('[DPAD] ptzMove is not defined!');
      }
    } else if (!dpadUp && lastDpadState.up) {
      if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
    }

    // DOWN
    if (dpadDown && !lastDpadState.down) {
      console.log('[DPAD] DOWN pressed - calling ptzMove for cam', activePtzCamera);
      const serialDiv = document.getElementById('serial');
      if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[DPAD] DOWN - cam' + activePtzCamera + '</span><br>';
      if (typeof ptzMove === 'function') {
        ptzMove(activePtzCamera, 0, -1.0);  // Tilt down
      } else {
        console.error('[DPAD] ptzMove is not defined!');
      }
    } else if (!dpadDown && lastDpadState.down) {
      if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
    }

    // LEFT
    if (dpadLeft && !lastDpadState.left) {
      console.log('[DPAD] LEFT pressed - calling ptzMove for cam', activePtzCamera);
      const serialDiv = document.getElementById('serial');
      if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[DPAD] LEFT - cam' + activePtzCamera + '</span><br>';
      if (typeof ptzMove === 'function') {
        ptzMove(activePtzCamera, -1.0, 0);  // Pan left
      } else {
        console.error('[DPAD] ptzMove is not defined!');
      }
    } else if (!dpadLeft && lastDpadState.left) {
      if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
    }

    // RIGHT
    if (dpadRight && !lastDpadState.right) {
      console.log('[DPAD] RIGHT pressed - calling ptzMove for cam', activePtzCamera);
      const serialDiv = document.getElementById('serial');
      if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[DPAD] RIGHT - cam' + activePtzCamera + '</span><br>';
      if (typeof ptzMove === 'function') {
        ptzMove(activePtzCamera, 1.0, 0);  // Pan right
      } else {
        console.error('[DPAD] ptzMove is not defined!');
      }
    } else if (!dpadRight && lastDpadState.right) {
      if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
    }

    // Update last state
    lastDpadState.up = dpadUp;
    lastDpadState.down = dpadDown;
    lastDpadState.left = dpadLeft;
    lastDpadState.right = dpadRight;

    // ALSO support axis-based D-pad (axes 6 and 7) for some controllers
    if (gp.axes.length > 7) {
      const axisH = gp.axes[6];  // -1 = left, 1 = right
      const axisV = gp.axes[7];  // -1 = up, 1 = down

      // Track axis D-pad state
      if (!window._axisDpad) window._axisDpad = { up: false, down: false, left: false, right: false };

      const axisUp = axisV < -0.5;
      const axisDown = axisV > 0.5;
      const axisLeft = axisH < -0.5;
      const axisRight = axisH > 0.5;

      // Axis UP
      if (axisUp && !window._axisDpad.up) {
        console.log('[AXIS-DPAD] UP pressed');
        const serialDiv = document.getElementById('serial');
        if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[AXIS-DPAD] UP - cam' + activePtzCamera + '</span><br>';
        if (typeof ptzMove === 'function') ptzMove(activePtzCamera, 0, 1.0);
      } else if (!axisUp && window._axisDpad.up) {
        if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
      }

      // Axis DOWN
      if (axisDown && !window._axisDpad.down) {
        console.log('[AXIS-DPAD] DOWN pressed');
        const serialDiv = document.getElementById('serial');
        if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[AXIS-DPAD] DOWN - cam' + activePtzCamera + '</span><br>';
        if (typeof ptzMove === 'function') ptzMove(activePtzCamera, 0, -1.0);
      } else if (!axisDown && window._axisDpad.down) {
        if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
      }

      // Axis LEFT
      if (axisLeft && !window._axisDpad.left) {
        console.log('[AXIS-DPAD] LEFT pressed');
        const serialDiv = document.getElementById('serial');
        if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[AXIS-DPAD] LEFT - cam' + activePtzCamera + '</span><br>';
        if (typeof ptzMove === 'function') ptzMove(activePtzCamera, -1.0, 0);
      } else if (!axisLeft && window._axisDpad.left) {
        if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
      }

      // Axis RIGHT
      if (axisRight && !window._axisDpad.right) {
        console.log('[AXIS-DPAD] RIGHT pressed');
        const serialDiv = document.getElementById('serial');
        if (serialDiv) serialDiv.innerHTML += '<span style="color:#ffd43b">[AXIS-DPAD] RIGHT - cam' + activePtzCamera + '</span><br>';
        if (typeof ptzMove === 'function') ptzMove(activePtzCamera, 1.0, 0);
      } else if (!axisRight && window._axisDpad.right) {
        if (typeof ptzStop === 'function') ptzStop(activePtzCamera);
      }

      window._axisDpad.up = axisUp;
      window._axisDpad.down = axisDown;
      window._axisDpad.left = axisLeft;
      window._axisDpad.right = axisRight;
    }

    break;  // Only use first connected gamepad
  }
}

// Poll gamepad at 60fps for responsive PTZ control
setInterval(pollGamepadForPtz, 16);

// ============ SERIAL POPUP ============
function toggleSerialPopup() {
  const popup = document.getElementById('serialPopup');
  if (popup) {
    popup.classList.toggle('open');
  }
}

// Make serial popup draggable
(function() {
  const popup = document.getElementById('serialPopup');
  const header = document.getElementById('serialPopupHeader');
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
    let x = e.clientX - offsetX;
    let y = e.clientY - offsetY;
    // Keep within viewport
    x = Math.max(0, Math.min(x, window.innerWidth - popup.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('mouseup', function() {
    isDragging = false;
  });

  // Touch support for mobile
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
    let x = touch.clientX - offsetX;
    let y = touch.clientY - offsetY;
    x = Math.max(0, Math.min(x, window.innerWidth - popup.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - popup.offsetHeight));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  });

  document.addEventListener('touchend', function() {
    isDragging = false;
  });
})();
