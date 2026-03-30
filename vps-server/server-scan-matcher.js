// ============ LIDAR SCAN MATCHER (ICP) ============
// Compares consecutive LIDAR scans to determine robot movement
// Replaces broken encoders for odometry - the LIDAR IS the position sensor
//
// Algorithm: Iterative Closest Point (ICP)
// 1. Convert polar scans (angle, dist) to XY point clouds
// 2. For each point in new scan, find closest point in reference scan
// 3. Compute optimal rotation + translation to minimize distances
// 4. Apply transform, repeat until convergence
// 5. Output: dx, dy (mm), dTheta (radians)

// Store reference scan for matching
let referenceScan = null;  // [{x, y}, ...] in robot-local mm coordinates
let scanMatchOdometry = { x: 0, y: 0, heading: 0 };  // Accumulated position
let matchCount = 0;
let skipCount = 0;

// Convert polar LIDAR scan to XY points (mm)
function polarToXY(points) {
  const xy = [];
  for (const [angleDeg, distMm] of points) {
    if (distMm < 100 || distMm > 6000) continue;  // Skip noise and too-far
    const rad = (angleDeg - 90) * Math.PI / 180;
    xy.push({
      x: distMm * Math.cos(rad),
      y: distMm * Math.sin(rad)
    });
  }
  return xy;
}

// Find closest point in reference for each point in source
// Uses simple brute force - fast enough for 150 points
function findCorrespondences(source, reference, maxDist) {
  const pairs = [];
  const maxDist2 = maxDist * maxDist;

  for (const sp of source) {
    let bestDist2 = maxDist2;
    let bestRef = null;

    for (const rp of reference) {
      const dx = sp.x - rp.x;
      const dy = sp.y - rp.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestRef = rp;
      }
    }

    if (bestRef) {
      pairs.push({ src: sp, ref: bestRef, dist2: bestDist2 });
    }
  }

  return pairs;
}

// Compute optimal rigid transform (rotation + translation) from point pairs
// Uses SVD-based least squares (simplified for 2D)
function computeTransform(pairs) {
  if (pairs.length < 10) return null;

  // Compute centroids
  let srcCx = 0, srcCy = 0, refCx = 0, refCy = 0;
  for (const p of pairs) {
    srcCx += p.src.x; srcCy += p.src.y;
    refCx += p.ref.x; refCy += p.ref.y;
  }
  srcCx /= pairs.length; srcCy /= pairs.length;
  refCx /= pairs.length; refCy /= pairs.length;

  // Compute cross-covariance matrix elements (2x2)
  let sxx = 0, sxy = 0, syx = 0, syy = 0;
  for (const p of pairs) {
    const sx = p.src.x - srcCx;
    const sy = p.src.y - srcCy;
    const rx = p.ref.x - refCx;
    const ry = p.ref.y - refCy;
    sxx += sx * rx;
    sxy += sx * ry;
    syx += sy * rx;
    syy += sy * ry;
  }

  // Optimal rotation angle (2D SVD simplifies to atan2)
  const theta = Math.atan2(syx - sxy, sxx + syy);

  // Optimal translation
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const tx = refCx - (cosT * srcCx - sinT * srcCy);
  const ty = refCy - (sinT * srcCx + cosT * srcCy);

  return { theta, tx, ty };
}

// Apply transform to point cloud
function applyTransform(points, transform) {
  const { theta, tx, ty } = transform;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  return points.map(p => ({
    x: cosT * p.x - sinT * p.y + tx,
    y: sinT * p.x + cosT * p.y + ty
  }));
}

// Main ICP function
// Returns { dx, dy, dTheta, confidence } or null if match failed
function matchScans(newScanPolar, compassHeading) {
  const newXY = polarToXY(newScanPolar);

  if (newXY.length < 30) {
    return null;  // Not enough points
  }

  // First scan - just store as reference
  if (!referenceScan) {
    referenceScan = newXY;
    if (compassHeading !== undefined) {
      scanMatchOdometry.heading = compassHeading;
    }
    return null;
  }

  // Process every scan for responsive position tracking
  skipCount++;

  // Use compass heading change as initial rotation estimate
  let initialTheta = 0;
  if (compassHeading !== undefined) {
    const prevHeading = scanMatchOdometry.heading;
    initialTheta = compassHeading - prevHeading;
    // Normalize to [-pi, pi]
    while (initialTheta > Math.PI) initialTheta -= 2 * Math.PI;
    while (initialTheta < -Math.PI) initialTheta += 2 * Math.PI;
  }

  // Pre-rotate new scan by compass delta (gives ICP a good starting point)
  let currentScan = newXY;
  if (Math.abs(initialTheta) > 0.001) {
    const cosT = Math.cos(initialTheta);
    const sinT = Math.sin(initialTheta);
    currentScan = newXY.map(p => ({
      x: cosT * p.x - sinT * p.y,
      y: sinT * p.x + cosT * p.y
    }));
  }

  // ICP iterations
  let totalTheta = initialTheta;
  let totalTx = 0, totalTy = 0;
  let lastError = Infinity;
  const MAX_CORRESPONDENCE_DIST = 500;  // mm - max distance to consider a match

  for (let iter = 0; iter < 20; iter++) {
    // Find correspondences
    const pairs = findCorrespondences(currentScan, referenceScan, MAX_CORRESPONDENCE_DIST);

    if (pairs.length < 15) {
      // Too few matches - scan is too different (big movement or lost)
      console.log(`[SLAM] ICP failed: only ${pairs.length} correspondences`);
      referenceScan = newXY;  // Reset reference
      return null;
    }

    // Compute mean error
    const meanError = Math.sqrt(pairs.reduce((s, p) => s + p.dist2, 0) / pairs.length);

    // Check convergence
    if (Math.abs(meanError - lastError) < 1.0) {
      // Converged
      break;
    }
    lastError = meanError;

    // Compute transform
    const transform = computeTransform(pairs);
    if (!transform) break;

    // Accumulate
    totalTheta += transform.theta;
    totalTx += transform.tx;
    totalTy += transform.ty;

    // Apply transform
    currentScan = applyTransform(currentScan, transform);
  }

  // Validate result - reject if movement is too large (probably wrong)
  const moveDist = Math.sqrt(totalTx * totalTx + totalTy * totalTy);
  if (moveDist > 500) {  // More than 50cm between scans = probably wrong
    console.log(`[SLAM] Rejected: movement ${moveDist.toFixed(0)}mm too large`);
    referenceScan = newXY;
    return null;
  }

  // During fast rotation, reject translation (ICP gets confused by similar wall patterns)
  const rotationRate = Math.abs(initialTheta);
  const isRotating = rotationRate > 0.05;  // ~3 degrees between scans = spinning

  // Confidence based on number of correspondences and error
  const confidence = Math.min(1.0, findCorrespondences(currentScan, referenceScan, MAX_CORRESPONDENCE_DIST).length / (newXY.length * 0.6));

  // Update accumulated odometry
  let worldDx = 0, worldDy = 0;
  if (!isRotating) {
    // Only update translation when NOT spinning
    const cosH = Math.cos(scanMatchOdometry.heading);
    const sinH = Math.sin(scanMatchOdometry.heading);
    worldDx = cosH * totalTx - sinH * totalTy;
    worldDy = sinH * totalTx + cosH * totalTy;
  }

  scanMatchOdometry.x += worldDx;
  scanMatchOdometry.y += worldDy;
  if (compassHeading !== undefined) {
    // Only update heading from compass when it changes significantly (>3°)
    // This prevents compass jitter from creating spiral maps
    const headingDiff = Math.abs(compassHeading - scanMatchOdometry.heading);
    const normalizedDiff = headingDiff > Math.PI ? 2 * Math.PI - headingDiff : headingDiff;
    if (normalizedDiff > 0.05) {  // ~3 degrees
      scanMatchOdometry.heading = compassHeading;
    }
  } else {
    scanMatchOdometry.heading += totalTheta;
  }

  matchCount++;
  if (matchCount % 5 === 0) {
    console.log(`[SLAM] Match #${matchCount}: dx=${worldDx.toFixed(0)} dy=${worldDy.toFixed(0)} pos=(${scanMatchOdometry.x.toFixed(0)}, ${scanMatchOdometry.y.toFixed(0)}) heading=${(scanMatchOdometry.heading * 180 / Math.PI).toFixed(1)}° conf=${confidence.toFixed(2)}`);
  }

  // Update reference scan every match for responsive tracking
  referenceScan = newXY;

  return {
    dx: worldDx,
    dy: worldDy,
    dTheta: totalTheta,
    x: scanMatchOdometry.x,
    y: scanMatchOdometry.y,
    heading: scanMatchOdometry.heading,
    confidence
  };
}

function getOdometry() {
  return { ...scanMatchOdometry };
}

function resetOdometry() {
  scanMatchOdometry = { x: 0, y: 0, heading: 0 };
  referenceScan = null;
  matchCount = 0;
}

module.exports = {
  matchScans,
  getOdometry,
  resetOdometry
};
