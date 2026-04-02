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

// ============ LOOP CLOSURE VIA LIDAR FINGERPRINTS ============
// Store compact LIDAR signatures at key positions
// When robot returns to a known area, correct accumulated drift
const FINGERPRINT_INTERVAL_MM = 2000;  // Save fingerprint every 2m traveled
const FINGERPRINT_MATCH_THRESHOLD = 0.65;  // 65% similarity = match
const FINGERPRINT_MIN_DISTANCE = 3000;  // Don't match fingerprints < 3m apart (too close = not a loop)
let fingerprints = [];  // [{x, y, heading, signature, distanceTraveled}, ...]
let lastFingerprintDistance = 0;
let loopClosureCount = 0;

// Create compact signature from LIDAR scan (360 bins, 1° each, normalized distances)
function createFingerprint(scanXY) {
  const bins = new Float32Array(360).fill(0);
  const counts = new Float32Array(360).fill(0);
  for (const p of scanXY) {
    const angle = Math.atan2(p.y, p.x);
    const dist = Math.sqrt(p.x * p.x + p.y * p.y);
    let bin = Math.round((angle * 180 / Math.PI + 180) % 360);
    if (bin < 0) bin += 360;
    if (bin >= 360) bin = 359;
    bins[bin] += dist;
    counts[bin]++;
  }
  // Average distance per bin, normalize to 0-1
  let maxDist = 1;
  for (let i = 0; i < 360; i++) {
    bins[i] = counts[i] > 0 ? bins[i] / counts[i] : 0;
    if (bins[i] > maxDist) maxDist = bins[i];
  }
  for (let i = 0; i < 360; i++) bins[i] /= maxDist;
  return bins;
}

// Compare two fingerprints (rotation-invariant via circular cross-correlation)
function compareFingerprints(fp1, fp2) {
  let bestScore = 0;
  // Try rotations in 5° steps for speed, then refine
  for (let rot = 0; rot < 360; rot += 5) {
    let score = 0;
    let validBins = 0;
    for (let i = 0; i < 360; i++) {
      const j = (i + rot) % 360;
      if (fp1[i] > 0 && fp2[j] > 0) {
        const diff = Math.abs(fp1[i] - fp2[j]);
        score += 1 - diff;  // Higher = more similar
        validBins++;
      }
    }
    if (validBins > 30) {  // Need enough overlap
      score /= validBins;
      if (score > bestScore) bestScore = score;
    }
  }
  return bestScore;
}

// Check for loop closure and correct position if found
function checkLoopClosure(currentXY) {
  const currentFP = createFingerprint(currentXY);
  const currentDist = scanMatchOdometry.x * scanMatchOdometry.x + scanMatchOdometry.y * scanMatchOdometry.y;

  // Save fingerprint periodically
  const distTraveled = Math.sqrt(
    Math.pow(scanMatchOdometry.x - (fingerprints.length > 0 ? fingerprints[fingerprints.length-1].x : 0), 2) +
    Math.pow(scanMatchOdometry.y - (fingerprints.length > 0 ? fingerprints[fingerprints.length-1].y : 0), 2)
  );
  if (distTraveled > FINGERPRINT_INTERVAL_MM || fingerprints.length === 0) {
    fingerprints.push({
      x: scanMatchOdometry.x,
      y: scanMatchOdometry.y,
      heading: scanMatchOdometry.heading,
      signature: currentFP,
      matchCount: matchCount
    });
    if (fingerprints.length > 200) fingerprints.shift();  // Keep last 200
    console.log(`[LOOP] Saved fingerprint #${fingerprints.length} at (${scanMatchOdometry.x.toFixed(0)}, ${scanMatchOdometry.y.toFixed(0)})`);
  }

  // Compare against old fingerprints (skip recent ones)
  let bestMatch = null;
  let bestScore = 0;
  for (let i = 0; i < fingerprints.length - 5; i++) {
    const fp = fingerprints[i];
    // Must be far enough away in odometry space (otherwise it's not a loop)
    const odomDist = Math.sqrt(
      Math.pow(scanMatchOdometry.x - fp.x, 2) +
      Math.pow(scanMatchOdometry.y - fp.y, 2)
    );
    if (odomDist < FINGERPRINT_MIN_DISTANCE) continue;

    const score = compareFingerprints(currentFP, fp.signature);
    if (score > bestScore && score > FINGERPRINT_MATCH_THRESHOLD) {
      bestScore = score;
      bestMatch = fp;
    }
  }

  if (bestMatch) {
    loopClosureCount++;
    const correctionX = bestMatch.x - scanMatchOdometry.x;
    const correctionY = bestMatch.y - scanMatchOdometry.y;
    const correctionDist = Math.sqrt(correctionX * correctionX + correctionY * correctionY);

    console.log(`[LOOP CLOSURE #${loopClosureCount}] Match score=${bestScore.toFixed(2)} correction=${correctionDist.toFixed(0)}mm`);
    console.log(`[LOOP CLOSURE] Correcting position: (${scanMatchOdometry.x.toFixed(0)}, ${scanMatchOdometry.y.toFixed(0)}) → (${bestMatch.x.toFixed(0)}, ${bestMatch.y.toFixed(0)})`);

    // Apply gradual correction (50% of error) to avoid jarring jumps
    scanMatchOdometry.x += correctionX * 0.5;
    scanMatchOdometry.y += correctionY * 0.5;

    return {
      corrected: true,
      correctionX: correctionX * 0.5,
      correctionY: correctionY * 0.5,
      matchScore: bestScore,
      closureCount: loopClosureCount
    };
  }
  return { corrected: false };
}

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

  // Check for loop closure every 20 matches (not every scan - expensive)
  let loopResult = { corrected: false };
  if (matchCount % 20 === 0 && fingerprints.length > 5) {
    loopResult = checkLoopClosure(newXY);
  }

  return {
    dx: worldDx,
    dy: worldDy,
    dTheta: totalTheta,
    x: scanMatchOdometry.x,
    y: scanMatchOdometry.y,
    heading: scanMatchOdometry.heading,
    confidence,
    loopClosure: loopResult
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
