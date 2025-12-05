// ============ NAVIGATION CONTROL ============
console.log('[CONTROLS.JS] LOADED - Version 2024-12-04');
let selectedDir = null;
let selectedDist = null;
let commandQueue = [];
let gridOffsetX = 0;
let gridOffsetY = 0;
let robotHeading = 0;

const dirLabels = { F: 'FWD', B: 'BACK', L: 'LEFT', R: 'RIGHT' };
const PIXELS_PER_FOOT = 13;  // Scaled for display
const FEET_TO_METERS = 0.3048;

function updateDisplay() {
  document.getElementById('currentDir').textContent = selectedDir ? dirLabels[selectedDir] : '--';

  // Update direction buttons (works with compass-dir, ctrl-dir-btn, ctrl-round-btn, tank-steer-btn, tank-dir-btn)
  document.querySelectorAll('.compass-dir, .ctrl-dir-btn, .ctrl-round-btn, .tank-steer-btn, .tank-dir-btn').forEach(d => {
    d.classList.remove('active');
  });
  if (selectedDir) {
    const el = document.getElementById('dir' + selectedDir);
    if (el) {
      el.classList.add('active');
    }
  }

  // Update center display - queue shown inside chassis
  updateChassisQueueDisplay();

  document.querySelectorAll('.dist-btn').forEach(d => {
    d.style.background = 'rgba(81, 207, 102, 0.2)';
    d.style.color = '#51cf66';
  });
  if (selectedDist) {
    document.querySelectorAll('.dist-btn').forEach(d => {
      if (parseFloat(d.dataset.dist) === selectedDist) {
        d.style.background = '#51cf66';
        d.style.color = '#000';
      }
    });
  }

  updateQueueDisplay();

  if (commandQueue.length > 0) {
    setStatus(commandQueue.length + ' command(s) queued - Press GO', 'idle');
  } else if (selectedDir && selectedDist) {
    setStatus(selectedDist + 'ft ' + dirLabels[selectedDir] + ' - Tap again to add, or GO', 'idle');
  } else if (selectedDir) {
    setStatus('Direction: ' + dirLabels[selectedDir] + ' - Now tap distance', 'idle');
  } else {
    setStatus('Tap direction, then distance', 'idle');
  }
}

function updateQueueDisplay() {
  // Legacy - kept for compatibility
}

function updateChassisQueueDisplay() {
  const ctrlQueue = document.getElementById('ctrlQueueDisplay');
  const ctrlLabel = document.getElementById('ctrlLabel');
  if (!ctrlQueue || !ctrlLabel) return;

  if (commandQueue.length === 0) {
    ctrlLabel.textContent = 'CEMANI';
    ctrlQueue.innerHTML = '';
    return;
  }

  // Show queue count in label
  ctrlLabel.textContent = commandQueue.length + ' CMD';

  // Show compact queue items inside chassis
  let html = '';
  commandQueue.forEach((cmd, i) => {
    html += '<div class="ctrl-queue-item">' + cmd.dist + '\' ' + cmd.dir + '</div>';
  });
  ctrlQueue.innerHTML = html;
}

function removeFromQueue(index) {
  commandQueue.splice(index, 1);
  updateDisplay();
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
  selectedDir = dir;
  updateDisplay();
}

function selectDistance(distance) {
  if (!selectedDir) {
    setStatus('Tap a direction first!', 'error');
    return;
  }

  commandQueue.push({ dir: selectedDir, dist: distance });

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#74c0fc">[QUEUE] Added ' + distance + 'ft ' + dirLabels[selectedDir] + '</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;

  selectedDir = null;
  selectedDist = null;
  updateDisplay();
}

function executeQueue() {
  if (commandQueue.length === 0) {
    setStatus('No commands queued!', 'error');
    return;
  }

  const commands = [...commandQueue];
  commandQueue = [];

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#51cf66">[GO] Executing ' + commands.length + ' command(s)...</span><br>';
  serialDiv.scrollTop = serialDiv.scrollHeight;

  setStatus('EXECUTING ' + commands.length + ' commands...', 'moving');

  let currentIndex = 0;

  function executeNext() {
    if (currentIndex >= commands.length) {
      setStatus('Completed ' + commands.length + ' commands', 'idle');
      selectedDir = null;
      selectedDist = null;
      // Restore CEMANI label after completion
      const ctrlLabel = document.getElementById('ctrlLabel');
      const ctrlQueue = document.getElementById('ctrlQueueDisplay');
      if (ctrlLabel) ctrlLabel.textContent = 'CEMANI';
      if (ctrlQueue) ctrlQueue.innerHTML = '';
      updateDisplay();
      return;
    }

    const cmd = commands[currentIndex];
    setStatus('Moving ' + (currentIndex + 1) + '/' + commands.length + ': ' + cmd.dist + 'ft ' + dirLabels[cmd.dir], 'moving');

    // Update tank control center display during execution
    const ctrlLabel = document.getElementById('ctrlLabel');
    const ctrlQueue = document.getElementById('ctrlQueueDisplay');
    if (ctrlLabel) ctrlLabel.textContent = 'MOVE';
    if (ctrlQueue) ctrlQueue.innerHTML = '<div class="ctrl-queue-item">' + cmd.dist + '\' ' + dirLabels[cmd.dir] + '</div>';

    // Convert feet to meters for the robot command
    const distanceMeters = cmd.dist * FEET_TO_METERS;
    ws.send(JSON.stringify({
      type: 'move_command',
      distance: distanceMeters,
      direction: cmd.dir
    }));

    serialDiv.innerHTML += '<span style="color:#51cf66">[MOVE] ' + cmd.dist + 'ft ' + dirLabels[cmd.dir] + '</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;

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

    let totalTime;
    if (cmd.dir === 'L' || cmd.dir === 'R') {
      totalTime = 90 * 100 + 500;
    } else {
      totalTime = cmd.dist * 100 * 200 + 500;
    }

    currentIndex++;
    setTimeout(executeNext, totalTime);
  }

  executeNext();
  updateDisplay();
}

function emergencyStop() {
  ws.send(JSON.stringify({ type: 'emergency_stop' }));
  selectedDir = null;
  selectedDist = null;
  commandQueue = [];
  updateDisplay();
}

// ============ LIGHT TOGGLE ============
let lightOn = false;
function toggleLight() {
  lightOn = !lightOn;
  const btn = document.getElementById('lightToggleBtn');
  if (btn) {
    btn.classList.toggle('on', lightOn);
  }
  // Send light command to server
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'light_toggle', state: lightOn }));
  }
  console.log('[LIGHT] Toggled:', lightOn ? 'ON' : 'OFF');
}

function clearQueue() {
  selectedDir = null;
  selectedDist = null;
  commandQueue = [];
  gridOffsetX = 0;
  gridOffsetY = 0;
  robotHeading = 0;
  updateRadarRobot();
  updateDisplay();
  setStatus('Cleared. Tap direction to start.', 'idle');

  const serialDiv = document.getElementById('serial');
  serialDiv.innerHTML += '<span style="color:#74c0fc">[CLEAR] Queue cleared, radar reset</span><br>';
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
