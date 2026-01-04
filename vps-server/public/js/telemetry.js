// ============ DRIVER TELEMETRY ============
// Battery, temperature, velocity, torque display
console.log('[TELEMETRY.JS] LOADED');

function cToF(celsius) {
  return celsius * 9 / 5 + 32;
}

const METERS_TO_FEET = 3.28084;
function mToFt(meters) {
  return meters * METERS_TO_FEET;
}

function mmToFt(mm) {
  return (mm / 1000) * METERS_TO_FEET;
}

const WHEEL_DIAMETER_M = 0.203;
const WHEEL_CIRCUMFERENCE_M = Math.PI * WHEEL_DIAMETER_M;
const RPM_TO_MPH = WHEEL_CIRCUMFERENCE_M * 60 / 1609.34;

function rpmToMph(rpm) {
  return Math.abs(rpm) * RPM_TO_MPH;
}

function formatMph(mph) {
  if (mph < 0.01) return '0.00';
  if (mph < 0.1) return mph.toFixed(3);
  if (mph < 1) return mph.toFixed(2);
  return mph.toFixed(1);
}

function formatTicks(ticks) {
  const abs = Math.abs(ticks);
  const sign = ticks < 0 ? '-' : '';
  if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K';
  return ticks.toString();
}

// Parse TELEM data from serial
function parseTelemFromSerial(line) {
  var trimmed = line.trim();
  if (!trimmed.startsWith('TELEM,')) return null;
  const parts = trimmed.split(',');
  if (parts.length < 15) return null;

  const tempLF = parseInt(parts[3]);
  const tempLR = parseInt(parts[4]);
  const tempRF = parseInt(parts[5]);
  const tempRR = parseInt(parts[6]);
  const drvTemp1 = parseInt(parts[7]);
  const drvTemp2 = parseInt(parts[8]);

  return {
    batteryV: parseFloat(parts[1]),
    batteryPct: parseInt(parts[2]),
    motorTempLF_F: tempLF,
    motorTempLR_F: tempLR,
    motorTempRF_F: tempRF,
    motorTempRR_F: tempRR,
    motorTempL_F: Math.round((tempLF + tempLR) / 2),
    motorTempR_F: Math.round((tempRF + tempRR) / 2),
    driverTemp1_F: drvTemp1,
    driverTemp2_F: drvTemp2,
    velL: parseFloat(parts[9]),
    velR: parseFloat(parts[10]),
    torqueL: parseFloat(parts[11]),
    torqueR: parseFloat(parts[12]),
    posL: parseInt(parts[13]),
    posR: parseInt(parts[14])
  };
}

function updateDriverTelemetry(data) {
  // Battery
  if (data.batteryV !== undefined) {
    const battV = document.getElementById('batteryVoltage');
    const battP = document.getElementById('batteryPercent');
    const fill = document.getElementById('batteryFill');
    const bar = document.getElementById('batteryBar');

    if (battV) battV.textContent = data.batteryV.toFixed(1);
    if (battP) battP.textContent = data.batteryPct;
    if (fill) fill.style.width = data.batteryPct + '%';

    // Header battery
    const headerFill = document.getElementById('headerBatteryFill');
    const headerPct = document.getElementById('headerBatteryPercent');
    const headerVolt = document.getElementById('headerBatteryVoltage');
    if (headerFill) headerFill.style.width = data.batteryPct + '%';
    if (headerPct) headerPct.textContent = data.batteryPct;
    if (headerVolt) headerVolt.textContent = data.batteryV.toFixed(1);

    if (bar) {
      bar.classList.remove('warning', 'critical');
      if (data.batteryPct < 20) bar.classList.add('critical');
      else if (data.batteryPct < 40) bar.classList.add('warning');
    }
  }

  // Driver temperatures
  if (data.driverTemp1_F !== undefined) {
    const el = document.getElementById('driver1Temp');
    const item = document.getElementById('driver1TempItem');
    if (el) el.textContent = data.driverTemp1_F;
    if (item) {
      item.classList.remove('warning');
      if (data.driverTemp1_F > 158) item.classList.add('warning');
    }
  }

  if (data.driverTemp2_F !== undefined) {
    const el = document.getElementById('driver2Temp');
    const item = document.getElementById('driver2TempItem');
    if (el) el.textContent = data.driverTemp2_F;
    if (item) {
      item.classList.remove('warning');
      if (data.driverTemp2_F > 158) item.classList.add('warning');
    }
  }

  if (data.driverTemp1_F !== undefined && data.driverTemp2_F !== undefined) {
    const avgDriverTemp = Math.round((data.driverTemp1_F + data.driverTemp2_F) / 2);
    const el = document.getElementById('driverTemp');
    if (el) el.textContent = avgDriverTemp;
  }

  // Motor temperatures - all 4 wheels
  const tempFields = [
    { key: 'motorTempLF_F', id: 'motorTempLF', ctrlId: 'ctrlTempLF' },
    { key: 'motorTempLR_F', id: 'motorTempLR', ctrlId: 'ctrlTempLR' },
    { key: 'motorTempRF_F', id: 'motorTempRF', ctrlId: 'ctrlTempRF' },
    { key: 'motorTempRR_F', id: 'motorTempRR', ctrlId: 'ctrlTempRR' }
  ];

  tempFields.forEach(field => {
    if (data[field.key] !== undefined) {
      const el = document.getElementById(field.id);
      const ctrlEl = document.getElementById(field.ctrlId);
      if (el) el.textContent = data[field.key];
      if (ctrlEl) ctrlEl.textContent = data[field.key];
    }
  });

  // Legacy L/R averages
  if (data.motorTempL_F !== undefined) {
    const el = document.getElementById('motorTempL');
    if (el) el.textContent = data.motorTempL_F;
  }
  if (data.motorTempR_F !== undefined) {
    const el = document.getElementById('motorTempR');
    if (el) el.textContent = data.motorTempR_F;
  }
  if (data.motorTempL_F !== undefined && data.motorTempR_F !== undefined) {
    const el = document.getElementById('motorTempAvg');
    if (el) el.textContent = Math.round((data.motorTempL_F + data.motorTempR_F) / 2);
  }

  // Velocities (desktop + mobile mini-tank wheels)
  updateWheelVelocity(data.velL, 'L', ['wheelLF', 'wheelLR', 'mWheelLF', 'mWheelLR'], ['arrowLF', 'arrowLR'],
                       ['ctrlWheelLF', 'ctrlWheelLR'], ['ctrlArrowLF', 'ctrlArrowLR']);
  updateWheelVelocity(data.velR, 'R', ['wheelRF', 'wheelRR', 'mWheelRF', 'mWheelRR'], ['arrowRF', 'arrowRR'],
                       ['ctrlWheelRF', 'ctrlWheelRR'], ['ctrlArrowRF', 'ctrlArrowRR']);

  // Torque
  if (data.torqueL !== undefined) {
    const el = document.getElementById('torqueL');
    if (el) el.textContent = data.torqueL.toFixed(1);
  }
  if (data.torqueR !== undefined) {
    const el = document.getElementById('torqueR');
    if (el) el.textContent = data.torqueR.toFixed(1);
  }

  // Encoder positions
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

  // Update odometry from encoders (via module)
  if (data.posL !== undefined && data.posR !== undefined) {
    if (window.odometryModule) {
      window.odometryModule.updateOdometryFromEncoders(data.posL, data.posR);
    }
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
  if ((data.odomTrail !== undefined || data.odomX !== undefined) && window.odometryModule) {
    window.odometryModule.drawOdometryMap(data);
  }
}

function updateWheelVelocity(vel, side, wheelIds, arrowIds, ctrlWheelIds, ctrlArrowIds) {
  if (vel === undefined) return;

  const mph = rpmToMph(vel);
  const velEl = document.getElementById('velocity' + side);
  if (velEl) velEl.textContent = formatMph(mph);

  const isSpinning = Math.abs(vel) > 0.5;
  const direction = vel > 0 ? 'forward' : (vel < 0 ? 'backward' : 'stopped');

  wheelIds.forEach(id => {
    const wheel = document.getElementById(id);
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

  arrowIds.forEach(id => {
    const arrow = document.getElementById(id);
    if (arrow) {
      arrow.classList.remove('arrow-forward', 'arrow-backward', 'arrow-stopped');
      arrow.classList.add('arrow-' + direction);
    }
  });

  ctrlWheelIds.forEach(id => {
    const wheel = document.getElementById(id);
    if (wheel) {
      wheel.classList.remove('forward', 'backward');
      if (isSpinning) wheel.classList.add(direction);
    }
  });

  ctrlArrowIds.forEach(id => {
    const arrow = document.getElementById(id);
    if (arrow) {
      arrow.textContent = direction === 'forward' ? '▲' : (direction === 'backward' ? '▼' : '');
    }
  });
}

// Export module
window.telemetryModule = {
  parseTelemFromSerial,
  updateDriverTelemetry,
  cToF,
  mToFt,
  mmToFt,
  rpmToMph,
  formatMph,
  formatTicks
};
