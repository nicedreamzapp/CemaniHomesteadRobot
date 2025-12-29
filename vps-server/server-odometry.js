// ============ SERVER-SIDE ODOMETRY MODULE ============
// Encoder-based position tracking and dead reckoning

const state = require('./server-state');

// Robot physical parameters (8-inch wheels, ~55cm wheelbase)
const WHEEL_CIRCUMFERENCE_MM = 203.2 * Math.PI;  // ~638.4mm per wheel rotation
const WHEEL_BASE_MM = 550.0;  // Distance between wheels
const COUNTS_PER_REV = 4096;  // 1024 encoder lines * 4 (quadrature)
const MM_PER_COUNT = WHEEL_CIRCUMFERENCE_MM / COUNTS_PER_REV;  // ~0.156mm per count
const MAX_DELTA = 20000;  // Max valid delta per update

// Odometry state
let odometry = {
  // Raw encoder counts (from Teensy)
  posL: 0,
  posR: 0,
  // Previous counts for delta calculation
  prevPosL: 0,
  prevPosR: 0,
  // Calculated position (in mm from start)
  x: 0,
  y: 0,
  heading: 0,  // radians, 0 = facing forward (positive Y)
  // Trip stats
  tripStartTime: Date.now(),
  totalDistance: 0,  // mm traveled since start
  // Trail history for mini-map - start at origin (red dot)
  trail: [{ x: 0, y: 0 }],
  // Debug counter
  telemCount: 0
};

// Process encoder values and update odometry
// Returns telemetry data object to broadcast
function processEncoders(posL, posR) {
  const deltaL = posL - odometry.prevPosL;
  const deltaR = posR - odometry.prevPosR;

  // DEBUG: Log encoder values every 50 TELEM messages (~10 sec)
  odometry.telemCount++;
  if (odometry.telemCount % 50 === 1) {
    console.log('[ENC] posL=' + posL + ' posR=' + posR + ' prevL=' + odometry.prevPosL + ' prevR=' + odometry.prevPosR + ' dL=' + deltaL + ' dR=' + deltaR);
  }

  // Validate delta - reject jumps (encoder reset, noise, etc.)
  const deltaValid = Math.abs(deltaL) < MAX_DELTA && Math.abs(deltaR) < MAX_DELTA;
  if (!deltaValid) {
    console.log('[ODOM] Rejected jump: deltaL=' + deltaL + ' deltaR=' + deltaR);
  }

  // Only update if we have valid deltas (skip first reading or noise)
  if (deltaValid && (deltaL !== 0 || deltaR !== 0)) {
    // Convert to mm
    const distL = deltaL * MM_PER_COUNT;
    const distR = deltaR * MM_PER_COUNT;

    // Average distance moved
    const distAvg = (distL + distR) / 2;

    // Change in heading (positive = turning right)
    const deltaHeading = (distR - distL) / WHEEL_BASE_MM;

    // Update position using midpoint integration
    const newHeading = odometry.heading + deltaHeading / 2;
    odometry.x += distAvg * Math.sin(newHeading);
    odometry.y += distAvg * Math.cos(newHeading);
    odometry.heading += deltaHeading;

    // Keep heading in [-PI, PI]
    while (odometry.heading > Math.PI) odometry.heading -= 2 * Math.PI;
    while (odometry.heading < -Math.PI) odometry.heading += 2 * Math.PI;

    // Update total distance
    odometry.totalDistance += Math.abs(distAvg);

    // DEBUG: Log significant odometry changes
    if (Math.abs(distAvg) > 10) {  // More than 1cm movement
      console.log('[ODOM] Movement: x=' + odometry.x.toFixed(0) + 'mm, y=' + odometry.y.toFixed(0) + 'mm, heading=' + (odometry.heading * 180 / Math.PI).toFixed(1) + '°');
    }

    // Add to trail more frequently for smoother lines (every ~5cm)
    const lastPoint = odometry.trail[odometry.trail.length - 1];
    const distFromLast = lastPoint
      ? Math.sqrt(Math.pow(odometry.x - lastPoint.x, 2) + Math.pow(odometry.y - lastPoint.y, 2))
      : Infinity;

    if (odometry.trail.length === 0 || distFromLast > 50) {  // 50mm = 5cm
      odometry.trail.push({ x: odometry.x, y: odometry.y });
      if (odometry.trail.length > 500) odometry.trail.shift();  // Keep more points
    }

    // BROADCAST encoder-based position update for grid movement
    console.log('[DR SEND] x=' + Math.round(odometry.x) + ' y=' + Math.round(odometry.y));
    state.broadcast({
      type: "dead_reckoning",
      odomX: Math.round(odometry.x),
      odomY: Math.round(odometry.y),
      odomHeading: odometry.heading,
      odomHeadingDeg: Math.round(odometry.heading * 180 / Math.PI),
      odomDistance: Math.round(odometry.totalDistance),
      odomTrail: odometry.trail,
      source: "encoder"
    });
  }

  // Always store previous values for delta calculation
  odometry.prevPosL = posL;
  odometry.prevPosR = posR;
  odometry.posL = posL;
  odometry.posR = posR;

  return {
    odomX: Math.round(odometry.x),
    odomY: Math.round(odometry.y),
    odomHeading: odometry.heading,
    odomHeadingDeg: Math.round(odometry.heading * 180 / Math.PI),
    odomDistance: Math.round(odometry.totalDistance),
    odomTrail: odometry.trail
  };
}

// Reset odometry to origin
function resetOdometry() {
  odometry.x = 0;
  odometry.y = 0;
  odometry.heading = 0;
  odometry.totalDistance = 0;
  odometry.trail = [{ x: 0, y: 0 }];
  odometry.prevPosL = odometry.posL;  // Use current as new baseline
  odometry.prevPosR = odometry.posR;
  odometry.tripStartTime = Date.now();
  odometry.telemCount = 0;
  console.log("[ODOM] FULL RESET - position zeroed, encoder baseline set");

  // Broadcast reset state via both message types
  state.broadcast({
    type: "dead_reckoning",
    odomX: 0,
    odomY: 0,
    odomHeading: 0,
    odomHeadingDeg: 0,
    odomDistance: 0,
    odomTrail: odometry.trail,
    source: "reset"
  });

  state.broadcast({
    type: "teensy_telemetry",
    odomX: 0,
    odomY: 0,
    odomHeading: 0,
    odomHeadingDeg: 0,
    odomDistance: 0,
    odomTrail: odometry.trail
  });
}

// Get current odometry state
function getOdometry() {
  return odometry;
}

module.exports = {
  processEncoders,
  resetOdometry,
  getOdometry,
  // Constants for reference
  WHEEL_CIRCUMFERENCE_MM,
  WHEEL_BASE_MM,
  COUNTS_PER_REV,
  MM_PER_COUNT
};
