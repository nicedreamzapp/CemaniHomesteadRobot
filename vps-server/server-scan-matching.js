// ============ 2D LIDAR SCAN MATCHING MODULE ============
// ICP (Iterative Closest Point) and Correlative Scan Matching
// Takes [angle_deg, distance_mm] arrays, returns dx, dy, dTheta
//
// Usage:
//   const matcher = require('./server-scan-matching');
//   matcher.setReferenceScan(previousScanPoints);  // [[angleDeg, distMm], ...]
//   const result = matcher.matchScan(newScanPoints, encoderDx, encoderDy, encoderDTheta);
//   // result = { dx, dy, dTheta, confidence, method, iterations }

// ============ CONFIGURATION ============
const CONFIG = {
  // --- Polar to Cartesian ---
  MIN_DISTANCE_MM: 100,    // Ignore points closer than this (robot body)
  MAX_DISTANCE_MM: 8000,   // Ignore points farther than this (noise)

  // --- ICP ---
  ICP_MAX_ITERATIONS: 30,
  ICP_CONVERGENCE_MM: 0.5,       // Stop when mean error changes less than this
  ICP_MAX_PAIR_DISTANCE: 500,    // mm - reject pairs farther than this
  ICP_MIN_PAIRS: 20,             // Need at least this many valid pairs

  // --- Correlative Scan Matching ---
  CSM_COARSE_XY_RANGE: 100,     // mm - search +/- this around initial guess
  CSM_COARSE_XY_STEP: 10,       // mm
  CSM_COARSE_THETA_RANGE: 0.10, // radians (~5.7 degrees)
  CSM_COARSE_THETA_STEP: 0.02,  // radians (~1.1 degrees)
  CSM_FINE_XY_RANGE: 15,        // mm - refine search window
  CSM_FINE_XY_STEP: 2,          // mm
  CSM_FINE_THETA_RANGE: 0.03,   // radians (~1.7 degrees)
  CSM_FINE_THETA_STEP: 0.005,   // radians (~0.3 degrees)
  CSM_GRID_RESOLUTION: 20,      // mm per grid cell for lookup table
  CSM_GAUSSIAN_SIGMA: 30,       // mm - blur radius for probability grid
  CSM_MIN_SCORE: 0.3,           // minimum normalized score to accept match

  // --- General ---
  METHOD: 'csm'  // 'icp', 'csm', or 'both' (CSM then ICP refinement)
};

// ============ STATE ============
let referenceScan = null;     // Cartesian points [{x, y}, ...] from previous scan
let referenceGrid = null;     // Spatial hash grid for fast nearest-neighbor (ICP)
let referenceProbGrid = null; // Probability grid for correlative matching (CSM)
let lastMatchResult = null;

// ============ UTILITY FUNCTIONS ============

/**
 * Convert polar LIDAR scan to Cartesian points
 * @param {Array} scan - [[angleDeg, distMm], ...]
 * @returns {Array} [{x, y}, ...] in mm, LIDAR-local frame
 */
function polarToCartesian(scan) {
  const points = [];
  for (let i = 0; i < scan.length; i++) {
    const angleDeg = scan[i][0];
    const distMm = scan[i][1];
    if (distMm < CONFIG.MIN_DISTANCE_MM || distMm > CONFIG.MAX_DISTANCE_MM) continue;
    const angleRad = angleDeg * Math.PI / 180;
    points.push({
      x: distMm * Math.cos(angleRad),
      y: distMm * Math.sin(angleRad)
    });
  }
  return points;
}

/**
 * Apply a 2D rigid transform (rotation then translation) to a point set
 */
function transformPoints(points, dx, dy, dTheta) {
  const cosT = Math.cos(dTheta);
  const sinT = Math.sin(dTheta);
  const result = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    result[i] = {
      x: cosT * p.x - sinT * p.y + dx,
      y: sinT * p.x + cosT * p.y + dy
    };
  }
  return result;
}

// ============ SPATIAL HASH GRID (for fast nearest-neighbor in ICP) ============

const GRID_CELL_SIZE = 50; // mm per cell for spatial hash

function buildSpatialGrid(points) {
  const grid = new Map();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const gx = Math.floor(p.x / GRID_CELL_SIZE);
    const gy = Math.floor(p.y / GRID_CELL_SIZE);
    const key = (gx << 16) ^ gy; // Fast integer key
    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(p);
  }
  return grid;
}

/**
 * Find nearest neighbor in spatial grid
 * Returns {point, distSq} or null
 */
function findNearest(grid, qx, qy) {
  const gx = Math.floor(qx / GRID_CELL_SIZE);
  const gy = Math.floor(qy / GRID_CELL_SIZE);
  let bestDistSq = Infinity;
  let bestPoint = null;

  // Search 3x3 neighborhood
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = ((gx + dx) << 16) ^ (gy + dy);
      const cell = grid.get(key);
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const p = cell[i];
        const dSq = (p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestPoint = p;
        }
      }
    }
  }
  return bestPoint ? { point: bestPoint, distSq: bestDistSq } : null;
}

// ============ ICP IMPLEMENTATION ============

/**
 * Point-to-Point ICP scan matching
 * @param {Array} newPoints - Cartesian points [{x, y}, ...] from new scan
 * @param {Array} refPoints - Cartesian points [{x, y}, ...] from reference scan
 * @param {Map} refGrid - Spatial hash grid of reference points
 * @param {number} initDx - Initial guess for dx (from encoders)
 * @param {number} initDy - Initial guess for dy
 * @param {number} initDTheta - Initial guess for rotation
 * @returns {object} { dx, dy, dTheta, meanError, iterations, confidence }
 */
function icpMatch(newPoints, refPoints, refGrid, initDx, initDy, initDTheta) {
  // Accumulate total transform
  let totalDx = initDx;
  let totalDy = initDy;
  let totalDTheta = initDTheta;

  let prevMeanError = Infinity;
  let lastPairCount = 0;
  let iterations = 0;
  const maxPairDistSq = CONFIG.ICP_MAX_PAIR_DISTANCE * CONFIG.ICP_MAX_PAIR_DISTANCE;

  for (let iter = 0; iter < CONFIG.ICP_MAX_ITERATIONS; iter++) {
    iterations = iter + 1;

    // Transform new scan by current estimate
    const transformed = transformPoints(newPoints, totalDx, totalDy, totalDTheta);

    // Find correspondences
    const pairs = []; // [{px, py, qx, qy}, ...] p=new(transformed), q=reference
    let totalError = 0;

    for (let i = 0; i < transformed.length; i++) {
      const tp = transformed[i];
      const nn = findNearest(refGrid, tp.x, tp.y);
      if (!nn || nn.distSq > maxPairDistSq) continue;

      pairs.push({
        px: newPoints[i].x,  // Original (untransformed) new point
        py: newPoints[i].y,
        qx: nn.point.x,     // Reference point
        qy: nn.point.y
      });
      totalError += Math.sqrt(nn.distSq);
    }

    if (pairs.length < CONFIG.ICP_MIN_PAIRS) {
      return {
        dx: totalDx, dy: totalDy, dTheta: totalDTheta,
        meanError: Infinity, iterations, confidence: 0,
        reason: 'too_few_pairs (' + pairs.length + ')'
      };
    }

    const meanError = totalError / pairs.length;
    lastPairCount = pairs.length;

    // Check convergence
    if (Math.abs(prevMeanError - meanError) < CONFIG.ICP_CONVERGENCE_MM) {
      return {
        dx: totalDx, dy: totalDy, dTheta: totalDTheta,
        meanError, iterations,
        confidence: computeICPConfidence(meanError, pairs.length, newPoints.length)
      };
    }
    prevMeanError = meanError;

    // Compute optimal rigid transform for this iteration
    // Using the closed-form 2D solution (no SVD needed)
    const N = pairs.length;

    // Centroids
    let cpx = 0, cpy = 0, cqx = 0, cqy = 0;
    for (let i = 0; i < N; i++) {
      cpx += pairs[i].px;
      cpy += pairs[i].py;
      cqx += pairs[i].qx;
      cqy += pairs[i].qy;
    }
    cpx /= N; cpy /= N; cqx /= N; cqy /= N;

    // Cross-covariance terms (for 2D, we only need these 4 sums)
    let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0;
    for (let i = 0; i < N; i++) {
      const px = pairs[i].px - cpx;
      const py = pairs[i].py - cpy;
      const qx = pairs[i].qx - cqx;
      const qy = pairs[i].qy - cqy;
      Sxx += px * qx;
      Sxy += px * qy;
      Syx += py * qx;
      Syy += py * qy;
    }

    // Optimal rotation angle (closed-form for 2D)
    const theta = Math.atan2(Sxy - Syx, Sxx + Syy);

    // Optimal translation
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const tx = cqx - (cosT * cpx - sinT * cpy);
    const ty = cqy - (sinT * cpx + cosT * cpy);

    // Since we used original (untransformed) source points in the SVD,
    // theta/tx/ty IS the full transform, not an increment. Set directly.
    totalDx = tx;
    totalDy = ty;
    totalDTheta = theta;
  }

  return {
    dx: totalDx, dy: totalDy, dTheta: totalDTheta,
    meanError: prevMeanError, iterations,
    confidence: computeICPConfidence(prevMeanError, lastPairCount, newPoints.length)
  };
}

function computeICPConfidence(meanError, pairCount, totalPoints) {
  // Confidence based on: low mean error + high pair ratio
  const errorScore = Math.max(0, 1 - meanError / 500);  // 0mm=1.0, 500mm=0.0
  const pairRatio = pairCount / Math.max(totalPoints, 1);
  const pairScore = Math.min(1, pairRatio / 0.3);  // 30%+ pairs = full score
  return errorScore * 0.7 + pairScore * 0.3;
}

// ============ CORRELATIVE SCAN MATCHING (CSM) ============

/**
 * Build a probability lookup grid from reference scan points.
 * Each point is blurred with a Gaussian to create a smooth score field.
 */
function buildProbabilityGrid(points) {
  const res = CONFIG.CSM_GRID_RESOLUTION;
  const sigma = CONFIG.CSM_GAUSSIAN_SIGMA;
  const blurCells = Math.ceil(sigma * 3 / res); // 3-sigma coverage

  // Find bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    if (points[i].x < minX) minX = points[i].x;
    if (points[i].x > maxX) maxX = points[i].x;
    if (points[i].y < minY) minY = points[i].y;
    if (points[i].y > maxY) maxY = points[i].y;
  }

  // Add margin for search window
  const margin = CONFIG.CSM_COARSE_XY_RANGE + sigma * 3;
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;

  const width = Math.ceil((maxX - minX) / res) + 1;
  const height = Math.ceil((maxY - minY) / res) + 1;

  // Cap grid size to prevent memory issues
  if (width * height > 2000000) {
    console.log('[SCAN-MATCH] Probability grid too large, skipping CSM');
    return null;
  }

  const grid = new Float32Array(width * height);

  // Stamp each point with a Gaussian
  const invTwoSigmaSq = 1 / (2 * sigma * sigma);
  for (let i = 0; i < points.length; i++) {
    const px = Math.floor((points[i].x - minX) / res);
    const py = Math.floor((points[i].y - minY) / res);

    for (let dx = -blurCells; dx <= blurCells; dx++) {
      for (let dy = -blurCells; dy <= blurCells; dy++) {
        const gx = px + dx;
        const gy = py + dy;
        if (gx < 0 || gx >= width || gy < 0 || gy >= height) continue;
        const distSq = (dx * res) * (dx * res) + (dy * res) * (dy * res);
        const val = Math.exp(-distSq * invTwoSigmaSq);
        grid[gy * width + gx] = Math.max(grid[gy * width + gx], val);
      }
    }
  }

  return { grid, width, height, minX, minY, res };
}

/**
 * Score a transformed scan against the probability grid
 */
function scoreScan(probGrid, points, dx, dy, dTheta) {
  if (!probGrid) return 0;
  const { grid, width, height, minX, minY, res } = probGrid;
  const cosT = Math.cos(dTheta);
  const sinT = Math.sin(dTheta);
  let score = 0;
  let count = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // Transform point
    const tx = cosT * p.x - sinT * p.y + dx;
    const ty = sinT * p.x + cosT * p.y + dy;
    // Look up in grid
    const gx = Math.floor((tx - minX) / res);
    const gy = Math.floor((ty - minY) / res);
    if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
      score += grid[gy * width + gx];
      count++;
    }
  }

  return count > 0 ? score / count : 0;
}

/**
 * Correlative Scan Matching - brute force search with multi-resolution
 * @param {Array} newPoints - Cartesian [{x,y}, ...] from new scan
 * @param {object} probGrid - Probability grid from reference scan
 * @param {number} initDx - Initial guess from encoders
 * @param {number} initDy
 * @param {number} initDTheta
 * @returns {object} { dx, dy, dTheta, score, confidence }
 */
function correlativeScanMatch(newPoints, probGrid, initDx, initDy, initDTheta) {
  if (!probGrid) {
    return { dx: initDx, dy: initDy, dTheta: initDTheta, score: 0, confidence: 0 };
  }

  // --- Coarse search ---
  let bestDx = initDx;
  let bestDy = initDy;
  let bestDTheta = initDTheta;
  let bestScore = -1;

  const cXRange = CONFIG.CSM_COARSE_XY_RANGE;
  const cXStep = CONFIG.CSM_COARSE_XY_STEP;
  const cTRange = CONFIG.CSM_COARSE_THETA_RANGE;
  const cTStep = CONFIG.CSM_COARSE_THETA_STEP;

  for (let dt = -cTRange; dt <= cTRange; dt += cTStep) {
    const theta = initDTheta + dt;
    for (let ddx = -cXRange; ddx <= cXRange; ddx += cXStep) {
      for (let ddy = -cXRange; ddy <= cXRange; ddy += cXStep) {
        const s = scoreScan(probGrid, newPoints, initDx + ddx, initDy + ddy, theta);
        if (s > bestScore) {
          bestScore = s;
          bestDx = initDx + ddx;
          bestDy = initDy + ddy;
          bestDTheta = theta;
        }
      }
    }
  }

  // --- Fine search around coarse result ---
  const fXRange = CONFIG.CSM_FINE_XY_RANGE;
  const fXStep = CONFIG.CSM_FINE_XY_STEP;
  const fTRange = CONFIG.CSM_FINE_THETA_RANGE;
  const fTStep = CONFIG.CSM_FINE_THETA_STEP;

  const coarseDx = bestDx;
  const coarseDy = bestDy;
  const coarseDTheta = bestDTheta;

  for (let dt = -fTRange; dt <= fTRange; dt += fTStep) {
    const theta = coarseDTheta + dt;
    for (let ddx = -fXRange; ddx <= fXRange; ddx += fXStep) {
      for (let ddy = -fXRange; ddy <= fXRange; ddy += fXStep) {
        const s = scoreScan(probGrid, newPoints, coarseDx + ddx, coarseDy + ddy, theta);
        if (s > bestScore) {
          bestScore = s;
          bestDx = coarseDx + ddx;
          bestDy = coarseDy + ddy;
          bestDTheta = theta;
        }
      }
    }
  }

  return {
    dx: bestDx,
    dy: bestDy,
    dTheta: bestDTheta,
    score: bestScore,
    confidence: bestScore  // Score is already 0-1 (normalized Gaussian probability)
  };
}

// ============ PUBLIC API ============

/**
 * Set the reference scan (the previous scan to match against)
 * @param {Array} scanPoints - [[angleDeg, distMm], ...]
 */
function setReferenceScan(scanPoints) {
  const cartesian = polarToCartesian(scanPoints);
  if (cartesian.length < 20) {
    console.log('[SCAN-MATCH] Reference scan too sparse (' + cartesian.length + ' points)');
    return;
  }
  referenceScan = cartesian;
  referenceGrid = buildSpatialGrid(cartesian);
  referenceProbGrid = buildProbabilityGrid(cartesian);
}

/**
 * Match a new scan against the reference scan
 * @param {Array} scanPoints - [[angleDeg, distMm], ...]
 * @param {number} encoderDx - Initial dx guess from encoders (mm)
 * @param {number} encoderDy - Initial dy guess from encoders (mm)
 * @param {number} encoderDTheta - Initial heading change guess from encoders (radians)
 * @returns {object} { dx, dy, dTheta, confidence, method, details }
 */
function matchScan(scanPoints, encoderDx = 0, encoderDy = 0, encoderDTheta = 0) {
  const newPoints = polarToCartesian(scanPoints);

  if (!referenceScan || newPoints.length < 20) {
    return {
      dx: encoderDx, dy: encoderDy, dTheta: encoderDTheta,
      confidence: 0, method: 'encoder_only',
      details: 'No reference scan or new scan too sparse'
    };
  }

  const startTime = Date.now();
  let result;

  if (CONFIG.METHOD === 'csm' || CONFIG.METHOD === 'both') {
    // Correlative Scan Matching
    const csmResult = correlativeScanMatch(
      newPoints, referenceProbGrid,
      encoderDx, encoderDy, encoderDTheta
    );

    if (CONFIG.METHOD === 'both' && csmResult.confidence > CONFIG.CSM_MIN_SCORE) {
      // Refine CSM result with ICP
      const icpResult = icpMatch(
        newPoints, referenceScan, referenceGrid,
        csmResult.dx, csmResult.dy, csmResult.dTheta
      );
      result = {
        dx: icpResult.dx,
        dy: icpResult.dy,
        dTheta: icpResult.dTheta,
        confidence: Math.max(csmResult.confidence, icpResult.confidence),
        method: 'csm+icp',
        details: {
          csm: csmResult,
          icp: icpResult,
          timeMs: Date.now() - startTime
        }
      };
    } else {
      result = {
        dx: csmResult.dx,
        dy: csmResult.dy,
        dTheta: csmResult.dTheta,
        confidence: csmResult.confidence,
        method: 'csm',
        details: {
          score: csmResult.score,
          timeMs: Date.now() - startTime
        }
      };
    }
  } else {
    // ICP only
    const icpResult = icpMatch(
      newPoints, referenceScan, referenceGrid,
      encoderDx, encoderDy, encoderDTheta
    );
    result = {
      dx: icpResult.dx,
      dy: icpResult.dy,
      dTheta: icpResult.dTheta,
      confidence: icpResult.confidence,
      method: 'icp',
      details: {
        meanError: icpResult.meanError,
        iterations: icpResult.iterations,
        timeMs: Date.now() - startTime
      }
    };
  }

  // If confidence is too low, fall back to encoder odometry
  if (result.confidence < CONFIG.CSM_MIN_SCORE) {
    result = {
      dx: encoderDx,
      dy: encoderDy,
      dTheta: encoderDTheta,
      confidence: 0,
      method: 'encoder_fallback',
      details: {
        reason: 'scan match confidence too low: ' + result.confidence.toFixed(3),
        originalMethod: result.method,
        timeMs: Date.now() - startTime
      }
    };
  }

  lastMatchResult = result;
  return result;
}

/**
 * Get the last match result (for diagnostics)
 */
function getLastResult() {
  return lastMatchResult;
}

/**
 * Update configuration
 */
function configure(overrides) {
  Object.assign(CONFIG, overrides);
}

// ============ PERFORMANCE ESTIMATE ============
// CSM coarse: 21 xy * 21 xy * 11 theta = ~4851 evaluations
// Each evaluation: 150 points * (transform + grid lookup) = ~150 * 10ns = 1.5us
// Total coarse: ~7.3ms
// CSM fine: 16 xy * 16 xy * 13 theta = ~3328 evaluations = ~5ms
// Total CSM: ~12ms per scan (well within 100ms budget at 10Hz)
//
// ICP: 30 iterations * 150 points * nearest-neighbor = ~30 * 150 * 0.5us = 2.25ms
// Total ICP: ~3ms per scan
//
// Both combined: ~15ms per scan

module.exports = {
  setReferenceScan,
  matchScan,
  getLastResult,
  configure,
  // Export internals for testing
  _polarToCartesian: polarToCartesian,
  _transformPoints: transformPoints,
  _icpMatch: icpMatch,
  _correlativeScanMatch: correlativeScanMatch,
  _scoreScan: scoreScan,
  CONFIG
};
