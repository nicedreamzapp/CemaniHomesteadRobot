// ============ 3D LIDAR VISUALIZATION ============
// Three.js scene, robot model, grid, and SLAM mapping

let lidar3dScene, lidar3dCamera, lidar3dRenderer, lidar3dControls;
let lidar3dRobot, lidar3dWalls = [], lidar3dPointCloud;
let lidar3dTrailLine = null, lidar3dTrailGeom = null;
let lidar3dInitialized = false;
let lidar3dFrameCount = 0;
let lidar3dWorldContainer = null;
let lidar3dSlamPoints = [];
let lidar3dSlamCloud = null;
let lidar3dUltrasonicCones = { FL: null, FR: null, RL: null, RR: null };
const SLAM_MAX_POINTS = 50000;
const SLAM_POINT_SPACING = 0.03;
let lastLidarUpdate = 0;
const LIDAR_UPDATE_INTERVAL = 33;  // ~30fps for smooth real-time display
let animFrameCount = 0;

// Occupancy grid visualization
let occupancyGridMesh = null;
let lastGridUpdate = 0;
const GRID_UPDATE_INTERVAL = 500;  // Update visualization every 500ms
let mappingEnabled = true;  // Enabled - builds occupancy grid as robot explores
let showOccupancyGrid = false;  // Disabled - don't show green/red floor tiles (clutters view)

// Initialize odomState
window.odomState = window.odomState || { x: 0, y: 0, heading: 0, totalDistance: 0, trail: [{ x: 0, y: 0 }] };

// GPS and Compass state
window.gpsState = window.gpsState || { valid: false, lat: 0, lon: 0, sats: 0, lastLat: 0, lastLon: 0 };
window.compassState = window.compassState || { heading: 0, x: 0, y: 0, z: 0 };

// Compass visual elements
let compassRose = null;
let compassNeedle = null;

// ============ RESET FUNCTION ============
window.clearLidarSlamMap = function() {
  console.log('[RESET] Clearing everything...');
  lidar3dSlamPoints = [];

  if (lidar3dTrailGeom) {
    lidar3dTrailGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  }

  if (lidar3dSlamCloud) {
    lidar3dSlamCloud.geometry.dispose();
    lidar3dSlamCloud.geometry = new THREE.BufferGeometry();
  }

  if (lidar3dWorldContainer) {
    lidar3dWorldContainer.position.set(0, 0, 0);
    lidar3dWorldContainer.rotation.y = 0;
  }

  if (lidar3dRobot) {
    lidar3dRobot.position.set(0, 0, 0);
    lidar3dRobot.rotation.y = 0;
  }

  lidar3dWalls.forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    lidar3dScene.remove(m);
  });
  lidar3dWalls = [];

  if (window.odomState) {
    window.odomState.x = 0;
    window.odomState.y = 0;
    window.odomState.heading = 0;
    window.odomState.totalDistance = 0;
    window.odomState.trail = [{ x: 0, y: 0 }];
  }

  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'reset_odometry' }));
  }

  if (lidar3dRenderer && lidar3dScene && lidar3dCamera) {
    lidar3dRenderer.render(lidar3dScene, lidar3dCamera);
  }

  console.log('[RESET] Complete');
};

// ============ INITIALIZATION ============
function initLidar3D() {
  const container = document.getElementById('lidar3dContainer');
  if (!container || lidar3dInitialized) return;

  lidar3dScene = new THREE.Scene();
  lidar3dScene.background = new THREE.Color(0x0a0a12);
  lidar3dScene.fog = new THREE.Fog(0x0a0a12, 6, 15);

  const w = container.clientWidth;
  const h = container.clientHeight;
  lidar3dCamera = new THREE.PerspectiveCamera(55, w / h, 0.1, 50);
  lidar3dCamera.position.set(3, 4, 3);
  lidar3dCamera.lookAt(0, 0, 0);

  lidar3dRenderer = new THREE.WebGLRenderer({ antialias: true });
  lidar3dRenderer.setSize(w, h);
  lidar3dRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.insertBefore(lidar3dRenderer.domElement, container.firstChild);

  lidar3dControls = new THREE.OrbitControls(lidar3dCamera, lidar3dRenderer.domElement);
  lidar3dControls.enableDamping = true;
  lidar3dControls.dampingFactor = 0.05;
  lidar3dControls.maxPolarAngle = Math.PI / 2.1;
  lidar3dControls.minDistance = 1.5;
  lidar3dControls.maxDistance = 10;

  lidar3dScene.add(new THREE.AmbientLight(0x404040, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(5, 8, 5);
  lidar3dScene.add(dirLight);

  lidar3dWorldContainer = new THREE.Group();
  lidar3dScene.add(lidar3dWorldContainer);

  // Ground (no grid - was not moving properly)
  const groundGeom = new THREE.PlaneGeometry(30, 30);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a1520, transparent: true, opacity: 0.7 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  lidar3dWorldContainer.add(ground);

  lidar3dRobot = createRobot3D();
  lidar3dScene.add(lidar3dRobot);

  // Trail line - DISABLED (was cluttering the view)
  // lidar3dTrailGeom = new THREE.BufferGeometry();
  // const trailMat = new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 });
  // lidar3dTrailLine = new THREE.Line(lidar3dTrailGeom, trailMat);
  // lidar3dWorldContainer.add(lidar3dTrailLine);

  // SLAM point cloud - DISABLED (was cluttering the view)
  // lidar3dSlamCloud = new THREE.Points(
  //   new THREE.BufferGeometry(),
  //   new THREE.PointsMaterial({ size: 0.08, vertexColors: true, transparent: true, opacity: 0.8 })
  // );
  // lidar3dWorldContainer.add(lidar3dSlamCloud);

  lidar3dInitialized = true;
  animateLidar3D();
}

// ============ ROBOT MODEL ============
// Accurate model based on actual robot: aluminum extrusion frame, 8" wheels, LIDAR tower, PTZ camera
function createRobot3D() {
  const group = new THREE.Group();

  // Materials
  const aluminumMat = new THREE.MeshPhongMaterial({ color: 0xc0c0c0, specular: 0x404040, shininess: 30 });
  const darkAluminumMat = new THREE.MeshPhongMaterial({ color: 0x808080 });
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, specular: 0x333333 });
  const greenLedMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
  const whiteMat = new THREE.MeshPhongMaterial({ color: 0xf0f0f0 });
  const blackMat = new THREE.MeshPhongMaterial({ color: 0x222222 });

  // Dimensions (in meters) - rectangular frame, taller than wide, wheels extend outward
  const frameWidth = 0.30;   // 30cm wide (narrow)
  const frameDepth = 0.45;   // 45cm deep (longer front-to-back)
  const frameHeight = 0.40;  // 40cm tall main frame (taller)
  const wheelRadius = 0.10;  // 8-inch wheels = ~20cm diameter
  const wheelWidth = 0.06;   // 6cm wide wheels
  const tubeSize = 0.025;    // 2.5cm aluminum extrusion
  const wheelOffset = 0.10;  // Wheels extend 10cm beyond frame on each side
  const midShelfHeight = 0.18; // Mid-level shelf at 18cm

  // Ground clearance
  const groundClearance = wheelRadius * 0.5;

  // ===== ALUMINUM EXTRUSION FRAME =====
  // Vertical corner posts
  const postGeom = new THREE.BoxGeometry(tubeSize, frameHeight, tubeSize);
  const postPositions = [
    [-frameWidth/2 + tubeSize/2, groundClearance + frameHeight/2, -frameDepth/2 + tubeSize/2],
    [frameWidth/2 - tubeSize/2, groundClearance + frameHeight/2, -frameDepth/2 + tubeSize/2],
    [-frameWidth/2 + tubeSize/2, groundClearance + frameHeight/2, frameDepth/2 - tubeSize/2],
    [frameWidth/2 - tubeSize/2, groundClearance + frameHeight/2, frameDepth/2 - tubeSize/2]
  ];
  postPositions.forEach(pos => {
    const post = new THREE.Mesh(postGeom, aluminumMat);
    post.position.set(...pos);
    group.add(post);
  });

  // Horizontal rails - bottom
  const railXGeom = new THREE.BoxGeometry(frameWidth - tubeSize*2, tubeSize, tubeSize);
  const railZGeom = new THREE.BoxGeometry(tubeSize, tubeSize, frameDepth - tubeSize*2);

  // Bottom frame
  [[-frameDepth/2 + tubeSize/2, groundClearance + tubeSize/2], [frameDepth/2 - tubeSize/2, groundClearance + tubeSize/2]].forEach(([z, y]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, y, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2, groundClearance + tubeSize/2], [frameWidth/2 - tubeSize/2, groundClearance + tubeSize/2]].forEach(([x, y]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, y, 0);
    group.add(rail);
  });

  // Mid-level frame (shelf at midShelfHeight)
  [[-frameDepth/2 + tubeSize/2, groundClearance + midShelfHeight], [frameDepth/2 - tubeSize/2, groundClearance + midShelfHeight]].forEach(([z, y]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, y, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2, groundClearance + midShelfHeight], [frameWidth/2 - tubeSize/2, groundClearance + midShelfHeight]].forEach(([x, y]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, y, 0);
    group.add(rail);
  });

  // Top frame
  [[-frameDepth/2 + tubeSize/2, groundClearance + frameHeight - tubeSize/2], [frameDepth/2 - tubeSize/2, groundClearance + frameHeight - tubeSize/2]].forEach(([z, y]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, y, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2, groundClearance + frameHeight - tubeSize/2], [frameWidth/2 - tubeSize/2, groundClearance + frameHeight - tubeSize/2]].forEach(([x, y]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, y, 0);
    group.add(rail);
  });

  // ===== LIDAR TOWER (rear center - short mount) =====
  const towerHeight = 0.18;  // Short tower - just 18cm above frame
  const towerGeom = new THREE.BoxGeometry(tubeSize, towerHeight, tubeSize);
  const tower1 = new THREE.Mesh(towerGeom, aluminumMat);
  tower1.position.set(-0.06, groundClearance + frameHeight + towerHeight/2, frameDepth/2 - 0.06);
  group.add(tower1);
  const tower2 = new THREE.Mesh(towerGeom, aluminumMat);
  tower2.position.set(0.06, groundClearance + frameHeight + towerHeight/2, frameDepth/2 - 0.06);
  group.add(tower2);

  // Tower cross beam at top
  const towerBeamGeom = new THREE.BoxGeometry(0.15, tubeSize, tubeSize);
  const towerBeam = new THREE.Mesh(towerBeamGeom, aluminumMat);
  towerBeam.position.set(0, groundClearance + frameHeight + towerHeight - tubeSize/2, frameDepth/2 - 0.06);
  group.add(towerBeam);

  // Green LED strip on tower
  const ledGeom = new THREE.BoxGeometry(0.008, towerHeight * 0.8, 0.008);
  const led = new THREE.Mesh(ledGeom, greenLedMat);
  led.position.set(0.07, groundClearance + frameHeight + towerHeight * 0.5, frameDepth/2 - 0.06);
  group.add(led);

  // ===== LIDAR SENSOR (black cylinder on top of tower) =====
  const lidarGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.035, 16);
  const lidarMat = new THREE.MeshPhongMaterial({ color: 0x111111, specular: 0x222222 });
  const lidar = new THREE.Mesh(lidarGeom, lidarMat);
  lidar.position.set(0, groundClearance + frameHeight + towerHeight + 0.02, frameDepth/2 - 0.06);
  group.add(lidar);

  // LIDAR spinning indicator
  const lidarRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.04, 0.004, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x00ff88 })
  );
  lidarRing.rotation.x = Math.PI / 2;
  lidarRing.position.copy(lidar.position);
  lidarRing.position.y += 0.02;
  group.add(lidarRing);

  // ===== PTZ CAMERA (front-left on arm) =====
  // Camera arm
  const armGeom = new THREE.BoxGeometry(0.15, tubeSize * 0.7, tubeSize * 0.7);
  const arm = new THREE.Mesh(armGeom, darkAluminumMat);
  arm.position.set(-frameWidth/2 - 0.05, groundClearance + frameHeight * 0.7, -frameDepth/2 + 0.10);
  group.add(arm);

  // PTZ dome camera (white sphere-ish)
  const cameraBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 0.03, 16),
    whiteMat
  );
  cameraBase.position.set(-frameWidth/2 - 0.12, groundClearance + frameHeight * 0.7, -frameDepth/2 + 0.10);
  group.add(cameraBase);

  const cameraDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    whiteMat
  );
  cameraDome.position.set(-frameWidth/2 - 0.12, groundClearance + frameHeight * 0.7 - 0.01, -frameDepth/2 + 0.10);
  cameraDome.rotation.x = Math.PI;
  group.add(cameraDome);

  // Camera lens
  const lensGeom = new THREE.SphereGeometry(0.02, 12, 8);
  const lensMat = new THREE.MeshPhongMaterial({ color: 0x111122, specular: 0x4444ff, shininess: 100 });
  const lens = new THREE.Mesh(lensGeom, lensMat);
  lens.position.set(-frameWidth/2 - 0.12, groundClearance + frameHeight * 0.7 - 0.04, -frameDepth/2 + 0.10);
  group.add(lens);

  // ===== WHEELS (4 large wheels extending outward from frame) =====
  const wheelGeom = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 24);
  const hubGeom = new THREE.CylinderGeometry(wheelRadius * 0.35, wheelRadius * 0.35, wheelWidth + 0.01, 16);
  const hubMat = new THREE.MeshPhongMaterial({ color: 0x555555 });
  const motorHousingMat = new THREE.MeshPhongMaterial({ color: 0x333333 });

  // Wheels extend beyond frame width
  const totalWidth = frameWidth + wheelOffset * 2;
  const wheelY = wheelRadius;
  const wheelPositions = [
    { x: -totalWidth/2 + wheelWidth/2, z: -frameDepth/2 + 0.08, side: 'left' },   // Front-left
    { x: totalWidth/2 - wheelWidth/2, z: -frameDepth/2 + 0.08, side: 'right' },   // Front-right
    { x: -totalWidth/2 + wheelWidth/2, z: frameDepth/2 - 0.08, side: 'left' },    // Rear-left
    { x: totalWidth/2 - wheelWidth/2, z: frameDepth/2 - 0.08, side: 'right' }     // Rear-right
  ];

  wheelPositions.forEach(pos => {
    // Motor housing (box connecting frame to wheel)
    const housingGeom = new THREE.BoxGeometry(wheelOffset - 0.02, 0.08, 0.10);
    const housing = new THREE.Mesh(housingGeom, motorHousingMat);
    const housingX = pos.side === 'left' ? -frameWidth/2 - wheelOffset/2 + 0.01 : frameWidth/2 + wheelOffset/2 - 0.01;
    housing.position.set(housingX, groundClearance + 0.04, pos.z);
    group.add(housing);

    // Wheel
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(pos.x, wheelY, pos.z);
    group.add(wheel);

    // Hub cap
    const hub = new THREE.Mesh(hubGeom, hubMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(pos.x, wheelY, pos.z);
    group.add(hub);
  });

  // ===== ELECTRONICS BAY (visible inside frame) =====
  const electronicsGeom = new THREE.BoxGeometry(frameWidth * 0.6, 0.08, frameDepth * 0.5);
  const electronicsMat = new THREE.MeshPhongMaterial({ color: 0x1a3320, emissive: 0x001100 });
  const electronics = new THREE.Mesh(electronicsGeom, electronicsMat);
  electronics.position.set(0, groundClearance + 0.10, 0);
  group.add(electronics);

  // ===== FRONT DIRECTION INDICATOR =====
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.08);
  arrowShape.lineTo(-0.04, 0);
  arrowShape.lineTo(0.04, 0);
  arrowShape.closePath();
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(arrowShape),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, groundClearance + 0.01, -frameDepth/2 - 0.05);
  group.add(arrow);

  // Ultrasonic cones - positioned at outer wheel positions, point outward
  const conePositions = {
    FL: { x: -totalWidth/2, z: -frameDepth/2 + 0.05, rotY: Math.PI * 0.25 },
    FR: { x: totalWidth/2, z: -frameDepth/2 + 0.05, rotY: -Math.PI * 0.25 },
    RL: { x: -totalWidth/2, z: frameDepth/2 - 0.05, rotY: -Math.PI * 0.75 },
    RR: { x: totalWidth/2, z: frameDepth/2 - 0.05, rotY: Math.PI * 0.75 }
  };

  Object.keys(conePositions).forEach(sensor => {
    const pos = conePositions[sensor];
    const coneGeom = new THREE.ConeGeometry(0.20, 0.6, 16, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false
    });
    const cone = new THREE.Mesh(coneGeom, coneMat);
    const isFront = sensor === 'FL' || sensor === 'FR';
    cone.rotation.x = isFront ? Math.PI / 2 : -Math.PI / 2;
    cone.rotation.y = pos.rotY;
    cone.position.set(pos.x, wheelY, pos.z);
    cone.visible = false;
    cone.userData.sensor = sensor;
    group.add(cone);
    lidar3dUltrasonicCones[sensor] = cone;
  });

  return group;
}

function getDistanceColor3D(dist) {
  if (dist < 400) return new THREE.Color(0xff2020);
  if (dist < 800) return new THREE.Color(0xff8800);
  if (dist < 1200) return new THREE.Color(0xffcc00);
  if (dist < 1800) return new THREE.Color(0x00dd66);
  return new THREE.Color(0x00aaff);
}

// ============ UPDATE LIDAR POINTS ============
function updateLidar3D(points) {
  if (!lidar3dInitialized) initLidar3D();
  if (!lidar3dScene) return;

  const now = Date.now();
  if (now - lastLidarUpdate < LIDAR_UPDATE_INTERVAL) return;
  lastLidarUpdate = now;

  lidar3dFrameCount++;
  const statusEl = document.getElementById('lidar3dStatus');
  if (statusEl) statusEl.textContent = 'LIDAR: ' + points.length + ' pts';

  const odom = window.odomState;
  const robotX = odom && odom.x !== undefined ? odom.x / 1000 : 0;
  const robotZ = odom && odom.y !== undefined ? odom.y / 1000 : 0;
  const robotHeading = odom && odom.heading !== undefined ? odom.heading : 0;

  // Update trail
  if (odom && odom.trail && odom.trail.length > 0) {
    const trailPositions = [];
    odom.trail.forEach(p => {
      trailPositions.push(p.x / 1000, 0.05, -p.y / 1000);
    });
    trailPositions.push(robotX, 0.05, -robotZ);
    if (lidar3dTrailGeom) {
      lidar3dTrailGeom.setAttribute('position', new THREE.Float32BufferAttribute(trailPositions, 3));
      lidar3dTrailGeom.attributes.position.needsUpdate = true;
    }
  }

  // Clear old walls
  lidar3dWalls.forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    lidar3dScene.remove(m);
  });
  lidar3dWalls = [];
  if (lidar3dPointCloud) {
    if (lidar3dPointCloud.geometry) lidar3dPointCloud.geometry.dispose();
    if (lidar3dPointCloud.material) lidar3dPointCloud.material.dispose();
    lidar3dScene.remove(lidar3dPointCloud);
  }

  points.sort((a, b) => a[0] - b[0]);

  const positions = [], colors = [];
  const slamNewPoints = [];

  for (const [angle, dist] of points) {
    const rad = (angle - 90) * Math.PI / 180;
    const localX = (dist / 1000) * Math.cos(rad);
    const localZ = (dist / 1000) * Math.sin(rad);

    positions.push(localX, 0.24, localZ);
    const c = getDistanceColor3D(dist);
    colors.push(c.r, c.g, c.b);

    // SLAM accumulation
    const worldX = robotX + localX * Math.cos(robotHeading) - localZ * Math.sin(robotHeading);
    const worldZ = -robotZ + localX * Math.sin(robotHeading) + localZ * Math.cos(robotHeading);

    if (dist > 100 && dist < 5000) {
      slamNewPoints.push({ x: worldX, z: worldZ, color: c });
    }
  }

  // Update occupancy grid if enabled
  if (mappingEnabled && window.OccupancyGrid) {
    window.OccupancyGrid.processLidarScan(robotX, -robotZ, robotHeading, points);
  }

  // Add SLAM points with spacing filter
  for (const np of slamNewPoints) {
    let tooClose = false;
    const checkStart = Math.max(0, lidar3dSlamPoints.length - 500);
    for (let i = checkStart; i < lidar3dSlamPoints.length; i++) {
      const sp = lidar3dSlamPoints[i];
      const dx = np.x - sp.x, dz = np.z - sp.z;
      if (dx * dx + dz * dz < SLAM_POINT_SPACING * SLAM_POINT_SPACING) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) lidar3dSlamPoints.push(np);
  }

  while (lidar3dSlamPoints.length > SLAM_MAX_POINTS) {
    lidar3dSlamPoints.shift();
  }

  // Update SLAM cloud
  if (lidar3dSlamCloud && lidar3dSlamPoints.length > 0) {
    const slamPos = [], slamCol = [];
    for (const sp of lidar3dSlamPoints) {
      slamPos.push(sp.x, 0.01, sp.z);
      slamCol.push(sp.color.r * 0.6, sp.color.g * 0.6, sp.color.b * 0.6);
    }
    const slamGeom = new THREE.BufferGeometry();
    slamGeom.setAttribute('position', new THREE.Float32BufferAttribute(slamPos, 3));
    slamGeom.setAttribute('color', new THREE.Float32BufferAttribute(slamCol, 3));
    lidar3dSlamCloud.geometry.dispose();
    lidar3dSlamCloud.geometry = slamGeom;
  }

  // Current scan point cloud
  const pointGeom = new THREE.BufferGeometry();
  pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  pointGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  lidar3dPointCloud = new THREE.Points(pointGeom, new THREE.PointsMaterial({ size: 0.08, vertexColors: true }));
  lidar3dScene.add(lidar3dPointCloud);

  // Walls
  for (let i = 0; i < points.length - 1; i++) {
    const [a1, d1] = points[i], [a2, d2] = points[i + 1];
    let diff = a2 - a1; if (diff < 0) diff += 360;
    if (diff > 6) continue;

    const r1 = (a1 - 90) * Math.PI / 180, r2 = (a2 - 90) * Math.PI / 180;
    const x1 = (d1 / 1000) * Math.cos(r1), z1 = (d1 / 1000) * Math.sin(r1);
    const x2 = (d2 / 1000) * Math.cos(r2), z2 = (d2 / 1000) * Math.sin(r2);

    const wallH = 0.6;
    const wallGeom = new THREE.BufferGeometry();
    wallGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      x1, 0, z1, x2, 0, z2, x2, wallH, z2, x1, 0, z1, x2, wallH, z2, x1, wallH, z1
    ]), 3));
    wallGeom.computeVertexNormals();

    const wallMat = new THREE.MeshBasicMaterial({
      color: getDistanceColor3D((d1 + d2) / 2), transparent: true, opacity: 0.35, side: THREE.DoubleSide
    });
    const wall = new THREE.Mesh(wallGeom, wallMat);
    lidar3dScene.add(wall);
    lidar3dWalls.push(wall);

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x1, wallH, z1, x2, wallH, z2]), 3));
    const edge = new THREE.Line(edgeGeom, new THREE.LineBasicMaterial({ color: getDistanceColor3D((d1 + d2) / 2) }));
    lidar3dScene.add(edge);
    lidar3dWalls.push(edge);
  }
}

// ============ ULTRASONIC 3D UPDATE ============
function updateUltrasonic3D(sensor, distCm) {
  const cone = lidar3dUltrasonicCones[sensor];
  if (!cone) return;

  if (distCm <= 0 || distCm > 600) {
    cone.visible = false;
    return;
  }

  cone.visible = true;
  const distM = distCm / 100;
  // Scale cone length based on distance, larger base radius
  const coneLength = Math.min(distM * 0.9, 5);
  const coneRadius = 0.15 + (distM * 0.08);
  // Base cone is 0.25 radius, 0.8 length
  cone.scale.set(coneRadius / 0.25, coneLength / 0.8, coneRadius / 0.25);

  let color;
  if (distCm < 50) color = 0xff0000;
  else if (distCm < 100) color = 0xff8800;
  else if (distCm < 200) color = 0xffff00;
  else color = 0x00ffff;
  cone.material.color.setHex(color);
  cone.material.opacity = distCm < 100 ? 0.5 : 0.3;
}

// ============ ANIMATION LOOP ============
function animateLidar3D() {
  if (!lidar3dInitialized) return;
  requestAnimationFrame(animateLidar3D);
  animFrameCount++;

  if (!window.odomState) window.odomState = { x: 0, y: 0, heading: 0, totalDistance: 0 };

  // ROBOT-CENTRIC: Grid slides under robot
  if (lidar3dWorldContainer && window.odomState) {
    const gridZ = -window.odomState.y / 1000;
    const gridX = window.odomState.x / 1000;
    lidar3dWorldContainer.position.z = gridZ;
    lidar3dWorldContainer.position.x = gridX;
    lidar3dWorldContainer.rotation.y = -window.odomState.heading;
  }

  // Robot stays at origin
  if (lidar3dRobot) {
    lidar3dRobot.position.set(0, 0, 0);
    lidar3dRobot.rotation.y = (window.odomState && window.odomState.heading) || 0;
  }

  lidar3dControls.update();

  // Update occupancy grid visualization
  updateOccupancyGridVisualization();

  lidar3dRenderer.render(lidar3dScene, lidar3dCamera);
}

// ============ OCCUPANCY GRID VISUALIZATION ============
function updateOccupancyGridVisualization() {
  // Only show visualization if explicitly enabled (mapping still runs in background)
  if (!lidar3dScene || !window.OccupancyGrid || !showOccupancyGrid) return;

  const now = Date.now();
  if (now - lastGridUpdate < GRID_UPDATE_INTERVAL) return;
  lastGridUpdate = now;

  // Remove old mesh
  if (occupancyGridMesh) {
    if (occupancyGridMesh.geometry) occupancyGridMesh.geometry.dispose();
    if (occupancyGridMesh.material) occupancyGridMesh.material.dispose();
    lidar3dWorldContainer.remove(occupancyGridMesh);
  }

  const cells = window.OccupancyGrid.getAllCells();
  if (cells.length === 0) return;

  const cellSize = window.OccupancyGrid.cellSize;
  const positions = [];
  const colors = [];

  for (const cell of cells) {
    // Create a small square for each cell
    const x = cell.x;
    const z = -cell.y;  // Flip Y for Three.js
    const y = 0.02;  // Slightly above ground

    // Two triangles for a quad
    positions.push(
      x - cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z + cellSize/2,
      x - cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z + cellSize/2,
      x - cellSize/2, y, z + cellSize/2
    );

    // Color based on state
    let r, g, b;
    if (cell.state === 1) {  // FREE
      r = 0.1; g = 0.6; b = 0.2;  // Green
    } else if (cell.state === 2) {  // OCCUPIED
      r = 0.8; g = 0.1; b = 0.1;  // Red
    } else {
      r = 0.3; g = 0.3; b = 0.3;  // Gray unknown
    }

    // Adjust brightness by confidence
    const conf = cell.confidence || 0.5;
    r *= conf; g *= conf; b *= conf;

    // 6 vertices per cell
    for (let i = 0; i < 6; i++) {
      colors.push(r, g, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  occupancyGridMesh = new THREE.Mesh(geometry, material);
  lidar3dWorldContainer.add(occupancyGridMesh);

  // Update map stats display
  const stats = window.OccupancyGrid.getStats();
  const statsEl = document.getElementById('mapStats');
  if (statsEl && stats) {
    statsEl.textContent = `Map: ${stats.freeCells} free | ${stats.occupiedCells} blocked | ${stats.coverage}`;
  }
}

function toggleMapping(enabled) {
  mappingEnabled = enabled;
  console.log('[MAP] Mapping', enabled ? 'enabled' : 'disabled');
}

function saveCurrentMap(name) {
  if (!window.OccupancyGrid) return null;
  const json = window.OccupancyGrid.exportMap();
  if (json) {
    // Save to localStorage for now
    localStorage.setItem(`robotMap_${name}`, json);
    console.log(`[MAP] Saved map: ${name}`);
    return true;
  }
  return false;
}

function loadMap(name) {
  if (!window.OccupancyGrid) return false;
  const json = localStorage.getItem(`robotMap_${name}`);
  if (json) {
    window.OccupancyGrid.importMap(json);
    console.log(`[MAP] Loaded map: ${name}`);
    return true;
  }
  return false;
}

function getStoredMaps() {
  const maps = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('robotMap_')) {
      maps.push(key.replace('robotMap_', ''));
    }
  }
  return maps;
}

// ============ RESIZE HANDLER ============
function resizeLidar3D() {
  const container = document.getElementById('lidar3dContainer');
  if (!container || !lidar3dRenderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  lidar3dCamera.aspect = w / h;
  lidar3dCamera.updateProjectionMatrix();
  lidar3dRenderer.setSize(w, h);
}

window.addEventListener('resize', resizeLidar3D);

// ============ FULLSCREEN TOGGLE ============
function toggleLidar3DFullscreen() {
  const container = document.querySelector('.light-cam-wide');
  if (container) {
    container.classList.toggle('lidar3d-fullscreen');
    setTimeout(resizeLidar3D, 100);
  }
}

// ============ COMPASS UPDATE ============
function updateCompass(heading, x, y, z) {
  window.compassState = { heading, x, y, z };

  // Update compass display in UI
  const compassEl = document.getElementById('compassHeading');
  if (compassEl) {
    compassEl.textContent = heading.toFixed(0);
  }

  // Update compass needle rotation
  const needleEl = document.getElementById('compassNeedle');
  if (needleEl) {
    needleEl.style.transform = `rotate(${heading}deg)`;
  }

  // Update cardinal direction
  const dirEl = document.getElementById('compassDir');
  if (dirEl) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(heading / 45) % 8;
    dirEl.textContent = dirs[idx];
  }
}

// ============ GPS UPDATE ============
function updateGps(valid, lat, lon, sats, lastLat, lastLon) {
  window.gpsState = { valid, lat, lon, sats, lastLat, lastLon };

  // Use last valid position if current is invalid
  const displayLat = (valid && lat !== 0) ? lat : lastLat;
  const displayLon = (valid && lon !== 0) ? lon : lastLon;

  // Update GPS display in UI
  const latEl = document.getElementById('gpsLat');
  const lonEl = document.getElementById('gpsLon');
  const satsEl = document.getElementById('gpsSats');
  const statusEl = document.getElementById('gpsStatus');

  if (latEl) latEl.textContent = displayLat.toFixed(6);
  if (lonEl) lonEl.textContent = displayLon.toFixed(6);
  if (satsEl) satsEl.textContent = sats;
  if (statusEl) {
    statusEl.textContent = valid ? 'FIX' : (lastLat !== 0 ? 'LAST' : 'NO FIX');
    statusEl.style.color = valid ? '#0f8' : (lastLat !== 0 ? '#fc0' : '#f44');
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', initLidar3D);
setTimeout(initLidar3D, 500);

// Export
window.lidar3dModule = {
  initLidar3D,
  updateLidar3D,
  updateUltrasonic3D,
  resizeLidar3D,
  toggleLidar3DFullscreen,
  getDistanceColor3D,
  // Mapping functions
  toggleMapping,
  saveCurrentMap,
  loadMap,
  getStoredMaps,
  // GPS/Compass functions
  updateCompass,
  updateGps
};
