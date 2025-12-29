// ============ ODOMETRY MINI-MAP AND ENCODER TRACKING ============
// Handles encoder-based position tracking and visual mini-map
console.log('[ODOMETRY.JS] LOADED');

// Constants
const WHEEL_DIAMETER_MM = 203;
const WHEEL_CIRCUMFERENCE_MM = Math.PI * WHEEL_DIAMETER_MM;
const TICKS_PER_REV = 16384;
const MM_PER_TICK = WHEEL_CIRCUMFERENCE_MM / TICKS_PER_REV;
const WHEEL_BASE_MM = 600;
const FT_PER_MM = 1 / 304.8;
const ENCODER_NOISE_TICKS = 10;
const MAX_DELTA_PER_UPDATE = 20000;

// Canvas for mini-map
let odomCanvas = null;
let odomCtx = null;

// Odometry state - shared with window for access from other modules
var odomState = window.odomState || {
  lastPosL: null,
  lastPosR: null,
  x: 0,
  y: 0,
  heading: 0,
  totalDistance: 0,
  trail: [{ x: 0, y: 0 }],
  lastDraw: 0,
  initialized: false
};
window.odomState = odomState;

function mmToFt(mm) {
  return (mm / 1000) * 3.28084;
}

function initOdomCanvas() {
  odomCanvas = document.getElementById('odomCanvas');
  if (odomCanvas) {
    odomCtx = odomCanvas.getContext('2d');
    const rect = odomCanvas.getBoundingClientRect();
    odomCanvas.width = rect.width * 2;
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

  ctx.fillStyle = 'rgba(0, 10, 20, 0.95)';
  ctx.fillRect(0, 0, w, h);

  // Auto-scale
  let maxDistMm = 1000;
  if (data.odomTrail && data.odomTrail.length > 0) {
    data.odomTrail.forEach(p => {
      maxDistMm = Math.max(maxDistMm, Math.abs(p.x), Math.abs(p.y));
    });
    if (data.odomX) maxDistMm = Math.max(maxDistMm, Math.abs(data.odomX));
    if (data.odomY) maxDistMm = Math.max(maxDistMm, Math.abs(data.odomY));
  }
  const maxDistFt = maxDistMm * FT_PER_MM;
  const viewRadiusFt = Math.max(3, maxDistFt * 1.3);
  const pixelsPerFt = Math.min(w, h) / (viewRadiusFt * 2);
  const gridSpacing = pixelsPerFt;

  // Draw grid
  ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
  ctx.lineWidth = 0.5;
  for (let x = cx % gridSpacing; x < w; x += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = cy % gridSpacing; y < h; y += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Crosshairs
  ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
  ctx.moveTo(0, cy); ctx.lineTo(w, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  function mmToScreen(xMm, yMm) {
    return {
      x: cx + (xMm * FT_PER_MM) * pixelsPerFt,
      y: cy - (yMm * FT_PER_MM) * pixelsPerFt
    };
  }

  // Start marker
  ctx.fillStyle = '#ff6b6b';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Draw trail
  if (data.odomTrail && data.odomTrail.length >= 1) {
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

    // Bright trail on top
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

  // Draw robot
  if (data.odomX !== undefined && data.odomY !== undefined) {
    const pos = mmToScreen(data.odomX, data.odomY);
    const heading = -(data.odomHeading || 0);

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(heading);

    const bodyW = 14, bodyH = 20;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(-bodyW / 2 + 2, -bodyH / 2 + 2, bodyW, bodyH);

    ctx.fillStyle = '#1a3a2a';
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    ctx.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);

    // Wheels
    ctx.fillStyle = '#333';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.fillRect(-bodyW / 2 - 4, -bodyH / 2 + 2, 4, 6);
    ctx.fillRect(-bodyW / 2 - 4, bodyH / 2 - 8, 4, 6);
    ctx.fillRect(bodyW / 2, -bodyH / 2 + 2, 4, 6);
    ctx.fillRect(bodyW / 2, bodyH / 2 - 8, 4, 6);

    // Front arrow
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.moveTo(0, -bodyH / 2 - 6);
    ctx.lineTo(-5, -bodyH / 2);
    ctx.lineTo(5, -bodyH / 2);
    ctx.closePath();
    ctx.fill();

    ctx.font = 'bold 6px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FWD', 0, -bodyH / 2 + 6);

    // Rear indicator
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(-4, bodyH / 2 - 3, 8, 3);

    ctx.fillStyle = '#51cf66';
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

function updateOdometryFromEncoders(posL, posR) {
  if (odomState.lastPosL === null || !odomState.initialized) {
    odomState.lastPosL = posL;
    odomState.lastPosR = posR;
    odomState.initialized = true;
    odomState.trail = [{ x: 0, y: 0 }];
    console.log('[ODOM] Baseline set: posL=' + posL + ' posR=' + posR);
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: odomState.trail });
    return;
  }

  const deltaL = posL - odomState.lastPosL;
  const deltaR = posR - odomState.lastPosR;

  if (Math.abs(deltaL) > MAX_DELTA_PER_UPDATE || Math.abs(deltaR) > MAX_DELTA_PER_UPDATE) {
    odomState.lastPosL = posL;
    odomState.lastPosR = posR;
    return;
  }

  odomState.lastPosL = posL;
  odomState.lastPosR = posR;

  if (Math.abs(deltaL) < ENCODER_NOISE_TICKS && Math.abs(deltaR) < ENCODER_NOISE_TICKS) {
    return;
  }

  const distL = deltaL * MM_PER_TICK;
  const distR = deltaR * MM_PER_TICK;
  const distCenter = (distL + distR) / 2;
  const deltaTheta = (distR - distL) / WHEEL_BASE_MM;

  const halfTheta = deltaTheta / 2;
  odomState.heading += halfTheta;
  odomState.x += distCenter * Math.sin(odomState.heading);
  odomState.y += distCenter * Math.cos(odomState.heading);
  odomState.heading += halfTheta;
  odomState.totalDistance += Math.abs(distCenter);

  const lastTrail = odomState.trail[odomState.trail.length - 1];
  const trailDist = Math.sqrt(Math.pow(odomState.x - lastTrail.x, 2) + Math.pow(odomState.y - lastTrail.y, 2));
  if (trailDist > 20) {
    odomState.trail.push({ x: odomState.x, y: odomState.y });
    if (odomState.trail.length > 1000) odomState.trail.shift();
  }

  const tripDistEl = document.getElementById('odomTripDist');
  if (tripDistEl) tripDistEl.textContent = mmToFt(odomState.totalDistance).toFixed(1);
  const headingEl = document.getElementById('odomHeading');
  if (headingEl) headingEl.textContent = Math.round(odomState.heading * 180 / Math.PI);

  drawOdometryMap({
    odomX: odomState.x,
    odomY: odomState.y,
    odomHeading: odomState.heading,
    odomTrail: odomState.trail
  });
}

window.resetOdometry = function() {
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'command', data: 'RESET_ODOM' }));
    console.log('[ODOM] Sent RESET_ODOM command to robot');
  }

  odomState = {
    lastPosL: null,
    lastPosR: null,
    x: 0,
    y: 0,
    heading: 0,
    totalDistance: 0,
    trail: [],
    lastDraw: 0,
    initialized: false
  };
  window.odomState = odomState;

  const tripDist = document.getElementById('odomTripDist');
  if (tripDist) tripDist.textContent = '0.0';
  const headingEl = document.getElementById('odomHeading');
  if (headingEl) headingEl.textContent = '0';
  const encL = document.getElementById('encL');
  if (encL) encL.textContent = '0';
  const encR = document.getElementById('encR');
  if (encR) encR.textContent = '0';

  if (typeof clearLidarSlamMap === 'function') {
    clearLidarSlamMap();
  }

  if (odomCtx && odomCanvas) {
    const w = odomCanvas.width / 2;
    const h = odomCanvas.height / 2;
    odomCtx.clearRect(0, 0, w, h);
  }
  drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [] });
  console.log('[ODOM] Reset complete');
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() {
    initOdomCanvas();
    drawOdometryMap({ odomX: 0, odomY: 0, odomHeading: 0, odomTrail: [{ x: 0, y: 0 }] });
  }, 100);
});

// Export module
window.odometryModule = {
  initOdomCanvas,
  drawOdometryMap,
  updateOdometryFromEncoders,
  resetOdometry: window.resetOdometry,
  getState: () => odomState
};
