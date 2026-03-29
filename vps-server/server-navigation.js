// ============ SERVER-SIDE AUTONOMOUS NAVIGATION MODULE ============
// Occupancy grid + A* pathfinding + frontier exploration + path following
// Builds map from LIDAR scans, plans safe paths, sends motor commands

const state = require('./server-state');
const odometry = require('./server-odometry');

// ============ OCCUPANCY GRID ============
const CELL_SIZE = 0.10;  // 10cm per cell
const GRID_RADIUS = 50;  // 50m from origin = 100m x 100m map
const UNKNOWN = 0;
const FREE = 1;
const OCCUPIED = 2;

// Sparse grid storage: "gx,gy" -> { state, confidence, lastSeen, hits }
const grid = {};
let gridStats = { totalCells: 0, freeCells: 0, occupiedCells: 0 };

// Navigation state
let navPath = [];           // Current A* path [{x, y}, ...]
let navPathIndex = 0;       // Current waypoint index
let navActive = false;      // Following a path?
let navTargetX = 0;         // Final target (mm)
let navTargetY = 0;
let navInterval = null;     // Path-following timer
let exploreActive = false;  // Autonomous exploration mode?
let exploreInterval = null;
let lastGridBroadcast = 0;
const GRID_BROADCAST_INTERVAL = 2000;  // Send grid to UI every 2s

// Robot is 32cm wide × 40cm deep, 90lbs - needs big safety margins indoors
const ROBOT_RADIUS_CELLS = 3;  // 30cm clearance (3 cells × 10cm) - robot is 32cm wide, tight but works indoors
const ARRIVAL_DISTANCE = 200;  // 20cm = arrived (mm)
const WAYPOINT_DISTANCE = 250; // 25cm = close enough to waypoint, move to next
const NAV_SPEED = 3;           // Slow enough to stop in time
const TURN_SPEED = 3;          // Slow turns
const LIDAR_DANGER_MM = 700;   // 70cm - STOP well before hitting anything
const LIDAR_CAUTION_MM = 1000; // 100cm - slow down zone
const REPLAN_INTERVAL = 5000;  // Re-plan path every 5 seconds (grid may have changed)

// Latest LIDAR scan for real-time obstacle checking
let latestLidarPoints = [];
let lastReplanTime = 0;

// Sonar data for close-range obstacle detection
let latestSonar = { fl: 999, fr: 999, rl: 999, rr: 999 };
const SONAR_DANGER_CM = 30;  // 30cm - STOP if sonar detects this close

function updateSonar(fl, fr, rl, rr) {
  latestSonar = { fl, fr, rl, rr };
}

// Stall detection - if driving but encoders don't change, robot is stuck
let lastEncoderL = 0;
let lastEncoderR = 0;
let stallStartTime = 0;
let isStalled = false;
const STALL_TIMEOUT_MS = 1500;  // 1.5 seconds of no encoder change = stalled

function updateEncoders(posL, posR) {
  if (posL !== lastEncoderL || posR !== lastEncoderR) {
    lastEncoderL = posL;
    lastEncoderR = posR;
    stallStartTime = Date.now();
    isStalled = false;
  } else if (exploreActive && reactiveState === 'forward' && stallStartTime > 0) {
    if (Date.now() - stallStartTime > STALL_TIMEOUT_MS) {
      if (!isStalled) {
        isStalled = true;
        console.log(`[EXPLORE-STALL] Robot stuck! Encoders unchanged for ${STALL_TIMEOUT_MS}ms`);
      }
    }
  }
}

// Safety messages from Teensy (tilt, etc)
let safetyTilt = false;

function updateSafety(status) {
  if (status.includes('TILT')) {
    safetyTilt = true;
    console.log(`[EXPLORE-SAFETY] Tilt detected: ${status}`);
  } else if (status === 'OK') {
    safetyTilt = false;
  }
}

// ============ GRID OPERATIONS ============

function worldToGrid(wx, wy) {
  const gx = Math.floor((wx / 1000 + GRID_RADIUS) / CELL_SIZE);
  const gy = Math.floor((wy / 1000 + GRID_RADIUS) / CELL_SIZE);
  return { gx, gy, key: `${gx},${gy}` };
}

function gridToWorld(gx, gy) {
  const wx = ((gx * CELL_SIZE) - GRID_RADIUS + CELL_SIZE / 2) * 1000;
  const wy = ((gy * CELL_SIZE) - GRID_RADIUS + CELL_SIZE / 2) * 1000;
  return { x: wx, y: wy };
}

function markFree(wx, wy, confidence = 0.7) {
  const c = worldToGrid(wx, wy);
  const existing = grid[c.key];
  if (!existing) {
    grid[c.key] = { state: FREE, confidence, lastSeen: Date.now(), hits: 1 };
    gridStats.totalCells++;
    gridStats.freeCells++;
  } else if (existing.state === FREE) {
    existing.confidence = Math.min(1.0, existing.confidence + 0.02);
    existing.lastSeen = Date.now();
    existing.hits++;
  } else if (existing.state === UNKNOWN) {
    existing.state = FREE;
    existing.confidence = confidence;
    existing.lastSeen = Date.now();
    gridStats.freeCells++;
  }
  // If it was OCCUPIED but we've now confirmed free many times, convert
  else if (existing.state === OCCUPIED && existing.hits < 3 && confidence > 0.9) {
    existing.state = FREE;
    existing.confidence = confidence;
    gridStats.occupiedCells--;
    gridStats.freeCells++;
  }
}

function markOccupied(wx, wy, confidence = 0.8) {
  const c = worldToGrid(wx, wy);
  const existing = grid[c.key];
  if (!existing) {
    grid[c.key] = { state: OCCUPIED, confidence, lastSeen: Date.now(), hits: 1 };
    gridStats.totalCells++;
    gridStats.occupiedCells++;
  } else if (existing.state === OCCUPIED) {
    existing.confidence = Math.min(1.0, existing.confidence + 0.03);
    existing.lastSeen = Date.now();
    existing.hits++;
  } else if (existing.state === FREE) {
    // Only mark free cell as occupied if high confidence
    if (confidence > 0.6) {
      existing.state = OCCUPIED;
      existing.confidence = confidence;
      existing.lastSeen = Date.now();
      existing.hits = 1;
      gridStats.freeCells--;
      gridStats.occupiedCells++;
    }
  }
}

function isBlocked(gx, gy) {
  const cell = grid[`${gx},${gy}`];
  if (!cell) return false;  // Unknown = passable (we explore into unknown)
  return cell.state === OCCUPIED;
}

// Check if cell is blocked considering robot radius (inflate obstacles)
function isBlockedInflated(gx, gy) {
  for (let dx = -ROBOT_RADIUS_CELLS; dx <= ROBOT_RADIUS_CELLS; dx++) {
    for (let dy = -ROBOT_RADIUS_CELLS; dy <= ROBOT_RADIUS_CELLS; dy++) {
      if (dx * dx + dy * dy <= ROBOT_RADIUS_CELLS * ROBOT_RADIUS_CELLS) {
        if (isBlocked(gx + dx, gy + dy)) return true;
      }
    }
  }
  return false;
}

// ============ LIDAR SCAN PROCESSING ============

function processLidarScan(lidarPoints) {
  // Store latest scan for real-time obstacle checking during navigation
  latestLidarPoints = lidarPoints;

  const odom = odometry.getOdometry();
  const robotX = odom.x;  // mm
  const robotY = odom.y;  // mm
  const heading = odom.heading;  // radians

  // Mark robot position as free
  markFree(robotX, robotY, 1.0);

  // Process each LIDAR point
  for (const [angleDeg, distMm] of lidarPoints) {
    // Robot body is ~32cm wide × 40cm deep, LIDAR sits on top
    // Anything under 350mm is likely the robot's own frame, cameras, or arms
    if (distMm < 350 || distMm > 8000) continue;  // Skip robot body + invalid

    // Convert LIDAR angle to world angle
    const angleRad = heading + ((angleDeg - 90) * Math.PI / 180);

    // Obstacle position in world coordinates (mm)
    const obsX = robotX + distMm * Math.cos(angleRad);
    const obsY = robotY + distMm * Math.sin(angleRad);

    // Mark obstacle cell
    markOccupied(obsX, obsY, distMm < 2000 ? 0.9 : 0.7);

    // Ray cast: mark cells between robot and obstacle as free
    const steps = Math.floor(distMm / (CELL_SIZE * 1000));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const fx = robotX + (obsX - robotX) * t;
      const fy = robotY + (obsY - robotY) * t;
      markFree(fx, fy, 0.6);
    }
  }

  // Periodically broadcast grid updates to UI
  const now = Date.now();
  if (now - lastGridBroadcast > GRID_BROADCAST_INTERVAL) {
    lastGridBroadcast = now;
    broadcastGridUpdate();
  }
}

// ============ A* PATHFINDING ============

function astar(startX, startY, goalX, goalY) {
  const start = worldToGrid(startX, startY);
  const goal = worldToGrid(goalX, goalY);

  // If start is blocked by inflation (robot is near a wall), use smaller inflation near start
  // This prevents "can't even start" failures in tight spaces
  const startBlocked = isBlockedInflated(start.gx, start.gy);
  if (startBlocked) {
    console.log('[NAV] Start cell blocked by inflation - using reduced clearance near start');
  }

  // Quick check: is goal blocked?
  if (isBlockedInflated(goal.gx, goal.gy)) {
    // Find nearest unblocked cell to goal
    const alt = findNearestFree(goal.gx, goal.gy, 10);
    if (alt) {
      goal.gx = alt.gx;
      goal.gy = alt.gy;
      goal.key = `${alt.gx},${alt.gy}`;
    } else {
      console.log('[NAV] Goal is blocked and no alternative found');
      return null;
    }
  }

  const openSet = new Map();  // key -> node
  const closedSet = new Set();

  const heuristic = (gx, gy) => {
    const dx = Math.abs(gx - goal.gx);
    const dy = Math.abs(gy - goal.gy);
    return Math.sqrt(dx * dx + dy * dy);  // Euclidean
  };

  const startNode = {
    gx: start.gx, gy: start.gy, key: start.key,
    g: 0, h: heuristic(start.gx, start.gy), f: 0,
    parent: null
  };
  startNode.f = startNode.g + startNode.h;
  openSet.set(start.key, startNode);

  const MAX_ITERATIONS = 50000;  // Prevent infinite loop
  let iterations = 0;

  // Neighbors: 8 directions (including diagonals)
  const dirs = [
    { dx: 1, dy: 0, cost: 1 },
    { dx: -1, dy: 0, cost: 1 },
    { dx: 0, dy: 1, cost: 1 },
    { dx: 0, dy: -1, cost: 1 },
    { dx: 1, dy: 1, cost: 1.414 },
    { dx: -1, dy: 1, cost: 1.414 },
    { dx: 1, dy: -1, cost: 1.414 },
    { dx: -1, dy: -1, cost: 1.414 },
  ];

  while (openSet.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;

    // Find node with lowest f score
    let current = null;
    for (const node of openSet.values()) {
      if (!current || node.f < current.f) current = node;
    }

    // Reached goal?
    if (current.gx === goal.gx && current.gy === goal.gy) {
      // Reconstruct path
      const path = [];
      let node = current;
      while (node) {
        const world = gridToWorld(node.gx, node.gy);
        path.unshift(world);  // prepend
        node = node.parent;
      }
      // Simplify path (remove collinear points)
      const simplified = simplifyPath(path);
      console.log(`[NAV] A* found path: ${path.length} points → ${simplified.length} waypoints (${iterations} iterations)`);
      return simplified;
    }

    openSet.delete(current.key);
    closedSet.add(current.key);

    // Explore neighbors
    for (const dir of dirs) {
      const nx = current.gx + dir.dx;
      const ny = current.gy + dir.dy;
      const nkey = `${nx},${ny}`;

      if (closedSet.has(nkey)) continue;
      // Near start: use direct block check (no inflation) so robot can escape tight spots
      const nearStart = Math.abs(nx - start.gx) < 3 && Math.abs(ny - start.gy) < 3;
      if (nearStart ? isBlocked(nx, ny) : isBlockedInflated(nx, ny)) continue;

      const g = current.g + dir.cost;
      const existing = openSet.get(nkey);

      if (!existing || g < existing.g) {
        const node = {
          gx: nx, gy: ny, key: nkey,
          g: g, h: heuristic(nx, ny), f: 0,
          parent: current
        };
        node.f = node.g + node.h;
        openSet.set(nkey, node);
      }
    }
  }

  console.log(`[NAV] A* failed after ${iterations} iterations`);
  return null;
}

// Find nearest free cell to a blocked cell
function findNearestFree(gx, gy, maxRadius) {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;  // Only check perimeter
        if (!isBlockedInflated(gx + dx, gy + dy)) {
          return { gx: gx + dx, gy: gy + dy };
        }
      }
    }
  }
  return null;
}

// Simplify path by removing unnecessary waypoints (Ramer-Douglas-Peucker style)
function simplifyPath(path) {
  if (path.length <= 2) return path;

  const result = [path[0]];
  let lastDir = null;

  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    const dir = Math.atan2(dy, dx);

    if (lastDir === null || Math.abs(dir - lastDir) > 0.1) {
      result.push(path[i]);
      lastDir = dir;
    }
  }

  // Always include final point
  if (result[result.length - 1] !== path[path.length - 1]) {
    result.push(path[path.length - 1]);
  }

  return result;
}

// ============ FRONTIER EXPLORATION ============

function findFrontiers() {
  // Frontiers = free cells adjacent to unknown cells
  // These are the edges of explored space
  const frontierClusters = [];
  const visited = new Set();
  const dirs4 = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

  for (const [key, cell] of Object.entries(grid)) {
    if (cell.state !== FREE) continue;
    if (visited.has(key)) continue;

    const [gx, gy] = key.split(',').map(Number);

    // Check if this free cell borders unknown space
    let isFrontier = false;
    for (const d of dirs4) {
      const nkey = `${gx + d.dx},${gy + d.dy}`;
      if (!grid[nkey]) {  // Unknown neighbor
        isFrontier = true;
        break;
      }
    }

    if (!isFrontier) continue;

    // BFS to find connected frontier cluster
    const cluster = [];
    const queue = [{ gx, gy, key }];
    visited.add(key);

    while (queue.length > 0) {
      const curr = queue.shift();
      cluster.push(curr);

      for (const d of dirs4) {
        const nx = curr.gx + d.dx;
        const ny = curr.gy + d.dy;
        const nkey = `${nx},${ny}`;

        if (visited.has(nkey)) continue;
        const ncell = grid[nkey];
        if (!ncell || ncell.state !== FREE) continue;

        // Check if this neighbor also borders unknown
        let neighborIsFrontier = false;
        for (const d2 of dirs4) {
          if (!grid[`${nx + d2.dx},${ny + d2.dy}`]) {
            neighborIsFrontier = true;
            break;
          }
        }

        if (neighborIsFrontier) {
          visited.add(nkey);
          queue.push({ gx: nx, gy: ny, key: nkey });
        }
      }
    }

    // Only keep meaningful frontiers (>= 3 cells = 30cm+ opening)
    if (cluster.length >= 3) {
      // Calculate centroid
      let cx = 0, cy = 0;
      for (const c of cluster) {
        cx += c.gx;
        cy += c.gy;
      }
      cx = Math.round(cx / cluster.length);
      cy = Math.round(cy / cluster.length);
      const world = gridToWorld(cx, cy);

      frontierClusters.push({
        centroid: world,
        size: cluster.length,
        cells: cluster.length
      });
    }
  }

  // Sort by size (largest frontiers first = most to explore)
  frontierClusters.sort((a, b) => b.size - a.size);

  return frontierClusters;
}

// Pick best frontier to explore (closest large one)
function pickBestFrontier() {
  const frontiers = findFrontiers();
  if (frontiers.length === 0) return null;

  const odom = odometry.getOdometry();
  const robotX = odom.x;
  const robotY = odom.y;

  let best = null;
  let bestScore = -Infinity;

  for (const f of frontiers) {
    const dx = f.centroid.x - robotX;
    const dy = f.centroid.y - robotY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Score: prefer large, nearby frontiers
    // Size weight: bigger frontiers = more area to map
    // Distance penalty: closer is better (less travel time)
    const score = f.size * 10 - dist * 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  return best;
}

// ============ PATH FOLLOWING ============

function startNavigation(targetXmm, targetYmm) {
  const odom = odometry.getOdometry();

  console.log(`[NAV] Planning path from (${odom.x.toFixed(0)}, ${odom.y.toFixed(0)}) to (${targetXmm.toFixed(0)}, ${targetYmm.toFixed(0)}) mm`);

  // A* pathfind
  const path = astar(odom.x, odom.y, targetXmm, targetYmm);

  if (!path || path.length === 0) {
    console.log('[NAV] No path found!');
    state.broadcast({ type: 'nav_status', status: 'no_path', targetX: targetXmm, targetY: targetYmm });
    return false;
  }

  navPath = path;
  navPathIndex = 0;
  navTargetX = targetXmm;
  navTargetY = targetYmm;
  navActive = true;

  // Broadcast path to UI for visualization
  state.broadcast({
    type: 'nav_path',
    path: path,
    target: { x: targetXmm, y: targetYmm }
  });

  // Start path-following loop
  if (navInterval) clearInterval(navInterval);
  navInterval = setInterval(followPath, 300);  // Every 300ms

  console.log(`[NAV] Navigation started: ${path.length} waypoints`);
  state.broadcast({ type: 'nav_status', status: 'navigating', waypoints: path.length });

  return true;
}

function stopNavigation(reason = 'cancelled') {
  navActive = false;
  navPath = [];
  navPathIndex = 0;

  if (navInterval) {
    clearInterval(navInterval);
    navInterval = null;
  }

  // Send stop command
  const rs = state.getRobotSocket();
  if (rs && rs.readyState === 1) {
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: "STOP" }));
  }

  state.broadcast({ type: 'nav_status', status: reason });
  state.broadcast({ type: 'nav_path', path: [] });  // Clear path visualization
  console.log(`[NAV] Navigation stopped: ${reason}`);
}

// Check LIDAR for obstacles in the robot's forward path (real-time safety)
function checkLidarClearance(heading, moveForward) {
  if (!latestLidarPoints || latestLidarPoints.length === 0) {
    return { clear: false, minDist: 0 };  // No LIDAR = don't move
  }

  let minDist = 99999;
  const headingDeg = heading * 180 / Math.PI;

  for (const [angleDeg, distMm] of latestLidarPoints) {
    if (distMm < 30 || distMm > 8000) continue;

    // Check cone in direction of travel (±45° from heading)
    let relAngle = angleDeg - 90;  // LIDAR 0° offset
    let diff = relAngle - (moveForward ? 0 : 180);

    // Normalize
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;

    // Within ±75° cone of travel direction (wide enough to catch side walls)
    if (Math.abs(diff) < 75) {
      if (distMm < minDist) minDist = distMm;
    }
  }

  return {
    clear: minDist > LIDAR_DANGER_MM,
    caution: minDist < LIDAR_CAUTION_MM,
    minDist: minDist
  };
}

function followPath() {
  if (!navActive || navPath.length === 0) return;

  // SAFETY: Manual override always wins (Xbox controller, UI drive buttons)
  if (global.manualOverrideUntil && Date.now() < global.manualOverrideUntil) {
    return;  // Wait silently
  }

  if (global.emergencyStopActive) {
    stopNavigation('emergency_stop');
    return;
  }

  const odom = odometry.getOdometry();
  const robotX = odom.x;   // mm
  const robotY = odom.y;   // mm
  const robotHeading = odom.heading;  // radians

  // Check if arrived at final target
  const dxFinal = navTargetX - robotX;
  const dyFinal = navTargetY - robotY;
  const distFinal = Math.sqrt(dxFinal * dxFinal + dyFinal * dyFinal);

  if (distFinal < ARRIVAL_DISTANCE) {
    stopNavigation('arrived');
    console.log('[NAV] Arrived at destination!');
    return;
  }

  // Get current waypoint
  if (navPathIndex >= navPath.length) {
    stopNavigation('arrived');
    return;
  }

  // SAFETY: Re-plan path periodically (obstacles may have appeared)
  const now = Date.now();
  if (now - lastReplanTime > REPLAN_INTERVAL) {
    lastReplanTime = now;
    const newPath = astar(robotX, robotY, navTargetX, navTargetY);
    if (newPath && newPath.length > 0) {
      navPath = newPath;
      navPathIndex = 0;
      state.broadcast({ type: 'nav_path', path: navPath, target: { x: navTargetX, y: navTargetY } });
      console.log('[NAV] Re-planned path: ' + newPath.length + ' waypoints');
    } else {
      // Path now blocked - stop
      stopNavigation('path_blocked');
      console.log('[NAV] Path blocked after re-plan - stopping');
      return;
    }
  }

  const waypoint = navPath[navPathIndex];
  const dx = waypoint.x - robotX;
  const dy = waypoint.y - robotY;
  const distToWaypoint = Math.sqrt(dx * dx + dy * dy);

  // Close enough to current waypoint? Move to next
  if (distToWaypoint < WAYPOINT_DISTANCE && navPathIndex < navPath.length - 1) {
    navPathIndex++;
    console.log(`[NAV] Waypoint ${navPathIndex}/${navPath.length}`);
    return;
  }

  // Calculate desired heading to waypoint
  const targetHeading = Math.atan2(dx, dy);  // atan2(x,y) because heading 0 = +Y
  let turnAngle = targetHeading - robotHeading;

  // Normalize to [-PI, PI]
  while (turnAngle > Math.PI) turnAngle -= 2 * Math.PI;
  while (turnAngle < -Math.PI) turnAngle += 2 * Math.PI;

  const turnDeg = turnAngle * 180 / Math.PI;

  const rs = state.getRobotSocket();
  if (!rs || rs.readyState !== 1) return;

  // SAFETY: Real-time LIDAR obstacle check before ANY forward movement
  const lidarCheck = checkLidarClearance(robotHeading, true);

  if (!lidarCheck.clear) {
    // OBSTACLE AHEAD - stop immediately and re-plan
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: "STOP" }));
    console.log(`[NAV-SAFETY] LIDAR obstacle at ${lidarCheck.minDist}mm - stopping and re-planning`);

    // Force immediate re-plan
    lastReplanTime = 0;

    state.broadcast({
      type: 'nav_status',
      status: 'obstacle',
      minDist: lidarCheck.minDist
    });
    return;
  }

  // Ensure motors are enabled (Teensy starts in MODE_MANUAL which ignores AUTO commands)
  rs.send(JSON.stringify({ type: "serial_cmd", cmd: "MODE_MAPPING" }));

  // If we need to turn significantly, turn first (no forward motion while turning)
  if (Math.abs(turnDeg) > 15) {
    const turnCmd = turnDeg > 0 ? 'AUTO_RIGHT' : 'AUTO_LEFT';
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: `${turnCmd},${TURN_SPEED}` }));
  } else {
    // Heading is close enough, drive forward
    // Slow down when LIDAR sees something in caution zone
    let speed = NAV_SPEED;
    if (lidarCheck.caution) {
      speed = Math.max(1, Math.round(NAV_SPEED * (lidarCheck.minDist / LIDAR_CAUTION_MM)));
    }
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: `AUTO_FWD,${speed}` }));
  }

  // Broadcast progress
  state.broadcast({
    type: 'nav_status',
    status: 'navigating',
    waypointIndex: navPathIndex,
    waypointTotal: navPath.length,
    distanceRemaining: Math.round(distFinal),
    turnAngle: Math.round(turnDeg),
    lidarMin: Math.round(lidarCheck.minDist)
  });
}

// ============ AUTONOMOUS EXPLORATION ============

function startExploration() {
  if (exploreActive) return;
  exploreActive = true;
  console.log('[EXPLORE] Starting autonomous exploration');

  // Clear occupied cells near robot so A* can start
  // These are often false readings from the robot's own body
  const odom = odometry.getOdometry();
  const clearRadius = 500;  // Clear 50cm around robot
  for (const key in grid) {
    const cell = grid[key];
    if (cell.state === OCCUPIED) {
      const [gx, gy] = key.split(',').map(Number);
      const world = gridToWorld(gx, gy);
      const dx = world.x - odom.x;
      const dy = world.y - odom.y;
      if (dx * dx + dy * dy < clearRadius * clearRadius) {
        cell.state = FREE;
        cell.confidence = 0.5;
        gridStats.occupiedCells--;
        gridStats.freeCells++;
      }
    }
  }
  console.log('[EXPLORE] Cleared occupied cells near robot');

  state.broadcast({ type: 'explore_status', active: true });

  exploreNextFrontier();
}

function stopExploration() {
  exploreActive = false;
  if (exploreInterval) {
    clearInterval(exploreInterval);
    exploreInterval = null;
  }
  stopNavigation('explore_stopped');
  console.log('[EXPLORE] Exploration stopped');
  state.broadcast({ type: 'explore_status', active: false });
}

function exploreNextFrontier() {
  if (!exploreActive) return;

  // Simple reactive exploration: drive forward, turn when obstacle detected
  // Much more reliable than A* pathfinding with noisy LIDAR data
  if (exploreInterval) clearInterval(exploreInterval);
  exploreInterval = setInterval(reactiveExplore, 300);
  console.log('[EXPLORE] Starting reactive exploration (drive + avoid)');
  return;

  // --- A* frontier exploration below (disabled - too fragile with noisy grid) ---
  const frontier = pickBestFrontier();

  if (!frontier) {
    console.log('[EXPLORE] No frontiers found - area fully explored!');
    state.broadcast({ type: 'explore_status', active: false, reason: 'complete' });
    exploreActive = false;
    return;
  }

  console.log(`[EXPLORE] Heading to frontier at (${frontier.centroid.x.toFixed(0)}, ${frontier.centroid.y.toFixed(0)}) mm, size=${frontier.size} cells`);

  // Navigate to frontier centroid
  const success = startNavigation(frontier.centroid.x, frontier.centroid.y);

  if (!success) {
    // Can't reach this frontier, try again in a few seconds
    console.log('[EXPLORE] Frontier unreachable, will retry...');
    exploreInterval = setTimeout(() => {
      exploreNextFrontier();
    }, 3000);
  } else {
    // Check periodically if we arrived (nav will stop itself, then we pick next frontier)
    exploreInterval = setInterval(() => {
      if (!navActive && exploreActive) {
        clearInterval(exploreInterval);
        exploreInterval = null;
        // Small delay before picking next frontier (let LIDAR scan the new area)
        setTimeout(() => {
          exploreNextFrontier();
        }, 2000);
      }
    }, 500);
  }

  // Broadcast frontier info to UI
  const allFrontiers = findFrontiers().slice(0, 10);  // Top 10
  state.broadcast({
    type: 'frontiers',
    frontiers: allFrontiers.map(f => ({
      x: f.centroid.x,
      y: f.centroid.y,
      size: f.size
    })),
    target: frontier.centroid
  });
}

// ============ GRID BROADCAST ============

function broadcastGridUpdate() {
  // Send compact grid data to UI for visualization
  // Only send cells near robot (within 15m) to save bandwidth
  const odom = odometry.getOdometry();
  const robotGrid = worldToGrid(odom.x, odom.y);
  const VIEW_RADIUS = 150;  // 15m in grid cells

  const cells = [];
  for (const [key, cell] of Object.entries(grid)) {
    const [gx, gy] = key.split(',').map(Number);

    // Only cells within view radius
    const dx = gx - robotGrid.gx;
    const dy = gy - robotGrid.gy;
    if (dx * dx + dy * dy > VIEW_RADIUS * VIEW_RADIUS) continue;

    const world = gridToWorld(gx, gy);
    cells.push({
      x: Math.round(world.x),
      y: Math.round(world.y),
      s: cell.state,  // 1=free, 2=occupied
      c: Math.round(cell.confidence * 100) / 100
    });
  }

  state.broadcast({
    type: 'grid_update',
    cells: cells,
    stats: gridStats,
    cellSize: CELL_SIZE * 1000  // mm
  });
}

// ============ REACTIVE EXPLORATION ============
// Simple: drive forward slowly, turn when obstacle ahead. No A* needed.
let reactiveState = 'forward';  // 'forward', 'turning_left', 'turning_right'
let reactiveTimer = 0;

let reactiveDebugCount = 0;
function reactiveExplore() {
  reactiveDebugCount++;
  const shouldLog = (reactiveDebugCount % 10 === 0);  // Log every 3 seconds (10 * 300ms)

  if (!exploreActive) {
    if (exploreInterval) { clearInterval(exploreInterval); exploreInterval = null; }
    return;
  }

  // Manual override pauses
  if (global.manualOverrideUntil && Date.now() < global.manualOverrideUntil) {
    if (shouldLog) console.log('[EXPLORE-DBG] Blocked by manual override');
    return;
  }
  if (global.emergencyStopActive) { stopExploration(); return; }

  const rs = state.getRobotSocket();
  if (!rs || rs.readyState !== 1) {
    if (shouldLog) console.log(`[EXPLORE-DBG] No robot socket (rs=${rs ? 'exists' : 'null'}, state=${rs ? rs.readyState : 'N/A'})`);
    return;
  }

  // Enable motors
  rs.send(JSON.stringify({ type: "serial_cmd", cmd: "MODE_MAPPING" }));

  // SAFETY: Tilt = immediate stop
  if (safetyTilt) {
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: "STOP" }));
    console.log('[EXPLORE] TILT DETECTED - emergency stop!');
    stopExploration();
    state.broadcast({ type: 'nav_status', status: 'stopped', reason: 'tilt' });
    return;
  }

  // STALL: Wheels spinning but not moving = stuck against something
  if (isStalled && reactiveState === 'forward') {
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: "AUTO_STOP" }));
    reactiveState = Math.random() > 0.5 ? 'turning_left' : 'turning_right';
    reactiveTimer = Date.now();
    console.log('[EXPLORE] STALL detected - wheels spinning, turning away');
    state.broadcast({ type: 'nav_status', status: 'stalled' });
    isStalled = false;
    stallStartTime = Date.now();
    return;
  }

  // Check LIDAR for obstacles
  const odom = odometry.getOdometry();
  const fwdCheck = checkLidarClearance(odom.heading, true);

  // Check SONAR - overrides LIDAR if sonar detects close obstacle
  const sonarBlocked = (latestSonar.fl < SONAR_DANGER_CM || latestSonar.fr < SONAR_DANGER_CM);
  if (sonarBlocked) {
    fwdCheck.clear = false;
    fwdCheck.minDist = Math.min(latestSonar.fl, latestSonar.fr) * 10; // cm to mm
  }

  if (shouldLog) console.log(`[EXPLORE-DBG] state=${reactiveState} lidarPts=${latestLidarPoints.length} clear=${fwdCheck.clear} minDist=${fwdCheck.minDist}mm sonar=[FL:${latestSonar.fl} FR:${latestSonar.fr}]cm heading=${(odom.heading * 180/Math.PI).toFixed(0)}°`);

  if (reactiveState === 'forward') {
    if (!fwdCheck.clear) {
      // Obstacle ahead — stop and turn
      rs.send(JSON.stringify({ type: "serial_cmd", cmd: "AUTO_STOP" }));
      reactiveState = Math.random() > 0.5 ? 'turning_left' : 'turning_right';
      reactiveTimer = Date.now();
      console.log(`[EXPLORE] Obstacle at ${fwdCheck.minDist}mm — ${reactiveState}`);
      state.broadcast({ type: 'nav_status', status: 'turning', obstacle: fwdCheck.minDist });
    } else {
      // Clear ahead — drive forward slowly
      let speed = NAV_SPEED;
      if (fwdCheck.caution) speed = Math.max(1, Math.round(NAV_SPEED * 0.5));
      const cmd = `AUTO_FWD,${speed}`;
      rs.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
      if (shouldLog) console.log(`[EXPLORE-CMD] Sent: MODE_MAPPING + ${cmd} to robot (rs.readyState=${rs.readyState})`);
      state.broadcast({ type: 'nav_status', status: 'exploring', lidarMin: fwdCheck.minDist });
    }
  } else {
    // Turning — turn for 2 seconds then check if clear
    const turnCmd = reactiveState === 'turning_left' ? 'AUTO_LEFT' : 'AUTO_RIGHT';
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: `${turnCmd},${TURN_SPEED}` }));

    if (Date.now() - reactiveTimer > 2000) {
      // Check if forward is now clear
      if (fwdCheck.clear) {
        reactiveState = 'forward';
        console.log('[EXPLORE] Clear ahead — driving forward');
      } else {
        // Still blocked, keep turning
        reactiveTimer = Date.now();
        console.log(`[EXPLORE] Still blocked (${fwdCheck.minDist}mm) — keep turning`);
      }
    }
  }
}

// ============ EXPORTS ============

module.exports = {
  processLidarScan,
  updateSonar,
  updateEncoders,
  updateSafety,
  startNavigation,
  stopNavigation,
  startExploration,
  stopExploration,
  findFrontiers,
  getGridStats: () => gridStats,
  isNavActive: () => navActive,
  isExploreActive: () => exploreActive,
  getNavPath: () => navPath,
  grid,  // Direct access for debugging
  CELL_SIZE,
  FREE,
  OCCUPIED,
  UNKNOWN
};
