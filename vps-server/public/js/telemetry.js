// ============ DRIVER TELEMETRY ============
// Convert Celsius to Fahrenheit
function cToF(celsius) {
  return celsius * 9 / 5 + 32;
}

// Convert meters to feet
const METERS_TO_FEET = 3.28084;
function mToFt(meters) {
  return meters * METERS_TO_FEET;
}

// Convert mm to feet
function mmToFt(mm) {
  return (mm / 1000) * METERS_TO_FEET;
}

// Convert RPM to MPH for 203mm diameter wheels
// Circumference = π × 0.203m = 0.6377m
// MPH = RPM × circumference(m) × 60(min/hr) / 1609.34(m/mile)
const WHEEL_DIAMETER_M = 0.203;
const WHEEL_CIRCUMFERENCE_M = Math.PI * WHEEL_DIAMETER_M;
const RPM_TO_MPH = WHEEL_CIRCUMFERENCE_M * 60 / 1609.34;  // ≈ 0.02377

function rpmToMph(rpm) {
  return Math.abs(rpm) * RPM_TO_MPH;
}

function formatMph(mph) {
  if (mph < 0.01) return '0.00';
  if (mph < 0.1) return mph.toFixed(3);
  if (mph < 1) return mph.toFixed(2);
  return mph.toFixed(1);
}

// Format encoder ticks for compact display (e.g., 12.3K, 1.5M)
function formatTicks(ticks) {
  const abs = Math.abs(ticks);
  const sign = ticks < 0 ? '-' : '';
  if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K';
  return ticks.toString();
}

// Parse TELEM data from serial
// Format: TELEM,battV,battPct,tempLF,tempLR,tempRF,tempRR,drvTemp1,drvTemp2,velL,velR,torqueL,torqueR,posL,posR
// Index:    0     1      2      3      4      5      6       7        8      9    10     11      12    13   14
function parseTelemFromSerial(line) {
  var trimmed = line.trim();
  if (!trimmed.startsWith('TELEM,')) return null;
  const parts = trimmed.split(',');
  if (parts.length < 15) return null;

  const tempLF = parseInt(parts[3]);
  const tempLR = parseInt(parts[4]);
  const tempRF = parseInt(parts[5]);
  const tempRR = parseInt(parts[6]);
  const drvTemp1 = parseInt(parts[7]);  // Driver 1 (RIGHT side)
  const drvTemp2 = parseInt(parts[8]);  // Driver 2 (LEFT side)

  return {
    batteryV: parseFloat(parts[1]),
    batteryPct: parseInt(parts[2]),
    // All 4 motor temps (already in Fahrenheit from Teensy)
    motorTempLF_F: tempLF,
    motorTempLR_F: tempLR,
    motorTempRF_F: tempRF,
    motorTempRR_F: tempRR,
    // Legacy L/R averages
    motorTempL_F: Math.round((tempLF + tempLR) / 2),
    motorTempR_F: Math.round((tempRF + tempRR) / 2),
    // Driver board temps (actual values from Teensy)
    driverTemp1_F: drvTemp1,  // RIGHT side driver
    driverTemp2_F: drvTemp2,  // LEFT side driver
    // Velocities
    velL: parseFloat(parts[9]),
    velR: parseFloat(parts[10]),
    // Torque
    torqueL: parseFloat(parts[11]),
    torqueR: parseFloat(parts[12]),
    // Encoder positions
    posL: parseInt(parts[13]),
    posR: parseInt(parts[14])
  };
}

function updateDriverTelemetry(data) {
  // Battery with visual bar (EV-style)
  if (data.batteryV !== undefined) {
    document.getElementById('batteryVoltage').textContent = data.batteryV.toFixed(1);
    document.getElementById('batteryPercent').textContent = data.batteryPct;

    // Update battery fill bar
    const fill = document.getElementById('batteryFill');
    const bar = document.getElementById('batteryBar');
    if (fill) fill.style.width = data.batteryPct + '%';

    // Update header battery too
    const headerFill = document.getElementById('headerBatteryFill');
    const headerPct = document.getElementById('headerBatteryPercent');
    const headerVolt = document.getElementById('headerBatteryVoltage');
    if (headerFill) headerFill.style.width = data.batteryPct + '%';
    if (headerPct) headerPct.textContent = data.batteryPct;
    if (headerVolt) headerVolt.textContent = data.batteryV.toFixed(1);

    // Color based on level
    if (bar) {
      bar.classList.remove('warning', 'critical');
      if (data.batteryPct < 20) bar.classList.add('critical');
      else if (data.batteryPct < 40) bar.classList.add('warning');
    }
  }

  // Driver 1 temperature (RIGHT side) - already in Fahrenheit
  if (data.driverTemp1_F !== undefined) {
    const el = document.getElementById('driver1Temp');
    const item = document.getElementById('driver1TempItem');
    if (el) el.textContent = data.driverTemp1_F;
    if (item) {
      item.classList.remove('warning');
      if (data.driverTemp1_F > 158) item.classList.add('warning');
    }
  }

  // Driver 2 temperature (LEFT side) - already in Fahrenheit
  if (data.driverTemp2_F !== undefined) {
    const el = document.getElementById('driver2Temp');
    const item = document.getElementById('driver2TempItem');
    if (el) el.textContent = data.driverTemp2_F;
    if (item) {
      item.classList.remove('warning');
      if (data.driverTemp2_F > 158) item.classList.add('warning');
    }
  }

  // Legacy driver temp avg (hidden)
  if (data.driverTemp1_F !== undefined && data.driverTemp2_F !== undefined) {
    const avgDriverTemp = Math.round((data.driverTemp1_F + data.driverTemp2_F) / 2);
    const el = document.getElementById('driverTemp');
    if (el) el.textContent = avgDriverTemp;
  }

  // Motor temperatures - all 4 wheels now have individual temps!
  // Left Front
  if (data.motorTempLF_F !== undefined) {
    const el = document.getElementById('motorTempLF');
    if (el) el.textContent = data.motorTempLF_F;
    // Also update control panel temps
    const ctrlEl = document.getElementById('ctrlTempLF');
    if (ctrlEl) ctrlEl.textContent = data.motorTempLF_F;
  }
  // Left Rear
  if (data.motorTempLR_F !== undefined) {
    const el = document.getElementById('motorTempLR');
    if (el) el.textContent = data.motorTempLR_F;
    const ctrlEl = document.getElementById('ctrlTempLR');
    if (ctrlEl) ctrlEl.textContent = data.motorTempLR_F;
  }
  // Right Front
  if (data.motorTempRF_F !== undefined) {
    const el = document.getElementById('motorTempRF');
    if (el) el.textContent = data.motorTempRF_F;
    const ctrlEl = document.getElementById('ctrlTempRF');
    if (ctrlEl) ctrlEl.textContent = data.motorTempRF_F;
  }
  // Right Rear
  if (data.motorTempRR_F !== undefined) {
    const el = document.getElementById('motorTempRR');
    if (el) el.textContent = data.motorTempRR_F;
    const ctrlEl = document.getElementById('ctrlTempRR');
    if (ctrlEl) ctrlEl.textContent = data.motorTempRR_F;
  }

  // Legacy L/R averages for compatibility
  if (data.motorTempL_F !== undefined) {
    const el = document.getElementById('motorTempL');
    if (el) el.textContent = data.motorTempL_F;
  }
  if (data.motorTempR_F !== undefined) {
    const el = document.getElementById('motorTempR');
    if (el) el.textContent = data.motorTempR_F;
  }
  // Legacy avg
  if (data.motorTempL_F !== undefined && data.motorTempR_F !== undefined) {
    const el = document.getElementById('motorTempAvg');
    if (el) el.textContent = Math.round((data.motorTempL_F + data.motorTempR_F) / 2);
  }

  // Velocities - show MPH and animate wheels with direction
  if (data.velL !== undefined) {
    const mphL = rpmToMph(data.velL);
    document.getElementById('velocityL').textContent = formatMph(mphL);

    // Animate left wheels with direction arrows
    const wheelLF = document.getElementById('wheelLF');
    const wheelLR = document.getElementById('wheelLR');
    const arrowLF = document.getElementById('arrowLF');
    const arrowLR = document.getElementById('arrowLR');
    const isSpinning = Math.abs(data.velL) > 0.5;
    const direction = data.velL > 0 ? 'forward' : (data.velL < 0 ? 'backward' : 'stopped');

    [wheelLF, wheelLR].forEach(wheel => {
      if (wheel) {
        wheel.classList.remove('spinning-forward', 'spinning-backward', 'stopped');
        if (isSpinning) {
          wheel.classList.add('spinning-' + direction);
        } else {
          wheel.classList.add('stopped');
        }
        wheel.dataset.direction = direction;
      }
    });

    // Update direction arrows next to wheels
    [arrowLF, arrowLR].forEach(arrow => {
      if (arrow) {
        arrow.classList.remove('arrow-forward', 'arrow-backward', 'arrow-stopped');
        arrow.classList.add('arrow-' + direction);
      }
    });

    // Also animate control panel left wheels
    const ctrlWheelLF = document.getElementById('ctrlWheelLF');
    const ctrlWheelLR = document.getElementById('ctrlWheelLR');
    const ctrlArrowLF = document.getElementById('ctrlArrowLF');
    const ctrlArrowLR = document.getElementById('ctrlArrowLR');
    [ctrlWheelLF, ctrlWheelLR].forEach(wheel => {
      if (wheel) {
        wheel.classList.remove('forward', 'backward');
        if (isSpinning) wheel.classList.add(direction);
      }
    });
    [ctrlArrowLF, ctrlArrowLR].forEach(arrow => {
      if (arrow) {
        arrow.textContent = direction === 'forward' ? '▲' : (direction === 'backward' ? '▼' : '');
      }
    });
  }
  if (data.velR !== undefined) {
    const mphR = rpmToMph(data.velR);
    document.getElementById('velocityR').textContent = formatMph(mphR);

    // Animate right wheels with direction arrows
    const wheelRF = document.getElementById('wheelRF');
    const wheelRR = document.getElementById('wheelRR');
    const arrowRF = document.getElementById('arrowRF');
    const arrowRR = document.getElementById('arrowRR');
    const isSpinning = Math.abs(data.velR) > 0.5;
    const direction = data.velR > 0 ? 'forward' : (data.velR < 0 ? 'backward' : 'stopped');

    [wheelRF, wheelRR].forEach(wheel => {
      if (wheel) {
        wheel.classList.remove('spinning-forward', 'spinning-backward', 'stopped');
        if (isSpinning) {
          wheel.classList.add('spinning-' + direction);
        } else {
          wheel.classList.add('stopped');
        }
        wheel.dataset.direction = direction;
      }
    });

    // Update direction arrows next to wheels
    [arrowRF, arrowRR].forEach(arrow => {
      if (arrow) {
        arrow.classList.remove('arrow-forward', 'arrow-backward', 'arrow-stopped');
        arrow.classList.add('arrow-' + direction);
      }
    });

    // Also animate control panel right wheels
    const ctrlWheelRF = document.getElementById('ctrlWheelRF');
    const ctrlWheelRR = document.getElementById('ctrlWheelRR');
    const ctrlArrowRF = document.getElementById('ctrlArrowRF');
    const ctrlArrowRR = document.getElementById('ctrlArrowRR');
    [ctrlWheelRF, ctrlWheelRR].forEach(wheel => {
      if (wheel) {
        wheel.classList.remove('forward', 'backward');
        if (isSpinning) wheel.classList.add(direction);
      }
    });
    [ctrlArrowRF, ctrlArrowRR].forEach(arrow => {
      if (arrow) {
        arrow.textContent = direction === 'forward' ? '▲' : (direction === 'backward' ? '▼' : '');
      }
    });
  }

  // Torque (already in Amps from Teensy)
  if (data.torqueL !== undefined) {
    document.getElementById('torqueL').textContent = data.torqueL.toFixed(1);
  }
  if (data.torqueR !== undefined) {
    document.getElementById('torqueR').textContent = data.torqueR.toFixed(1);
  }

  // Position (encoder counts) - show in position tracker
  if (data.posL !== undefined) {
    const el = document.getElementById('positionL');
    if (el) el.textContent = data.posL.toLocaleString();
    const encL = document.getElementById('encL');
    if (encL) encL.textContent = formatTicks(data.posL);
  }
  if (data.posR !== undefined) {
    const el = document.getElementById('positionR');
    if (el) el.textContent = data.posR.toLocaleString();
    const encR = document.getElementById('encR');
    if (encR) encR.textContent = formatTicks(data.posR);
  }

  // Calculate odometry from encoder positions
  if (data.posL !== undefined && data.posR !== undefined) {
    updateOdometryFromEncoders(data.posL, data.posR);
  }

  // Odometry display (in feet)
  if (data.odomDistance !== undefined) {
    const tripDist = document.getElementById('odomTripDist');
    if (tripDist) tripDist.textContent = mmToFt(data.odomDistance).toFixed(1);
  }
  if (data.odomHeadingDeg !== undefined) {
    const heading = document.getElementById('odomHeading');
    if (heading) heading.textContent = data.odomHeadingDeg;
  }
  if (data.odomX !== undefined) {
    const xEl = document.getElementById('odomX');
    if (xEl) xEl.textContent = mmToFt(data.odomX).toFixed(1) + ' ft';
  }
  if (data.odomY !== undefined) {
    const yEl = document.getElementById('odomY');
    if (yEl) yEl.textContent = mmToFt(data.odomY).toFixed(1) + ' ft';
  }

  // Sync server odometry to local odomState for 3D view
  if (data.odomX !== undefined) odomState.x = data.odomX;
  if (data.odomY !== undefined) odomState.y = data.odomY;
  if (data.odomHeading !== undefined) odomState.heading = data.odomHeading;
  if (data.odomDistance !== undefined) odomState.totalDistance = data.odomDistance;
  if (data.odomTrail !== undefined && data.odomTrail.length > 0) {
    odomState.trail = data.odomTrail;
  }

  // Draw odometry mini-map
  if (data.odomTrail !== undefined || data.odomX !== undefined) {
    drawOdometryMap(data);
  }
}

// ============ ODOMETRY MINI-MAP ============
let odomCanvas = null;
let odomCtx = null;

function initOdomCanvas() {
  odomCanvas = document.getElementById('odomCanvas');
  if (odomCanvas) {
    odomCtx = odomCanvas.getContext('2d');
    // Set actual resolution
    const rect = odomCanvas.getBoundingClientRect();
    odomCanvas.width = rect.width * 2;  // 2x for retina
    odomCanvas.height = rect.height * 2;
    odomCtx.scale(2, 2);
  }
}

function drawOdometryMap(data) {
  if (!odomCtx) initOdomCanvas();
  if (!odomCtx) return;

  const canvas = odomCanvas;
  const ctx = odomCtx;
  const w = canvas.width / 2;
  const h = canvas.height / 2;
  const cx = w / 2;
  const cy = h / 2;

  // Clear
  ctx.fillStyle = 'rgba(0, 10, 20, 0.95)';
  ctx.fillRect(0, 0, w, h);

  // Draw grid (1 foot squares = 304.8mm)
  // pixels per foot - start with reasonable default
  const ftPerSquare = 1;  // 1 foot per grid square
  const mmPerSquare = ftPerSquare * 304.8;

  // Base scale: how many pixels per foot
  let pixelsPerFt = 15;  // Default scale

  // Auto-scale based on max distance traveled
  let maxDistMm = 1000;  // Start at ~3ft view
  if (data.odomTrail && data.odomTrail.length > 0) {
    data.odomTrail.forEach(p => {
      maxDistMm = Math.max(maxDistMm, Math.abs(p.x), Math.abs(p.y));
    });
    if (data.odomX) maxDistMm = Math.max(maxDistMm, Math.abs(data.odomX));
    if (data.odomY) maxDistMm = Math.max(maxDistMm, Math.abs(data.odomY));
  }
  // Scale to fit with padding
  const maxDistFt = maxDistMm * FT_PER_MM;
  const viewRadiusFt = Math.max(3, maxDistFt * 1.3);  // At least 3ft radius
  pixelsPerFt = Math.min(w, h) / (viewRadiusFt * 2);

  const gridSpacing = pixelsPerFt * ftPerSquare;  // pixels per grid line

  ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
  ctx.lineWidth = 0.5;

  // Vertical lines
  for (let x = cx % gridSpacing; x < w; x += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  // Horizontal lines
  for (let y = cy % gridSpacing; y < h; y += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Draw crosshairs at center (start position)
  ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  // Scale indicator removed from canvas - shown in HTML tracker-scale div instead

  // Convert mm to screen pixels (Y is flipped: up on screen = positive Y in world)
  function mmToScreen(xMm, yMm) {
    const xFt = xMm * FT_PER_MM;
    const yFt = yMm * FT_PER_MM;
    return {
      x: cx + xFt * pixelsPerFt,
      y: cy - yFt * pixelsPerFt  // Flip Y so forward (positive Y) goes UP
    };
  }

  // Draw start marker (red dot)
  ctx.fillStyle = '#ff6b6b';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Draw trail - connect all points including current position
  if (data.odomTrail && data.odomTrail.length >= 1) {
    // Draw thick glow/shadow first for visibility
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.5)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const first = mmToScreen(data.odomTrail[0].x, data.odomTrail[0].y);
    ctx.moveTo(first.x, first.y);

    data.odomTrail.forEach((p, i) => {
      if (i > 0) {
        const screen = mmToScreen(p.x, p.y);
        ctx.lineTo(screen.x, screen.y);
      }
    });

    if (data.odomX !== undefined && data.odomY !== undefined) {
      const current = mmToScreen(data.odomX, data.odomY);
      ctx.lineTo(current.x, current.y);
    }
    ctx.stroke();

    // Draw bright main trail on top
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);

    data.odomTrail.forEach((p, i) => {
      if (i > 0) {
        const screen = mmToScreen(p.x, p.y);
        ctx.lineTo(screen.x, screen.y);
      }
    });

    if (data.odomX !== undefined && data.odomY !== undefined) {
      const current = mmToScreen(data.odomX, data.odomY);
      ctx.lineTo(current.x, current.y);
    }

    ctx.stroke();
  }

  // Draw current position - robot with clear front/rear
  if (data.odomX !== undefined && data.odomY !== undefined) {
    const pos = mmToScreen(data.odomX, data.odomY);
    const posX = pos.x;
    const posY = pos.y;
    // Heading: positive = turning right (clockwise when viewed from above)
    // Canvas rotation: positive = clockwise
    // Robot starts facing UP (north), heading 0 = up
    // When heading increases (turn right), robot rotates clockwise
    const heading = -(data.odomHeading || 0);  // Negate for canvas coords

    ctx.save();
    ctx.translate(posX, posY);
    ctx.rotate(heading);

    // Robot body - rectangular chassis
    const bodyW = 14;
    const bodyH = 20;

    // Chassis shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(-bodyW/2 + 2, -bodyH/2 + 2, bodyW, bodyH);

    // Main chassis
    ctx.fillStyle = '#1a3a2a';
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.fillRect(-bodyW/2, -bodyH/2, bodyW, bodyH);
    ctx.strokeRect(-bodyW/2, -bodyH/2, bodyW, bodyH);

    // Wheels (left and right)
    ctx.fillStyle = '#333';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    // Left wheels
    ctx.fillRect(-bodyW/2 - 4, -bodyH/2 + 2, 4, 6);
    ctx.strokeRect(-bodyW/2 - 4, -bodyH/2 + 2, 4, 6);
    ctx.fillRect(-bodyW/2 - 4, bodyH/2 - 8, 4, 6);
    ctx.strokeRect(-bodyW/2 - 4, bodyH/2 - 8, 4, 6);
    // Right wheels
    ctx.fillRect(bodyW/2, -bodyH/2 + 2, 4, 6);
    ctx.strokeRect(bodyW/2, -bodyH/2 + 2, 4, 6);
    ctx.fillRect(bodyW/2, bodyH/2 - 8, 4, 6);
    ctx.strokeRect(bodyW/2, bodyH/2 - 8, 4, 6);

    // Front indicator - green triangle pointing forward (up)
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.moveTo(0, -bodyH/2 - 6);  // Tip
    ctx.lineTo(-5, -bodyH/2);     // Bottom left
    ctx.lineTo(5, -bodyH/2);      // Bottom right
    ctx.closePath();
    ctx.fill();

    // "FWD" text
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 6px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FWD', 0, -bodyH/2 + 6);

    // Rear indicator - red bar
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(-4, bodyH/2 - 3, 8, 3);

    // Center dot
    ctx.fillStyle = '#51cf66';
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

// ============ ODOMETRY FROM ENCODERS ============
// Wheel specs: 203mm diameter, 16384 ticks/rev (ZLAC8015D)
const WHEEL_DIAMETER_MM = 203;
const WHEEL_CIRCUMFERENCE_MM = Math.PI * WHEEL_DIAMETER_MM;  // ~637.7mm
const TICKS_PER_REV = 16384;
const MM_PER_TICK = WHEEL_CIRCUMFERENCE_MM / TICKS_PER_REV;  // ~0.0389mm/tick
const WHEEL_BASE_MM = 600;  // Distance between wheels in mm
const FT_PER_MM = 1 / 304.8;  // 1 foot = 304.8mm

// Noise filtering thresholds
const ENCODER_NOISE_TICKS = 10;  // Ignore changes smaller than this (was 3)
const MAX_DELTA_PER_UPDATE = 5000;  // Reject jumps larger than this (encoder error)

// Odometry state
let odomState = {
  lastPosL: null,
  lastPosR: null,
  x: 0,           // mm
  y: 0,           // mm
  heading: 0,     // radians
  totalDistance: 0, // mm
  trail: [{x: 0, y: 0}],
  lastDraw: 0,
  initialized: false  // Track if we've received first valid reading
};

// Make resetOdometry available globally
window.resetOdometry = function() {
  // Send reset command to Teensy (via WebSocket -> server -> ESP32 -> Teensy)
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'command', data: 'RESET_ODOM' }));
    console.log('[ODOM] Sent RESET_ODOM command to robot');
  } else {
    console.warn('[ODOM] WebSocket not connected - cannot send reset to robot');
  }

  // Also reset local state
  odomState = {
    lastPosL: null,  // Will be set from next encoder reading
    lastPosR: null,
    x: 0,
    y: 0,
    heading: 0,
    totalDistance: 0,
    trail: [],  // Empty trail - will add origin point after baseline set
    lastDraw: 0,
    initialized: false  // Force re-initialization from current encoder position
  };

  // Update UI immediately
  const tripDist = document.getElementById('odomTripDist');
  if (tripDist) tripDist.textContent = '0.0';
  const headingEl = document.getElementById('odomHeading');
  if (headingEl) headingEl.textContent = '0';
  const encL = document.getElementById('encL');
  if (encL) encL.textContent = '0';
  const encR = document.getElementById('encR');
  if (encR) encR.textContent = '0';

  // Clear 3D LIDAR SLAM map and trail
  if (typeof clearLidarSlamMap === 'function') {
    clearLidarSlamMap();
  }

  // Force complete canvas redraw with empty trail (if mini-map exists)
  if (odomCtx && odomCanvas) {
    const w = odomCanvas.width / 2;
    const h = odomCanvas.height / 2;
    odomCtx.clearRect(0, 0, w, h);
  }
  if (typeof drawOdometryMap === 'function') {
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [] });
  }
  console.log('[ODOM] Reset complete - trail and SLAM map cleared');
};

function updateOdometryFromEncoders(posL, posR) {
  // First reading - just store positions as baseline (robot starts at 0,0)
  if (odomState.lastPosL === null || !odomState.initialized) {
    odomState.lastPosL = posL;
    odomState.lastPosR = posR;
    odomState.initialized = true;
    odomState.trail = [{x: 0, y: 0}];  // Start trail at origin
    console.log('[ODOM] Baseline set: posL=' + posL + ' posR=' + posR);
    drawOdometryMap({
      odomX: 0, odomY: 0, odomHeading: 0,
      odomTrail: odomState.trail
    });
    return;
  }

  // Calculate delta ticks
  const deltaL = posL - odomState.lastPosL;
  const deltaR = posR - odomState.lastPosR;

  // Reject impossibly large jumps (encoder read error or overflow)
  if (Math.abs(deltaL) > MAX_DELTA_PER_UPDATE || Math.abs(deltaR) > MAX_DELTA_PER_UPDATE) {
    console.log('[ODOM] Rejected large jump: deltaL=' + deltaL + ' deltaR=' + deltaR);
    odomState.lastPosL = posL;
    odomState.lastPosR = posR;
    return;
  }

  odomState.lastPosL = posL;
  odomState.lastPosR = posR;

  // Skip tiny movements (noise) - increased threshold
  if (Math.abs(deltaL) < ENCODER_NOISE_TICKS && Math.abs(deltaR) < ENCODER_NOISE_TICKS) {
    return;
  }

  // Convert to mm (positive = forward)
  const distL = deltaL * MM_PER_TICK;
  const distR = deltaR * MM_PER_TICK;

  // Differential drive kinematics
  // Average distance traveled by center of robot
  const distCenter = (distL + distR) / 2;
  // Change in heading (positive = turning right/clockwise)
  const deltaTheta = (distR - distL) / WHEEL_BASE_MM;

  // Update heading first (mid-arc approximation)
  const halfTheta = deltaTheta / 2;
  odomState.heading += halfTheta;

  // Update position in the direction robot is facing
  // heading 0 = facing UP (positive Y), so:
  // x += dist * sin(heading)  (right is positive X)
  // y += dist * cos(heading)  (forward/up is positive Y)
  odomState.x += distCenter * Math.sin(odomState.heading);
  odomState.y += distCenter * Math.cos(odomState.heading);

  // Complete heading update
  odomState.heading += halfTheta;
  odomState.totalDistance += Math.abs(distCenter);

  // Add to trail more frequently for smoother line (every ~20mm or ~0.8 inches)
  const lastTrail = odomState.trail[odomState.trail.length - 1];
  const trailDist = Math.sqrt(Math.pow(odomState.x - lastTrail.x, 2) + Math.pow(odomState.y - lastTrail.y, 2));
  if (trailDist > 20) {
    odomState.trail.push({x: odomState.x, y: odomState.y});
    // Keep trail to reasonable size
    if (odomState.trail.length > 1000) odomState.trail.shift();
  }

  // Update display
  const tripDistEl = document.getElementById('odomTripDist');
  if (tripDistEl) tripDistEl.textContent = mmToFt(odomState.totalDistance).toFixed(1);
  const headingEl = document.getElementById('odomHeading');
  if (headingEl) headingEl.textContent = Math.round(odomState.heading * 180 / Math.PI);

  // Always draw map when we have movement
  drawOdometryMap({
    odomX: odomState.x,
    odomY: odomState.y,
    odomHeading: odomState.heading,
    odomTrail: odomState.trail
  });
}

// Initialize canvas on page load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() {
    initOdomCanvas();
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [{x:0, y:0}] });
  }, 100);
});
