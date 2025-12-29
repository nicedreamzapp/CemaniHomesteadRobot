// ============ XBOX CONTROLLER AND GAMEPAD PTZ CONTROL ============
// Handles Xbox controller status and browser gamepad PTZ control
console.log('[GAMEPAD-CONTROL.JS] LOADED');

// Track ROBOT's Xbox controller status (from ESP32)
var robotXboxConnected = false;
var localGamepadConnected = false;

function updateXboxStatus(connected) {
  robotXboxConnected = connected;
  const statusEl = document.getElementById('xboxStatus');
  const stateEl = document.getElementById('xboxState');
  const cardEl = document.getElementById('xboxCard');

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
  if (cardEl) {
    if (connected) {
      cardEl.classList.add('online');
    } else {
      cardEl.classList.remove('online');
    }
  }
  const mobileXbox = document.getElementById('mobileXbox');
  if (mobileXbox) mobileXbox.className = 'mobile-dev' + (connected ? ' online' : '');
}

function checkLocalGamepads() {
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

// Listen for local browser gamepad events
window.addEventListener('gamepadconnected', (e) => {
  console.log('[GAMEPAD] Local gamepad connected:', e.gamepad.id);
  localGamepadConnected = true;
});

window.addEventListener('gamepaddisconnected', (e) => {
  console.log('[GAMEPAD] Local gamepad disconnected:', e.gamepad.id);
  checkLocalGamepads();
});

// Poll for local gamepads
setInterval(checkLocalGamepads, 1000);

// ============ XBOX CONTROLLER PTZ CONTROL ============
let activePtzCamera = 1;
let lastDpadState = { up: false, down: false, left: false, right: false };
let lastYButton = false;

function updateActiveCameraIndicator() {
  const cam1Card = document.getElementById('cam1Card');
  const cam2Card = document.getElementById('cam2Card');

  if (cam1Card && cam2Card) {
    if (activePtzCamera === 1) {
      cam1Card.style.boxShadow = '0 0 10px 2px #00ff88';
      cam2Card.style.boxShadow = '';
    } else {
      cam1Card.style.boxShadow = '';
      cam2Card.style.boxShadow = '0 0 10px 2px #00ff88';
    }
  }

  const serialDiv = document.getElementById('serial');
  if (serialDiv) {
    serialDiv.innerHTML += '<span style="color:#ffd43b">[GAMEPAD] PTZ control: Camera ' + activePtzCamera + '</span><br>';
    serialDiv.scrollTop = serialDiv.scrollHeight;
  }
}

function getPtzFunctions() {
  // Get PTZ functions from cameras-ptz module or fallback
  if (window.camerasPtzModule) {
    return {
      move: window.camerasPtzModule.ptzMove,
      stop: window.camerasPtzModule.ptzStop
    };
  }
  return {
    move: typeof ptzMove === 'function' ? ptzMove : null,
    stop: typeof ptzStop === 'function' ? ptzStop : null
  };
}

function pollGamepadForPtz() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const ptz = getPtzFunctions();

  for (const gp of gamepads) {
    if (!gp || !gp.connected) continue;

    // Debug button presses
    for (let i = 0; i < gp.buttons.length; i++) {
      if (gp.buttons[i] && gp.buttons[i].pressed) {
        if (!window._lastBtn || window._lastBtn !== i) {
          window._lastBtn = i;
          console.log('[GAMEPAD] Button ' + i + ' pressed');
        }
      }
    }
    let anyPressed = false;
    for (let i = 0; i < gp.buttons.length; i++) {
      if (gp.buttons[i] && gp.buttons[i].pressed) anyPressed = true;
    }
    if (!anyPressed) window._lastBtn = null;

    // Xbox controller button mapping
    const dpadUp = gp.buttons[12] && gp.buttons[12].pressed;
    const dpadDown = gp.buttons[13] && gp.buttons[13].pressed;
    const dpadLeft = gp.buttons[14] && gp.buttons[14].pressed;
    const dpadRight = gp.buttons[15] && gp.buttons[15].pressed;
    const yButton = gp.buttons[3] && gp.buttons[3].pressed;

    // Y button toggles cameras
    if (yButton && !lastYButton) {
      activePtzCamera = activePtzCamera === 1 ? 2 : 1;
      updateActiveCameraIndicator();
    }
    lastYButton = yButton;

    // D-pad PTZ control
    if (dpadUp && !lastDpadState.up) {
      if (ptz.move) ptz.move(activePtzCamera, 0, 1.0);
    } else if (!dpadUp && lastDpadState.up) {
      if (ptz.stop) ptz.stop(activePtzCamera);
    }

    if (dpadDown && !lastDpadState.down) {
      if (ptz.move) ptz.move(activePtzCamera, 0, -1.0);
    } else if (!dpadDown && lastDpadState.down) {
      if (ptz.stop) ptz.stop(activePtzCamera);
    }

    if (dpadLeft && !lastDpadState.left) {
      if (ptz.move) ptz.move(activePtzCamera, -1.0, 0);
    } else if (!dpadLeft && lastDpadState.left) {
      if (ptz.stop) ptz.stop(activePtzCamera);
    }

    if (dpadRight && !lastDpadState.right) {
      if (ptz.move) ptz.move(activePtzCamera, 1.0, 0);
    } else if (!dpadRight && lastDpadState.right) {
      if (ptz.stop) ptz.stop(activePtzCamera);
    }

    lastDpadState.up = dpadUp;
    lastDpadState.down = dpadDown;
    lastDpadState.left = dpadLeft;
    lastDpadState.right = dpadRight;

    // Support axis-based D-pad (axes 6 and 7)
    if (gp.axes.length > 7) {
      const axisH = gp.axes[6];
      const axisV = gp.axes[7];

      if (!window._axisDpad) window._axisDpad = { up: false, down: false, left: false, right: false };

      const axisUp = axisV < -0.5;
      const axisDown = axisV > 0.5;
      const axisLeft = axisH < -0.5;
      const axisRight = axisH > 0.5;

      if (axisUp && !window._axisDpad.up) {
        if (ptz.move) ptz.move(activePtzCamera, 0, 1.0);
      } else if (!axisUp && window._axisDpad.up) {
        if (ptz.stop) ptz.stop(activePtzCamera);
      }

      if (axisDown && !window._axisDpad.down) {
        if (ptz.move) ptz.move(activePtzCamera, 0, -1.0);
      } else if (!axisDown && window._axisDpad.down) {
        if (ptz.stop) ptz.stop(activePtzCamera);
      }

      if (axisLeft && !window._axisDpad.left) {
        if (ptz.move) ptz.move(activePtzCamera, -1.0, 0);
      } else if (!axisLeft && window._axisDpad.left) {
        if (ptz.stop) ptz.stop(activePtzCamera);
      }

      if (axisRight && !window._axisDpad.right) {
        if (ptz.move) ptz.move(activePtzCamera, 1.0, 0);
      } else if (!axisRight && window._axisDpad.right) {
        if (ptz.stop) ptz.stop(activePtzCamera);
      }

      window._axisDpad.up = axisUp;
      window._axisDpad.down = axisDown;
      window._axisDpad.left = axisLeft;
      window._axisDpad.right = axisRight;
    }

    break; // Only use first connected gamepad
  }
}

// Poll gamepad at 60fps for responsive PTZ control
setInterval(pollGamepadForPtz, 16);

// Export module
window.gamepadControlModule = {
  updateXboxStatus,
  checkLocalGamepads,
  getActivePtzCamera: () => activePtzCamera
};
