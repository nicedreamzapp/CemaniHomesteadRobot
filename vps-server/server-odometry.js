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
  telemCount: 0,
  // Motion detection for MAP 1
  lastMovementTime: 0,
  isMoving: false,
  settledCallbacks: [],  // Callbacks to fire when motion settles
  // Encoder intelligence
  velocityHistory: [],     // Last 10 velocity readings for bump/slip detection
  terrainQuality: 1.0,     // 0-1, lower = rougher terrain
  bumpCount: 0,            // Bumps detected this trip
  slipDetected: false,     // Wheel slip in progress
  lastVelocityL: 0,        // mm/s
  lastVelocityR: 0,
  lastEncoderTime: Date.now()
};

// Process encoder values and update odometry
// Returns telemetry data object to broadcast
function processEncoders(posL, posR) {
  // Handle 16-bit encoder wraparound (0-65535)
  let deltaL = posL - odometry.prevPosL;
  let deltaR = posR - odometry.prevPosR;

  // Fix 16-bit wraparound: if delta is huge, it wrapped
  if (deltaL > 32768) deltaL -= 65536;
  if (deltaL < -32768) deltaL += 65536;
  if (deltaR > 32768) deltaR -= 65536;
  if (deltaR < -32768) deltaR += 65536;

  // DEBUG: Log encoder values every 50 TELEM messages (~10 sec)
  odometry.telemCount++;
  if (odometry.telemCount % 50 === 1) {
    console.log('[ENC] posL=' + posL + ' posR=' + posR + ' prevL=' + odometry.prevPosL + ' prevR=' + odometry.prevPosR + ' dL=' + deltaL + ' dR=' + deltaR);
  }

  // Validate delta - reject truly invalid jumps (noise)
  const deltaValid = Math.abs(deltaL) < MAX_DELTA && Math.abs(deltaR) < MAX_DELTA;
  if (!deltaValid) {
    console.log('[ODOM] Rejected jump: deltaL=' + deltaL + ' deltaR=' + deltaR);
  }

  // Update if we have valid deltas
  const hasMovement = deltaValid && (Math.abs(deltaL) > 2 || Math.abs(deltaR) > 2);
  const now = Date.now();
  const dt = (now - odometry.lastEncoderTime) / 1000;  // seconds
  odometry.lastEncoderTime = now;

  if (hasMovement) {
    // Convert to mm
    const distL = deltaL * MM_PER_COUNT;
    const distR = deltaR * MM_PER_COUNT;

    // ============ ENCODER INTELLIGENCE ============
    // Calculate wheel velocities (mm/s)
    const velL = dt > 0 ? Math.abs(distL / dt) : 0;
    const velR = dt > 0 ? Math.abs(distR / dt) : 0;

    // Bump detection: sudden velocity change indicates hitting something
    const accelL = Math.abs(velL - odometry.lastVelocityL);
    const accelR = Math.abs(velR - odometry.lastVelocityR);
    const BUMP_THRESHOLD = 200;  // mm/s² change = bump
    if ((accelL > BUMP_THRESHOLD || accelR > BUMP_THRESHOLD) && odometry.lastVelocityL > 50) {
      odometry.bumpCount++;
      console.log(`[ENCODER] BUMP #${odometry.bumpCount} detected! accelL=${accelL.toFixed(0)} accelR=${accelR.toFixed(0)} mm/s²`);
      state.broadcast({ type: 'encoder_event', event: 'bump', count: odometry.bumpCount, severity: Math.max(accelL, accelR) });
    }

    // Wheel slip detection: one wheel spinning much faster than the other
    const velDiff = Math.abs(velL - velR);
    const velAvg = (velL + velR) / 2;
    if (velAvg > 50 && velDiff > velAvg * 0.8) {
      if (!odometry.slipDetected) {
        odometry.slipDetected = true;
        console.log(`[ENCODER] WHEEL SLIP! velL=${velL.toFixed(0)} velR=${velR.toFixed(0)} mm/s`);
        state.broadcast({ type: 'encoder_event', event: 'slip', velL: Math.round(velL), velR: Math.round(velR) });
      }
    } else {
      odometry.slipDetected = false;
    }

    // Terrain quality: smooth = consistent velocity, rough = erratic
    odometry.velocityHistory.push({ velL, velR, t: now });
    if (odometry.velocityHistory.length > 10) odometry.velocityHistory.shift();
    if (odometry.velocityHistory.length >= 3) {
      let variance = 0;
      for (let i = 1; i < odometry.velocityHistory.length; i++) {
        const dv = Math.abs(odometry.velocityHistory[i].velL - odometry.velocityHistory[i-1].velL);
        variance += dv * dv;
      }
      variance /= odometry.velocityHistory.length;
      // Map variance to 0-1 quality (low variance = smooth = high quality)
      odometry.terrainQuality = Math.max(0, Math.min(1, 1 - (variance / 40000)));
    }

    odometry.lastVelocityL = velL;
    odometry.lastVelocityR = velR;

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

    // Track motion state
    odometry.lastMovementTime = now;
    if (!odometry.isMoving) {
      odometry.isMoving = true;
      console.log('[MOTION] Robot started moving');
    }

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
      source: "encoder",
      terrainQuality: Math.round(odometry.terrainQuality * 100) / 100,
      slipDetected: odometry.slipDetected,
      bumpCount: odometry.bumpCount
    });
  }

  // Motion settled detection - if we were moving but haven't moved for 500ms
  const SETTLE_TIME_MS = 500;
  if (odometry.isMoving && (now - odometry.lastMovementTime) > SETTLE_TIME_MS) {
    odometry.isMoving = false;
    console.log('[MOTION] Robot motion settled (heading=' + Math.round(odometry.heading * 180 / Math.PI) + '°)');
    state.broadcast({
      type: "motion_settled",
      odomX: Math.round(odometry.x),
      odomY: Math.round(odometry.y),
      odomHeading: odometry.heading,
      odomHeadingDeg: Math.round(odometry.heading * 180 / Math.PI)
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

// SET POSITION (for relocalization without full reset)
// Keeps heading and encoder baseline, just moves the origin
function setPosition(newX, newY, newHeading) {
  const oldX = odometry.x;
  const oldY = odometry.y;

  odometry.x = newX;
  odometry.y = newY;
  if (newHeading !== undefined) {
    odometry.heading = newHeading;
  }

  // Add to trail
  odometry.trail.push({ x: newX, y: newY });
  if (odometry.trail.length > 1000) {
    odometry.trail = odometry.trail.slice(-500);
  }

  console.log(`[RELOCALIZE] Position set: (${oldX.toFixed(0)}, ${oldY.toFixed(0)}) → (${newX.toFixed(0)}, ${newY.toFixed(0)})`);

  // Broadcast updated position
  state.broadcast({
    type: "dead_reckoning",
    odomX: Math.round(odometry.x),
    odomY: Math.round(odometry.y),
    odomHeading: odometry.heading,
    odomHeadingDeg: Math.round(odometry.heading * 180 / Math.PI),
    odomDistance: Math.round(odometry.totalDistance),
    odomTrail: odometry.trail,
    source: "relocalization"
  });
}

// Mark robot as moving (call when sending move command)
function markMoving() {
  odometry.isMoving = true;
  odometry.lastMovementTime = Date.now();
  console.log('[MOTION] Robot marked as moving (command sent)');
}

// Check if robot is currently moving
function isMoving() {
  return odometry.isMoving;
}

// Get encoder intelligence data
function getEncoderIntelligence() {
  return {
    terrainQuality: odometry.terrainQuality,
    slipDetected: odometry.slipDetected,
    bumpCount: odometry.bumpCount,
    velocityL: odometry.lastVelocityL,
    velocityR: odometry.lastVelocityR
  };
}

module.exports = {
  processEncoders,
  resetOdometry,
  setPosition,
  getOdometry,
  markMoving,
  isMoving,
  getEncoderIntelligence,
  // Constants for reference
  WHEEL_CIRCUMFERENCE_MM,
  WHEEL_BASE_MM,
  COUNTS_PER_REV,
  MM_PER_COUNT
};
