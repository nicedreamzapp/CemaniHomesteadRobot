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
// Format: TELEM,battV,battPct,tempLF,tempLR,tempRF,tempRR,velL,velR,torqueL,torqueR,posL,posR
// Example: TELEM,26.08,66,69,68,82,82,0.0,0.0,0.0,0.0,-27827,-4313
function parseTelemFromSerial(line) {
  var trimmed = line.trim();
  if (!trimmed.startsWith('TELEM,')) return null;
  const parts = trimmed.split(',');
  if (parts.length < 13) return null;

  const tempLF = parseInt(parts[3]);
  const tempLR = parseInt(parts[4]);
  const tempRF = parseInt(parts[5]);
  const tempRR = parseInt(parts[6]);

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
    // Driver board temps - use motor averages as proxy
    driverTemp1_F: Math.round((tempRF + tempRR) / 2),
    driverTemp2_F: Math.round((tempLF + tempLR) / 2),
    // Velocities
    velL: parseFloat(parts[7]),
    velR: parseFloat(parts[8]),
    // Torque
    torqueL: parseFloat(parts[9]),
    torqueR: parseFloat(parts[10]),
    // Encoder positions
    posL: parseInt(parts[11]),
    posR: parseInt(parts[12])
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
  }
  // Left Rear
  if (data.motorTempLR_F !== undefined) {
    const el = document.getElementById('motorTempLR');
    if (el) el.textContent = data.motorTempLR_F;
  }
  // Right Front
  if (data.motorTempRF_F !== undefined) {
    const el = document.getElementById('motorTempRF');
    if (el) el.textContent = data.motorTempRF_F;
  }
  // Right Rear
  if (data.motorTempRR_F !== undefined) {
    const el = document.getElementById('motorTempRR');
    if (el) el.textContent = data.motorTempRR_F;
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
  }
  if (data.velR !== undefined) {
    const mphR = rpmToMph(data.velR);
    document.getElementById('velocityR').textContent = formatMph(mphR);

    // Animate right wheels with direction arrows
    const wheelRF = document.getElementById('wheelRF');
    const wheelRR = document.getElementById('wheelRR');
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

  // Draw grid (1 meter squares)
  const scale = 20;  // pixels per meter (5cm = 1px)
  ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
  ctx.lineWidth = 0.5;

  // Vertical lines
  for (let x = cx % scale; x < w; x += scale) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  // Horizontal lines
  for (let y = cy % scale; y < h; y += scale) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Draw crosshairs at center
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

  // Scale text (in feet - 1m ≈ 3.3ft)
  ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
  ctx.font = '8px sans-serif';
  ctx.fillText('3ft', cx + scale + 2, cy - 2);

  // Auto-scale based on max distance
  let autoScale = scale;
  let maxDist = 2000;  // Start at 2m view
  if (data.odomTrail && data.odomTrail.length > 0) {
    data.odomTrail.forEach(p => {
      maxDist = Math.max(maxDist, Math.abs(p.x), Math.abs(p.y));
    });
    if (data.odomX) maxDist = Math.max(maxDist, Math.abs(data.odomX));
    if (data.odomY) maxDist = Math.max(maxDist, Math.abs(data.odomY));
    // Fit to view with padding
    autoScale = Math.min(w, h) / (maxDist * 2.5 / 1000);
  }

  // Draw start marker (red dot)
  ctx.fillStyle = '#ff6b6b';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Draw trail - connect all points including current position
  if (data.odomTrail && data.odomTrail.length >= 1) {
    ctx.strokeStyle = '#74c0fc';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    // Start from first trail point (should be origin)
    const first = data.odomTrail[0];
    ctx.moveTo(cx + (first.x / 1000) * autoScale, cy - (first.y / 1000) * autoScale);

    // Draw through all trail points
    data.odomTrail.forEach((p, i) => {
      if (i > 0) {
        const screenX = cx + (p.x / 1000) * autoScale;
        const screenY = cy - (p.y / 1000) * autoScale;
        ctx.lineTo(screenX, screenY);
      }
    });

    // Connect trail to current position (if different from last trail point)
    if (data.odomX !== undefined && data.odomY !== undefined) {
      const currentX = cx + (data.odomX / 1000) * autoScale;
      const currentY = cy - (data.odomY / 1000) * autoScale;
      ctx.lineTo(currentX, currentY);
    }

    ctx.stroke();
  }

  // Draw current position - robot with clear front/rear
  if (data.odomX !== undefined && data.odomY !== undefined) {
    const posX = cx + (data.odomX / 1000) * autoScale;
    const posY = cy - (data.odomY / 1000) * autoScale;
    // Heading: positive = turning right (clockwise when viewed from above)
    // Canvas rotation: positive = counterclockwise
    // So we negate heading for correct visual rotation
    const heading = -(data.odomHeading || 0);

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

// Odometry state
let odomState = {
  lastPosL: null,
  lastPosR: null,
  x: 0,           // mm
  y: 0,           // mm
  heading: 0,     // radians
  totalDistance: 0, // mm
  trail: [{x: 0, y: 0}]
};

function updateOdometryFromEncoders(posL, posR) {
  // First reading - just store positions
  if (odomState.lastPosL === null) {
    odomState.lastPosL = posL;
    odomState.lastPosR = posR;
    drawOdometryMap({
      odomX: 0, odomY: 0, odomHeading: 0,
      odomTrail: odomState.trail
    });
    return;
  }

  // Calculate delta ticks
  const deltaL = posL - odomState.lastPosL;
  const deltaR = posR - odomState.lastPosR;
  odomState.lastPosL = posL;
  odomState.lastPosR = posR;

  // Skip tiny movements (noise)
  if (Math.abs(deltaL) < 5 && Math.abs(deltaR) < 5) return;

  // Convert to mm
  const distL = deltaL * MM_PER_TICK;
  const distR = deltaR * MM_PER_TICK;

  // Differential drive kinematics
  const distCenter = (distL + distR) / 2;
  const deltaTheta = (distR - distL) / WHEEL_BASE_MM;

  // Update position
  odomState.heading += deltaTheta;
  odomState.x += distCenter * Math.cos(odomState.heading);
  odomState.y += distCenter * Math.sin(odomState.heading);
  odomState.totalDistance += Math.abs(distCenter);

  // Add to trail (every ~50mm)
  const lastTrail = odomState.trail[odomState.trail.length - 1];
  const trailDist = Math.sqrt(Math.pow(odomState.x - lastTrail.x, 2) + Math.pow(odomState.y - lastTrail.y, 2));
  if (trailDist > 50) {
    odomState.trail.push({x: odomState.x, y: odomState.y});
    // Keep trail to reasonable size
    if (odomState.trail.length > 500) odomState.trail.shift();
  }

  // Update display
  const tripDist = document.getElementById('odomTripDist');
  if (tripDist) tripDist.textContent = mmToFt(odomState.totalDistance).toFixed(1);
  const headingEl = document.getElementById('odomHeading');
  if (headingEl) headingEl.textContent = Math.round(odomState.heading * 180 / Math.PI);

  // Draw map
  drawOdometryMap({
    odomX: odomState.x,
    odomY: odomState.y,
    odomHeading: odomState.heading,
    odomTrail: odomState.trail
  });
}

// Reset odometry
function resetOdometry() {
  odomState = {
    lastPosL: null,
    lastPosR: null,
    x: 0, y: 0, heading: 0, totalDistance: 0,
    trail: [{x: 0, y: 0}]
  };
  // Update display
  const tripDist = document.getElementById('odomTripDist');
  if (tripDist) tripDist.textContent = '0.0';
  const heading = document.getElementById('odomHeading');
  if (heading) heading.textContent = '0';
  // Redraw empty map
  if (odomCtx) {
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [{x:0, y:0}] });
  }
}

// Initialize canvas on page load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() {
    initOdomCanvas();
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [{x:0, y:0}] });
  }, 100);
});
