// ============ DRIVER TELEMETRY ============
// Convert Celsius to Fahrenheit
function cToF(celsius) {
  return celsius * 9 / 5 + 32;
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

// Parse TELEM data from serial: TELEM,battV,battPct,motorTempL_F,motorTempR_F,driverTemp1_F,driverTemp2_F,velL,velR,torqueL,torqueR,posL,posR
function parseTelemFromSerial(line) {
  // Trim whitespace and check for TELEM prefix
  var trimmed = line.trim();
  if (!trimmed.startsWith('TELEM,')) return null;
  const parts = trimmed.split(',');
  if (parts.length < 13) return null;
  return {
    batteryV: parseFloat(parts[1]),
    batteryPct: parseInt(parts[2]),
    motorTempL_F: parseInt(parts[3]),
    motorTempR_F: parseInt(parts[4]),
    driverTemp1_F: parseInt(parts[5]),
    driverTemp2_F: parseInt(parts[6]),
    velL: parseFloat(parts[7]),
    velR: parseFloat(parts[8]),
    torqueL: parseFloat(parts[9]),
    torqueR: parseFloat(parts[10]),
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

  // Motor temperatures - LEFT side (Driver 2) - both wheels same temp from driver
  if (data.motorTempL_F !== undefined) {
    // Update both left wheels with the same temp (driver reports one temp for both motors)
    const tempLF = document.getElementById('motorTempLF');
    const tempLR = document.getElementById('motorTempLR');
    if (tempLF) tempLF.textContent = data.motorTempL_F;
    if (tempLR) tempLR.textContent = data.motorTempL_F;

    // Add warning class if too hot
    const wheelInfos = document.querySelectorAll('#wheelLF, #wheelLR');
    wheelInfos.forEach(el => {
      const parent = el.closest('.wheel');
      if (parent) {
        const tempEl = parent.querySelector('.wheel-temp');
        if (tempEl) {
          tempEl.classList.toggle('warning', data.motorTempL_F > 158);
        }
      }
    });

    // Legacy element
    const el = document.getElementById('motorTempL');
    if (el) el.textContent = data.motorTempL_F;
  }
  // Motor temperatures - RIGHT side (Driver 1) - both wheels same temp from driver
  if (data.motorTempR_F !== undefined) {
    // Update both right wheels with the same temp
    const tempRF = document.getElementById('motorTempRF');
    const tempRR = document.getElementById('motorTempRR');
    if (tempRF) tempRF.textContent = data.motorTempR_F;
    if (tempRR) tempRR.textContent = data.motorTempR_F;

    // Add warning class if too hot
    const wheelInfos = document.querySelectorAll('#wheelRF, #wheelRR');
    wheelInfos.forEach(el => {
      const parent = el.closest('.wheel');
      if (parent) {
        const tempEl = parent.querySelector('.wheel-temp');
        if (tempEl) {
          tempEl.classList.toggle('warning', data.motorTempR_F > 158);
        }
      }
    });

    // Legacy element
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

  // Position (encoder counts) - hidden but kept for compatibility
  if (data.posL !== undefined) {
    const el = document.getElementById('positionL');
    if (el) el.textContent = data.posL.toLocaleString();
  }
  if (data.posR !== undefined) {
    const el = document.getElementById('positionR');
    if (el) el.textContent = data.posR.toLocaleString();
  }
}
