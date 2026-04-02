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
let showSlamFloorPoints = false;  // Disabled - old data mixes with new and gets confusing

// Persistent wall accumulation - walls stay in world coordinates
let accumulatedWalls = [];
const MAX_ACCUMULATED_WALLS = 2000;
const WALL_GRID_SIZE = 0.25;  // 25cm grid - less cluttered map
let wallGrid = new Map();  // Grid-based deduplication
let showAccumulatedWalls = false;  // DISABLED - only show realtime LIDAR panels

// LIDAR fingerprinting for area recognition
let currentFingerprint = null;
let savedFingerprints = [];  // Array of {name, fingerprint, timestamp}
let lastFingerprintCheck = 0;
const FINGERPRINT_CHECK_INTERVAL = 2000;  // Check every 2 seconds
const FINGERPRINT_MATCH_THRESHOLD = 0.75;  // 75% match = recognized

// AUTO-SAVE: Automatically save map + fingerprint when we have enough points
let lastAutoSave = 0;
const AUTO_SAVE_INTERVAL = 60000;  // Auto-save every 60 seconds
const AUTO_SAVE_MIN_POINTS = 5000;  // Need at least 5k points to save
let autoSaveEnabled = true;
let lastAutoSavePosition = { x: 0, y: 0 };  // Track where we last saved
const AUTO_SAVE_MIN_DISTANCE = 200;  // Must move 2m from last save to create new fingerprint
let lidar3dUltrasonicCones = { FL: null, FR: null, RL: null, RR: null };
const SLAM_MAX_POINTS = 500000;  // Keep lots of points - build full room map
const SLAM_POINT_SPACING = 0.02;  // Denser points = cleaner wall lines
let lastLidarUpdate = 0;
const LIDAR_UPDATE_INTERVAL = 200;  // 5fps - reduces flashing and jitter from scan noise
let animFrameCount = 0;

// Occupancy grid visualization
let occupancyGridMesh = null;
let lastGridUpdate = 0;
const GRID_UPDATE_INTERVAL = 500;  // Update visualization every 500ms
let mappingEnabled = false;  // Disabled - occupancy grid is noisy
let showOccupancyGrid = false;  // Disabled

// Navigation path visualization
let navPathLine = null;
let navPathPoints = [];
let frontierMarkers = [];
let serverGridCells = null;  // Grid data from server-navigation.js
let lastServerGridTime = 0;

// Initialize odomState
window.odomState = window.odomState || { x: 0, y: 0, heading: 0, totalDistance: 0, trail: [{ x: 0, y: 0 }] };

// GPS and Compass state
window.gpsState = window.gpsState || { valid: false, lat: 0, lon: 0, sats: 0, lastLat: 0, lastLon: 0 };
window.compassState = window.compassState || { heading: 0, x: 0, y: 0, z: 0 };

// Compass visual elements
let compassRose = null;
let compassNeedle = null;

// Click-to-navigate
let navTargetMarker = null;
let navTargetActive = false;
let navRaycaster = null;
let navMouse = new THREE.Vector2();
let groundPlane = null;  // For raycasting clicks

// ============ GAUSSIAN SPLAT (SHARP) ============
let gaussianSplatCloud = null;
let gaussianSplatEnabled = false;  // DISABLED - removed

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
    lidar3dRobot.rotation.y = Math.PI;  // Front faces up screen
  }

  lidar3dWalls.forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    lidar3dScene.remove(m);
  });
  lidar3dWalls = [];

  // Clear accumulated walls
  accumulatedWalls.forEach(w => {
    if (w.geometry) w.geometry.dispose();
    if (w.material) w.material.dispose();
    if (lidar3dWorldContainer) lidar3dWorldContainer.remove(w);
  });
  accumulatedWalls = [];
  wallGrid.clear();

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
  // Dark matte background with slight blue tint - architectural visualization feel
  lidar3dScene.background = new THREE.Color(0x080c12);
  lidar3dScene.fog = new THREE.FogExp2(0x080c12, 0.035);  // Exponential fog for natural depth falloff

  const w = container.clientWidth;
  const h = container.clientHeight;
  lidar3dCamera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  // Start with a nice elevated isometric-ish view
  lidar3dCamera.position.set(0, 10, 0.01);  // Top-down birdseye by default (Roomba map view)
  lidar3dCamera.lookAt(0, 0, 0);

  lidar3dRenderer = new THREE.WebGLRenderer({
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    alpha: false
  });
  lidar3dRenderer.setSize(w, h);
  lidar3dRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  lidar3dRenderer.sortObjects = true;
  lidar3dRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lidar3dRenderer.toneMappingExposure = 1.0;
  lidar3dRenderer.shadowMap.enabled = true;
  lidar3dRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.insertBefore(lidar3dRenderer.domElement, container.firstChild);

  lidar3dControls = new THREE.OrbitControls(lidar3dCamera, lidar3dRenderer.domElement);
  lidar3dControls.enableDamping = true;
  lidar3dControls.dampingFactor = 0.08;
  // FULL 3D ROTATION - allow bird's eye and any viewing angle
  lidar3dControls.minPolarAngle = 0.1;  // Just above straight up
  lidar3dControls.maxPolarAngle = Math.PI - 0.1;  // Almost straight down allowed
  lidar3dControls.minDistance = 1;
  lidar3dControls.maxDistance = 20;
  lidar3dControls.enablePan = true;  // Allow panning
  lidar3dControls.panSpeed = 0.8;
  lidar3dControls.rotateSpeed = 0.8;
  lidar3dControls.zoomSpeed = 1.2;

  // Natural hemisphere light - sky blue above, dark ground below
  const hemiLight = new THREE.HemisphereLight(0x4488cc, 0x1a1a2e, 0.6);
  lidar3dScene.add(hemiLight);

  // Soft ambient for base illumination
  const ambientLight = new THREE.AmbientLight(0x303845, 0.3);
  lidar3dScene.add(ambientLight);

  // Main directional light with soft shadows
  const dirLight = new THREE.DirectionalLight(0xffeedd, 0.7);
  dirLight.position.set(8, 15, 6);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 30;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  dirLight.shadow.radius = 4;
  lidar3dScene.add(dirLight);

  // Cool fill light from opposite side
  const fillLight = new THREE.DirectionalLight(0x5577aa, 0.25);
  fillLight.position.set(-5, 8, -5);
  lidar3dScene.add(fillLight);

  // Subtle blue rim light for edge definition
  const rimLight = new THREE.DirectionalLight(0x2255aa, 0.2);
  rimLight.position.set(0, 2, -10);
  lidar3dScene.add(rimLight);

  lidar3dWorldContainer = new THREE.Group();
  lidar3dScene.add(lidar3dWorldContainer);

  // Ground - dark concrete-like surface with lighting response
  const groundSize = 50;
  const groundGeom = new THREE.PlaneGeometry(groundSize, groundSize);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0c1018,
    roughness: 0.95,
    metalness: 0.05,
    transparent: false
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.name = 'ground';
  ground.receiveShadow = true;
  lidar3dWorldContainer.add(ground);
  groundPlane = ground;

  // Ground grids removed - clean dark floor only

  // Distance rings around robot - thin elegant arcs
  for (let r = 1; r <= 6; r++) {
    const ringGeom = new THREE.RingGeometry(r - 0.015, r + 0.015, 96);
    const ringMat = new THREE.MeshBasicMaterial({
      color: r <= 2 ? 0x22aacc : 0x1a6688,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: Math.max(0.04, 0.2 - r * 0.025)
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.01;
    lidar3dScene.add(ring);
  }

  // Subtle crosshair
  const crossSize = 0.3;
  const crossMat = new THREE.LineBasicMaterial({ color: 0x33aacc, transparent: true, opacity: 0.5 });
  const crossGeom1 = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-crossSize, 0.01, 0), new THREE.Vector3(crossSize, 0.01, 0)
  ]);
  const crossGeom2 = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.01, -crossSize), new THREE.Vector3(0, 0.01, crossSize)
  ]);
  lidar3dScene.add(new THREE.Line(crossGeom1, crossMat));
  lidar3dScene.add(new THREE.Line(crossGeom2, crossMat));

  // Navigation target marker (pulsing ring)
  navRaycaster = new THREE.Raycaster();
  const navMarkerGeom = new THREE.RingGeometry(0.08, 0.15, 32);
  const navMarkerMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9
  });
  // Navigation marker - DISABLED to reduce clutter
  navTargetMarker = null;

  // Click-to-navigate handler
  container.addEventListener('click', onMapClick);
  container.addEventListener('dblclick', onMapDoubleClick);

  lidar3dRobot = createRobot3D();
  lidar3dRobot.rotation.y = Math.PI;  // Rotate 180° so front faces forward (up the screen)
  lidar3dScene.add(lidar3dRobot);

  // Trail line - DISABLED (odometry noise creates messy squiggles)
  lidar3dTrailGeom = new THREE.BufferGeometry();
  // const trailMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.6, linewidth: 2 });
  // lidar3dTrailLine = new THREE.Line(lidar3dTrailGeom, trailMat);
  // lidar3dWorldContainer.add(lidar3dTrailLine);

  // SLAM point cloud - persistent wall map that builds as robot moves
  lidar3dSlamCloud = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, opacity: 0.85, sizeAttenuation: true })
  );
  lidar3dWorldContainer.add(lidar3dSlamCloud);

  lidar3dInitialized = true;
  animateLidar3D();
}

// ============ CLICK-TO-NAVIGATE ============
function onMapClick(event) {
  // Only handle left-click on ground
  if (event.button !== 0) return;

  const container = document.getElementById('lidar3dContainer');
  const rect = container.getBoundingClientRect();

  // Calculate normalized device coordinates
  navMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  navMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  navRaycaster.setFromCamera(navMouse, lidar3dCamera);

  // Check intersection with ground plane
  const intersects = navRaycaster.intersectObject(groundPlane);

  if (intersects.length > 0) {
    const point = intersects[0].point;

    // Show target marker
    navTargetMarker.position.x = point.x;
    navTargetMarker.position.z = point.z;
    navTargetMarker.visible = true;
    navTargetActive = true;

    // Convert to robot world coordinates (meters to mm for server)
    const targetX = point.x * 1000;  // Convert to mm
    const targetY = point.z * 1000;  // Z in 3D = Y in 2D map

    console.log(`[NAV] Click target: (${targetX.toFixed(0)}, ${targetY.toFixed(0)}) mm`);

    // Send navigation target to server
    if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'nav_target',
        x: targetX,
        y: targetY,
        source: 'map_click'
      }));
    }
  }
}

function onMapDoubleClick(event) {
  // Double-click cancels navigation
  navTargetMarker.visible = false;
  navTargetActive = false;

  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'nav_cancel'
    }));
  }
  console.log('[NAV] Navigation cancelled');
}

// Update nav marker animation
function updateNavMarker() {
  if (navTargetMarker && navTargetActive) {
    // Pulse animation
    const pulse = Math.sin(Date.now() * 0.005) * 0.3 + 0.7;
    navTargetMarker.material.opacity = pulse;

    // Scale pulse
    const scale = 1 + Math.sin(Date.now() * 0.003) * 0.2;
    navTargetMarker.scale.set(scale, scale, 1);
  }
}

// Check if robot reached target
function checkNavCompletion() {
  if (!navTargetActive || !navTargetMarker || !window.odomState) return;

  const robotX = window.odomState.x / 1000;  // mm to meters
  const robotY = window.odomState.y / 1000;

  const targetX = navTargetMarker.position.x;
  const targetZ = navTargetMarker.position.z;

  const dist = Math.sqrt(
    Math.pow(robotX - targetX, 2) +
    Math.pow(robotY - targetZ, 2)
  );

  // Within 15cm = arrived
  if (dist < 0.15) {
    navTargetMarker.visible = false;
    navTargetActive = false;
    console.log('[NAV] Arrived at target!');
  }
}

// ============ ROBOT MODEL ============
// Accurate model based on actual robot sketch: 2020 aluminum extrusion frame, LIDAR tower at rear-right,
// rear PTZ camera on left arm, front camera on 2nd story facing forward
function createRobot3D() {
  const group = new THREE.Group();

  // PBR Materials for realistic robot model
  const aluminumMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.35, metalness: 0.85 });
  const darkAluminumMat = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.5, metalness: 0.7 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9, metalness: 0.05 });
  const greenLedMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.3, metalness: 0.0 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8, metalness: 0.1 });

  // Dimensions (in meters) - rectangular frame based on sketch
  const frameWidth = 0.32;   // 32cm wide
  const frameDepth = 0.40;   // 40cm deep (front-to-back)
  const frameHeight = 0.25;  // 25cm tall main frame (lower section)
  const wheelRadius = 0.10;  // 8-inch wheels = ~20cm diameter
  const wheelWidth = 0.06;   // 6cm wide wheels
  const tubeSize = 0.020;    // 20mm 2020 aluminum extrusion
  const wheelOffset = 0.08;  // Wheels extend beyond frame
  const midShelfHeight = 0.12; // Mid-level shelf

  // Ground clearance - wheels touch ground
  const groundClearance = wheelRadius * 0.5;

  // ===== MAIN CHASSIS FRAME (lower section) =====
  // Vertical corner posts for main chassis
  const chassisPostGeom = new THREE.BoxGeometry(tubeSize, frameHeight, tubeSize);
  const chassisCorners = [
    [-frameWidth/2 + tubeSize/2, -frameDepth/2 + tubeSize/2],  // Front-left
    [frameWidth/2 - tubeSize/2, -frameDepth/2 + tubeSize/2],   // Front-right
    [-frameWidth/2 + tubeSize/2, frameDepth/2 - tubeSize/2],   // Rear-left
    [frameWidth/2 - tubeSize/2, frameDepth/2 - tubeSize/2]     // Rear-right
  ];
  chassisCorners.forEach(([x, z]) => {
    const post = new THREE.Mesh(chassisPostGeom, aluminumMat);
    post.position.set(x, groundClearance + frameHeight/2, z);
    group.add(post);
  });

  // Horizontal rails for chassis
  const railXGeom = new THREE.BoxGeometry(frameWidth - tubeSize*2, tubeSize, tubeSize);
  const railZGeom = new THREE.BoxGeometry(tubeSize, tubeSize, frameDepth - tubeSize*2);

  // Bottom frame rails
  [[-frameDepth/2 + tubeSize/2], [frameDepth/2 - tubeSize/2]].forEach(([z]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, groundClearance + tubeSize/2, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2], [frameWidth/2 - tubeSize/2]].forEach(([x]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, groundClearance + tubeSize/2, 0);
    group.add(rail);
  });

  // Mid-level shelf rails
  [[-frameDepth/2 + tubeSize/2], [frameDepth/2 - tubeSize/2]].forEach(([z]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, groundClearance + midShelfHeight, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2], [frameWidth/2 - tubeSize/2]].forEach(([x]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, groundClearance + midShelfHeight, 0);
    group.add(rail);
  });

  // Top frame rails (chassis top)
  [[-frameDepth/2 + tubeSize/2], [frameDepth/2 - tubeSize/2]].forEach(([z]) => {
    const rail = new THREE.Mesh(railXGeom, aluminumMat);
    rail.position.set(0, groundClearance + frameHeight - tubeSize/2, z);
    group.add(rail);
  });
  [[-frameWidth/2 + tubeSize/2], [frameWidth/2 - tubeSize/2]].forEach(([x]) => {
    const rail = new THREE.Mesh(railZGeom, aluminumMat);
    rail.position.set(x, groundClearance + frameHeight - tubeSize/2, 0);
    group.add(rail);
  });

  // ===== LIDAR TOWER (rectangular frame at FRONT-MIDDLE) =====
  // 4-post tower rising from front-middle of main chassis (per sketch)
  const towerHeight = 0.12;  // 12cm tall tower above chassis (lowered)
  const towerWidth = 0.20;   // 20cm wide
  const towerDepth = 0.18;   // 18cm deep
  const towerBaseY = groundClearance;
  const towerX = 0;  // Center (front-middle)
  const towerZ = -frameDepth/2 + towerDepth/2 + 0.02;  // FRONT side (negative Z is front)

  // Four corner posts of LIDAR tower (full height from ground)
  const fullTowerHeight = frameHeight + towerHeight;
  const towerPostGeom = new THREE.BoxGeometry(tubeSize, fullTowerHeight, tubeSize);
  const towerCorners = [
    [-towerWidth/2 + tubeSize/2, -towerDepth/2 + tubeSize/2],  // Front-left of tower
    [towerWidth/2 - tubeSize/2, -towerDepth/2 + tubeSize/2],   // Front-right of tower
    [-towerWidth/2 + tubeSize/2, towerDepth/2 - tubeSize/2],   // Rear-left of tower
    [towerWidth/2 - tubeSize/2, towerDepth/2 - tubeSize/2]     // Rear-right of tower
  ];
  towerCorners.forEach(([dx, dz]) => {
    const post = new THREE.Mesh(towerPostGeom, aluminumMat);
    post.position.set(towerX + dx, towerBaseY + fullTowerHeight/2, towerZ + dz);
    group.add(post);
  });

  // Tower horizontal braces - multiple levels
  const towerRailXGeom = new THREE.BoxGeometry(towerWidth - tubeSize*2, tubeSize, tubeSize);
  const towerRailZGeom = new THREE.BoxGeometry(tubeSize, tubeSize, towerDepth - tubeSize*2);

  // Tower braces at bottom, middle, and top
  const towerBraceLevels = [
    towerBaseY + tubeSize/2,                    // Bottom
    towerBaseY + frameHeight,                   // At chassis top level
    towerBaseY + fullTowerHeight * 0.65,        // Middle-upper
    towerBaseY + fullTowerHeight - tubeSize/2   // Top
  ];
  towerBraceLevels.forEach(y => {
    // Front and rear X braces
    [[-towerDepth/2 + tubeSize/2], [towerDepth/2 - tubeSize/2]].forEach(([dz]) => {
      const brace = new THREE.Mesh(towerRailXGeom, aluminumMat);
      brace.position.set(towerX, y, towerZ + dz);
      group.add(brace);
    });
    // Left and right Z braces
    [[-towerWidth/2 + tubeSize/2], [towerWidth/2 - tubeSize/2]].forEach(([dx]) => {
      const brace = new THREE.Mesh(towerRailZGeom, aluminumMat);
      brace.position.set(towerX + dx, y, towerZ);
      group.add(brace);
    });
  });

  // Green LED strip on front-right post of tower (facing forward)
  const ledStripGeom = new THREE.BoxGeometry(0.012, fullTowerHeight * 0.5, 0.012);
  const ledStrip = new THREE.Mesh(ledStripGeom, greenLedMat);
  ledStrip.position.set(towerX + towerWidth/2 - tubeSize/2 - 0.01, towerBaseY + fullTowerHeight * 0.55, towerZ - towerDepth/2 + tubeSize/2 + 0.01);
  group.add(ledStrip);

  // Second LED strip on rear-right post
  const ledStrip2 = new THREE.Mesh(ledStripGeom, greenLedMat);
  ledStrip2.position.set(towerX + towerWidth/2 - tubeSize/2 - 0.01, towerBaseY + fullTowerHeight * 0.55, towerZ + towerDepth/2 - tubeSize/2 - 0.01);
  group.add(ledStrip2);

  // ===== LIDAR SENSOR (black/grey cylinder on top of tower) =====
  const lidarGeom = new THREE.CylinderGeometry(0.05, 0.05, 0.07, 20);
  const lidarMat = new THREE.MeshPhongMaterial({ color: 0x333333, specular: 0x222222 });
  const lidar = new THREE.Mesh(lidarGeom, lidarMat);
  lidar.position.set(towerX, towerBaseY + fullTowerHeight + 0.045, towerZ);
  group.add(lidar);

  // LIDAR spinning indicator ring
  const lidarRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.05, 0.006, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x00ff88 })
  );
  lidarRing.rotation.x = Math.PI / 2;
  lidarRing.position.set(towerX, towerBaseY + fullTowerHeight + 0.085, towerZ);
  group.add(lidarRing);

  // ===== REAR CAMERA (white PTZ on LEFT side, on horizontal arm at REAR) =====
  const rearCamArmLength = 0.15;  // Arm extends 15cm from frame
  const rearCamX = -frameWidth/2 - rearCamArmLength/2;  // Left side
  const rearCamZ = frameDepth/2 - 0.08;  // At REAR of robot (positive Z is rear)
  const rearCamY = groundClearance + frameHeight + 0.10;  // Above chassis

  // Vertical pole from chassis top (attached to rear-left corner)
  const rearPoleGeom = new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8);
  const rearPole = new THREE.Mesh(rearPoleGeom, aluminumMat);
  rearPole.position.set(-frameWidth/2 + tubeSize, groundClearance + frameHeight + 0.06, rearCamZ);
  group.add(rearPole);

  // Horizontal arm extending outward to the LEFT
  const rearArmGeom = new THREE.BoxGeometry(rearCamArmLength, tubeSize * 0.8, tubeSize * 0.8);
  const rearArm = new THREE.Mesh(rearArmGeom, aluminumMat);
  rearArm.position.set(-frameWidth/2 - rearCamArmLength/2 + tubeSize, rearCamY, rearCamZ);
  group.add(rearArm);

  // PTZ camera base (white cylinder)
  const rearCamBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 0.025, 16),
    whiteMat
  );
  rearCamBase.position.set(rearCamX - 0.02, rearCamY - 0.01, rearCamZ);
  group.add(rearCamBase);

  // PTZ camera dome (hemisphere pointing down)
  const rearCamDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    whiteMat
  );
  rearCamDome.position.set(rearCamX - 0.02, rearCamY - 0.025, rearCamZ);
  rearCamDome.rotation.x = Math.PI;  // Flip dome to point down
  group.add(rearCamDome);

  // Camera lens
  const lensMat = new THREE.MeshPhongMaterial({ color: 0x111122, specular: 0x4444ff, shininess: 100 });
  const rearLens = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 12, 8),
    lensMat
  );
  rearLens.position.set(rearCamX - 0.02, rearCamY - 0.055, rearCamZ);
  group.add(rearLens);

  // ===== FRONT CAMERA (mounted UNDER the LIDAR tower, on 2nd story, facing FORWARD) =====
  // Camera is mounted inside the LIDAR tower frame, facing forward (negative Z)
  const frontCamY = groundClearance + frameHeight * 0.6;  // On 2nd story level inside tower
  const frontCamZ = towerZ - towerDepth/2 - 0.01;  // At front face of tower

  // Camera mounting bracket attached to tower front rail
  const frontBracketGeom = new THREE.BoxGeometry(0.05, 0.03, tubeSize * 0.8);
  const frontBracket = new THREE.Mesh(frontBracketGeom, darkAluminumMat);
  frontBracket.position.set(towerX, frontCamY, frontCamZ + 0.01);
  group.add(frontBracket);

  // PTZ camera base (facing forward)
  const frontCamBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.040, 0.022, 16),
    whiteMat
  );
  frontCamBase.rotation.x = Math.PI / 2;  // Rotate to face forward
  frontCamBase.position.set(towerX, frontCamY, frontCamZ - 0.02);
  group.add(frontCamBase);

  // Front camera dome (facing forward)
  const frontCamDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    whiteMat
  );
  frontCamDome.rotation.x = -Math.PI / 2;  // Point forward (negative Z)
  frontCamDome.position.set(towerX, frontCamY, frontCamZ - 0.04);
  group.add(frontCamDome);

  // Front camera lens
  const frontLens = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 12, 8),
    lensMat
  );
  frontLens.position.set(towerX, frontCamY, frontCamZ - 0.065);
  group.add(frontLens);

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

  // ===== DIRECTION INDICATOR (points to BACK - GPS arrow faces rear) =====
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
  arrow.rotation.z = Math.PI;  // Flip 180 degrees - arrow points to BACK
  arrow.position.set(0, groundClearance + 0.01, frameDepth/2 + 0.05);  // At the back
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

// Circular point texture for smooth LIDAR rendering
let lidarPointTexture = null;
function getLidarPointTexture() {
  if (lidarPointTexture) return lidarPointTexture;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Gaussian-like soft circular point with bright core
  const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.15, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.25)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  lidarPointTexture = new THREE.CanvasTexture(canvas);
  lidarPointTexture.needsUpdate = true;
  return lidarPointTexture;
}

// Modern cyan-to-magenta gradient for distance coloring
function getDistanceColor3D(dist) {
  // Warm-to-cool: close = red/orange, mid = yellow/green, far = cyan/blue
  const minDist = 200, maxDist = 5000;
  const t = Math.max(0, Math.min(1, (dist - minDist) / (maxDist - minDist)));

  const color = new THREE.Color();
  if (t < 0.25) {
    // Very close: red -> orange
    const t2 = t / 0.25;
    color.setRGB(1.0, t2 * 0.5, 0.0);
  } else if (t < 0.5) {
    // Close-mid: orange -> yellow
    const t2 = (t - 0.25) / 0.25;
    color.setRGB(1.0, 0.5 + t2 * 0.5, 0.0);
  } else if (t < 0.75) {
    // Mid-far: yellow -> green/cyan
    const t2 = (t - 0.5) / 0.25;
    color.setRGB(1.0 - t2 * 0.8, 1.0, t2 * 0.5);
  } else {
    // Far: cyan -> blue
    const t2 = (t - 0.75) / 0.25;
    color.setRGB(0.2 - t2 * 0.1, 1.0 - t2 * 0.5, 0.5 + t2 * 0.5);
  }
  return color;
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

  // Clean up old walls
  lidar3dWalls.forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    lidar3dScene.remove(m);
  });
  lidar3dWalls = [];
  if (lidar3dPointCloud) {
    lidar3dPointCloud.geometry.dispose();
    lidar3dPointCloud.material.dispose();
    lidar3dScene.remove(lidar3dPointCloud);
    lidar3dPointCloud = null;
  }

  points.sort((a, b) => a[0] - b[0]);

  // === STEP 1: Calculate all LIDAR hit positions ===
  const positions = [], colors = [];
  for (const [angle, dist] of points) {
    if (dist < 100 || dist > 8000) continue;  // Skip invalid
    const rad = (angle - 90) * Math.PI / 180;
    const x = (dist / 1000) * Math.cos(rad);
    const z = (dist / 1000) * Math.sin(rad);
    positions.push(x, 0.15, z);
    // Sparkling white dots
    colors.push(1.0, 1.0, 1.0);
  }

  // === STEP 2: Tiny sparkly dots at every LIDAR hit ===
  if (positions.length > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    lidar3dPointCloud = new THREE.Points(geom, new THREE.PointsMaterial({
      size: 0.08,
      map: getLidarPointTexture(),
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1.0,
      alphaTest: 0.02,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    lidar3dScene.add(lidar3dPointCloud);
  }

  // === STEP 3: Distance-colored sparkly dots above the white ones ===
  const colorPositions = [];
  const colorColors = [];

  for (const [angle, dist] of points) {
    if (dist < 100 || dist > 8000) continue;
    const rad = (angle - 90) * Math.PI / 180;
    const x = (dist / 1000) * Math.cos(rad);
    const z = (dist / 1000) * Math.sin(rad);
    colorPositions.push(x, 0.25, z);  // Above the white dots
    const c = getDistanceColor3D(dist);
    colorColors.push(c.r, c.g, c.b);
  }

  if (colorPositions.length > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(colorPositions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colorColors, 3));
    const colorCloud = new THREE.Points(geom, new THREE.PointsMaterial({
      size: 0.08,
      map: getLidarPointTexture(),
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.02,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    lidar3dScene.add(colorCloud);
    lidar3dWalls.push(colorCloud);
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
  // Map points use: (world_x, height, -world_y) for Three.js coords
  // To center robot at origin, we offset container by inverse of robot position
  // Container X = -robotX (negated because map points use +x for +x)
  // Container Z = +robotY (positive because map points use -y for +z, so we need +y to cancel)
  if (lidar3dWorldContainer && window.odomState) {
    const gridX = -window.odomState.x / 1000;  // Robot moves right, map slides left
    const gridZ = window.odomState.y / 1000;   // Robot moves forward (-y in Three.js), map slides back (+z)
    lidar3dWorldContainer.position.x = gridX;
    lidar3dWorldContainer.position.z = gridZ;
    // Rotate world with robot heading (compass has 2° noise filter now)
    lidar3dWorldContainer.rotation.y = -window.odomState.heading;
  }

  // Robot stays at origin - smooth rotation from compass (with 2° noise filter)
  if (lidar3dRobot) {
    lidar3dRobot.position.set(0, 0, 0);
    // Smooth interpolation to target heading
    const targetHeading = (window.odomState && window.odomState.heading) || Math.PI;
    const currentHeading = lidar3dRobot.rotation.y;
    // Lerp 30% toward target each frame for smooth rotation
    lidar3dRobot.rotation.y = currentHeading + (targetHeading - currentHeading) * 0.3;
  }

  // Keep OrbitControls centered on robot (at origin)
  lidar3dControls.target.set(0, 0, 0);
  lidar3dControls.update();

  // Update occupancy grid visualization
  updateOccupancyGridVisualization();

  // Update navigation marker
  updateNavMarker();
  checkNavCompletion();

  lidar3dRenderer.render(lidar3dScene, lidar3dCamera);
}

// ============ CAMERA PRESETS ============
const cameraPresets = {
  birdseye: { pos: [0, 12, 0.1], target: [0, 0, 0] },      // Top-down view
  isometric: { pos: [5, 7, 5], target: [0, 0, 0] },        // Classic 3D view
  front: { pos: [0, 3, 8], target: [0, 0.5, 0] },          // Front view
  side: { pos: [10, 3, 0], target: [0, 0.5, 0] },          // Side view
  low: { pos: [3, 1.5, 3], target: [0, 0.3, 0] },          // Low angle dramatic
  wide: { pos: [8, 10, 8], target: [0, 0, 0] }             // Wide establishing shot
};

function setCameraPreset(presetName, animate = true) {
  const preset = cameraPresets[presetName];
  if (!preset || !lidar3dCamera || !lidar3dControls) return;

  if (animate) {
    // Smooth animated transition
    const startPos = lidar3dCamera.position.clone();
    const endPos = new THREE.Vector3(...preset.pos);
    const startTarget = lidar3dControls.target.clone();
    const endTarget = new THREE.Vector3(...preset.target);
    let t = 0;

    function animateCamera() {
      t += 0.04;
      if (t >= 1) {
        lidar3dCamera.position.copy(endPos);
        lidar3dControls.target.copy(endTarget);
        return;
      }
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      lidar3dCamera.position.lerpVectors(startPos, endPos, ease);
      lidar3dControls.target.lerpVectors(startTarget, endTarget, ease);
      requestAnimationFrame(animateCamera);
    }
    animateCamera();
  } else {
    lidar3dCamera.position.set(...preset.pos);
    lidar3dControls.target.set(...preset.target);
  }
  console.log(`[CAM] Preset: ${presetName}`);
}

// Keyboard shortcuts for camera presets
document.addEventListener('keydown', (e) => {
  // Only respond if not typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case '1': setCameraPreset('birdseye'); break;   // Bird's eye (top-down)
    case '2': setCameraPreset('isometric'); break;  // Isometric 3D
    case '3': setCameraPreset('front'); break;      // Front view
    case '4': setCameraPreset('side'); break;       // Side view
    case '5': setCameraPreset('low'); break;        // Low dramatic angle
    case '6': setCameraPreset('wide'); break;       // Wide shot
  }
});

// Expose for UI buttons
window.setCameraPreset = setCameraPreset;

// ============ JETSON SLAM MAP VISUALIZATION ============
// Receives map cells from Jetson and renders them on the 3D view
let slamMapMesh = null;
let slamMapVisible = false;  // DISABLED - clutter

function updateMapCells(data) {
  if (!lidar3dScene || !lidar3dWorldContainer) return;

  // Remove old mesh
  if (slamMapMesh) {
    if (slamMapMesh.geometry) slamMapMesh.geometry.dispose();
    if (slamMapMesh.material) slamMapMesh.material.dispose();
    lidar3dWorldContainer.remove(slamMapMesh);
    slamMapMesh = null;
  }

  if (!slamMapVisible) return;

  const staticCells = data.static || [];
  const dynamicCells = data.dynamic || [];
  const freeCells = data.free || [];
  const resolution = data.resolution || 0.05;  // 5cm default

  const totalCells = staticCells.length + dynamicCells.length + freeCells.length;
  if (totalCells === 0) return;

  const positions = [];
  const colors = [];
  const cellSize = resolution;

  // Helper to add a cell quad
  function addCell(x, z, r, g, b, yHeight) {
    // Two triangles for a quad on the ground
    const y = yHeight;
    positions.push(
      x - cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z + cellSize/2,
      x - cellSize/2, y, z - cellSize/2,
      x + cellSize/2, y, z + cellSize/2,
      x - cellSize/2, y, z + cellSize/2
    );
    for (let i = 0; i < 6; i++) {
      colors.push(r, g, b);
    }
  }

  // Static cells - dark gray/black walls (floor tiles)
  for (const cell of staticCells) {
    const x = cell[0];
    const z = -cell[1];  // Flip for Three.js
    addCell(x, z, 0.15, 0.15, 0.2, 0.01);
  }

  // Dynamic cells - orange/red (temporary obstacles)
  for (const cell of dynamicCells) {
    const x = cell[0];
    const z = -cell[1];
    addCell(x, z, 0.8, 0.3, 0.1, 0.02);
  }

  // Free cells - green (confirmed free space)
  for (const cell of freeCells) {
    const x = cell[0];
    const z = -cell[1];
    addCell(x, z, 0.1, 0.4, 0.15, 0.005);
  }

  if (positions.length === 0) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  slamMapMesh = new THREE.Mesh(geometry, material);
  lidar3dWorldContainer.add(slamMapMesh);
}

function toggleSlamMapVisible() {
  slamMapVisible = !slamMapVisible;
  if (!slamMapVisible && slamMapMesh) {
    lidar3dWorldContainer.remove(slamMapMesh);
    slamMapMesh = null;
  }
  return slamMapVisible;
}

// ============ OCCUPANCY GRID VISUALIZATION ============
function updateOccupancyGridVisualization() {
  if (!lidar3dScene || !lidar3dWorldContainer || !showOccupancyGrid) return;

  const now = Date.now();
  if (now - lastGridUpdate < GRID_UPDATE_INTERVAL) return;
  lastGridUpdate = now;

  // Remove old meshes
  if (occupancyGridMesh) {
    if (occupancyGridMesh.geometry) occupancyGridMesh.geometry.dispose();
    if (occupancyGridMesh.material) occupancyGridMesh.material.dispose();
    lidar3dWorldContainer.remove(occupancyGridMesh);
    occupancyGridMesh = null;
  }
  if (window._occWallMesh) {
    if (window._occWallMesh.geometry) window._occWallMesh.geometry.dispose();
    if (window._occWallMesh.material) window._occWallMesh.material.dispose();
    lidar3dWorldContainer.remove(window._occWallMesh);
    window._occWallMesh = null;
  }

  // Use server grid data if available, otherwise fall back to client-side grid
  let cells = [];
  let cellSizeM = 0.10;

  if (serverGridCells && serverGridCells.length > 0) {
    cells = serverGridCells;
    cellSizeM = (cells._cellSize || 100) / 1000;  // mm to m
  } else if (window.OccupancyGrid) {
    cells = window.OccupancyGrid.getAllCells();
    cellSizeM = window.OccupancyGrid.cellSize;
  }

  if (cells.length === 0) return;

  const floorPositions = [];
  const floorColors = [];
  const wallPositions = [];
  const wallColors = [];

  // Aggressive filtering — Roomba-style clean map
  const MIN_WALL_VISITS = 10;      // Wall must be hit 10+ times
  const MIN_WALL_CONFIDENCE = 0.9; // Very high confidence only
  const MIN_FREE_CONFIDENCE = 0.6;

  for (const cell of cells) {
    const isServer = cell.s !== undefined;
    const cellState = isServer ? cell.s : cell.state;
    const confidence = isServer ? (cell.c || 0.5) : (cell.confidence || 0.5);
    const visits = cell.visits || 1;
    const worldX = isServer ? cell.x / 1000 : cell.x;
    const worldY = isServer ? cell.y / 1000 : cell.y;

    const x = worldX;
    const z = -worldY;
    const hs = cellSizeM / 2;

    if (cellState === 1) {
      // FREE — bright white floor (Roomba-style)
      if (confidence < MIN_FREE_CONFIDENCE) continue;
      const y = 0.005;

      floorPositions.push(
        x - hs, y, z - hs, x + hs, y, z - hs, x + hs, y, z + hs,
        x - hs, y, z - hs, x + hs, y, z + hs, x - hs, y, z + hs
      );
      for (let i = 0; i < 6; i++) floorColors.push(0.85, 0.9, 0.95);

    } else if (cellState === 2) {
      // WALL — flat dark marker, only if very confident
      if (confidence < MIN_WALL_CONFIDENCE) continue;
      if (!isServer && visits < MIN_WALL_VISITS) continue;

      const y = 0.02;

      wallPositions.push(
        x - hs, y, z - hs, x + hs, y, z - hs, x + hs, y, z + hs,
        x - hs, y, z - hs, x + hs, y, z + hs, x - hs, y, z + hs
      );
      for (let i = 0; i < 6; i++) wallColors.push(0.15, 0.15, 0.2);
    } else {
      continue;
    }
  }

  // Floor mesh — bright solid
  if (floorPositions.length > 0) {
    const floorGeom = new THREE.BufferGeometry();
    floorGeom.setAttribute('position', new THREE.Float32BufferAttribute(floorPositions, 3));
    floorGeom.setAttribute('color', new THREE.Float32BufferAttribute(floorColors, 3));

    const floorMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    occupancyGridMesh = new THREE.Mesh(floorGeom, floorMat);
    lidar3dWorldContainer.add(occupancyGridMesh);
  }

  // Wall mesh — flat dark lines on floor
  if (wallPositions.length > 0) {
    const wallGeom = new THREE.BufferGeometry();
    wallGeom.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    wallGeom.setAttribute('color', new THREE.Float32BufferAttribute(wallColors, 3));

    const wallMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: false,
      side: THREE.DoubleSide
    });
    window._occWallMesh = new THREE.Mesh(wallGeom, wallMat);
    lidar3dWorldContainer.add(window._occWallMesh);
  }

  // Update stats display
  const statsEl = document.getElementById('mapStats');
  if (statsEl) {
    const stats = serverGridCells
      ? serverGridCells._stats
      : (window.OccupancyGrid ? window.OccupancyGrid.getStats() : null);
    if (stats) {
      const free = stats.freeCells || 0;
      const occ = stats.occupiedCells || 0;
      const area = ((free + occ) * cellSizeM * cellSizeM).toFixed(1);
      statsEl.textContent = `Map: ${free} free | ${occ} blocked | ${area} m²`;
    }
  }
}

// ============ NAV PATH VISUALIZATION ============
function updateNavPath(pathData) {
  // Remove old path line
  if (navPathLine) {
    if (navPathLine.geometry) navPathLine.geometry.dispose();
    if (navPathLine.material) navPathLine.material.dispose();
    lidar3dWorldContainer.remove(navPathLine);
    navPathLine = null;
  }

  if (!pathData || !pathData.path || pathData.path.length < 2) return;

  const points = [];
  for (const wp of pathData.path) {
    // Path coords are in mm, convert to meters for Three.js
    points.push(new THREE.Vector3(wp.x / 1000, 0.15, -wp.y / 1000));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: 0x00ffff,  // Cyan
    linewidth: 3,
    transparent: true,
    opacity: 0.9
  });

  navPathLine = new THREE.Line(geometry, material);
  lidar3dWorldContainer.add(navPathLine);

  console.log(`[NAV-VIZ] Showing path with ${pathData.path.length} waypoints`);
}

// ============ FRONTIER VISUALIZATION ============
function updateFrontiers(data) {
  // Remove old markers
  for (const marker of frontierMarkers) {
    if (marker.geometry) marker.geometry.dispose();
    if (marker.material) marker.material.dispose();
    lidar3dWorldContainer.remove(marker);
  }
  frontierMarkers = [];

  if (!data || !data.frontiers) return;

  for (const f of data.frontiers) {
    const isTarget = data.target && Math.abs(f.x - data.target.x) < 100 && Math.abs(f.y - data.target.y) < 100;

    // Diamond marker for each frontier
    const size = Math.min(0.3, Math.max(0.1, f.size * 0.02));
    const geom = new THREE.SphereGeometry(size, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: isTarget ? 0xffff00 : 0xff8800,  // Yellow if target, orange otherwise
      transparent: true,
      opacity: 0.7
    });
    const marker = new THREE.Mesh(geom, mat);
    marker.position.set(f.x / 1000, 0.3, -f.y / 1000);
    lidar3dWorldContainer.add(marker);
    frontierMarkers.push(marker);
  }

  console.log(`[FRONTIER-VIZ] Showing ${data.frontiers.length} frontiers`);
}

// Handle server grid updates
function handleGridUpdate(data) {
  if (!data || !data.cells) return;
  serverGridCells = data.cells;
  serverGridCells._stats = data.stats;
  serverGridCells._cellSize = data.cellSize;
  lastServerGridTime = Date.now();
}

function toggleMapping(enabled) {
  mappingEnabled = enabled;
  console.log('[MAP] Mapping', enabled ? 'enabled' : 'disabled');
}

// ============ LIDAR FINGERPRINTING ============
// Creates a fingerprint from LIDAR scan for area recognition
function createFingerprint(points) {
  if (!points || points.length < 50) return null;

  // Create distance histogram at fixed angle bins (every 10 degrees)
  const bins = new Array(36).fill(0);  // 36 bins for 360 degrees
  const counts = new Array(36).fill(0);

  for (const [angle, dist] of points) {
    if (dist > 100 && dist < 8000) {
      const binIndex = Math.floor(angle / 10) % 36;
      bins[binIndex] += dist;
      counts[binIndex]++;
    }
  }

  // Average distance per bin
  for (let i = 0; i < 36; i++) {
    bins[i] = counts[i] > 0 ? Math.round(bins[i] / counts[i]) : 0;
  }

  return bins;
}

// Compare two fingerprints, returns similarity 0-1
function compareFingerprints(fp1, fp2) {
  if (!fp1 || !fp2 || fp1.length !== fp2.length) return 0;

  let matches = 0;
  let total = 0;

  for (let i = 0; i < fp1.length; i++) {
    if (fp1[i] > 0 && fp2[i] > 0) {
      total++;
      const diff = Math.abs(fp1[i] - fp2[i]);
      // Within 500mm = match
      if (diff < 500) matches++;
    }
  }

  return total > 0 ? matches / total : 0;
}

// Check current scan against saved fingerprints
function checkForRecognizedArea(points) {
  const now = Date.now();
  if (now - lastFingerprintCheck < FINGERPRINT_CHECK_INTERVAL) return;
  lastFingerprintCheck = now;

  currentFingerprint = createFingerprint(points);
  if (!currentFingerprint) return;

  // Load saved fingerprints if not loaded
  if (savedFingerprints.length === 0) {
    loadSavedFingerprints();
  }

  // Compare against all saved fingerprints
  let bestMatch = { name: null, score: 0 };
  for (const saved of savedFingerprints) {
    const score = compareFingerprints(currentFingerprint, saved.fingerprint);
    if (score > bestMatch.score) {
      bestMatch = { name: saved.name, score };
    }
  }

  // If good match found, load that map from server
  if (bestMatch.score >= FINGERPRINT_MATCH_THRESHOLD && bestMatch.name) {
    console.log(`[RECOGNIZE] Area recognized: ${bestMatch.name} (${Math.round(bestMatch.score * 100)}% match)`);

    // Request 3D map from server
    if (window.robotWs && window.robotWs.readyState === WebSocket.OPEN) {
      window.robotWs.send(JSON.stringify({
        type: 'load_3d_map',
        name: bestMatch.name
      }));
    }

    // Show notification
    showRecognitionNotice(bestMatch.name, bestMatch.score);
  }
}

function showRecognitionNotice(name, score) {
  // Create temporary notification
  let notice = document.getElementById('areaRecognitionNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'areaRecognitionNotice';
    notice.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#2a5;color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;font-weight:bold;';
    document.body.appendChild(notice);
  }
  notice.textContent = `📍 Recognized: ${name} (${Math.round(score * 100)}%)`;
  notice.style.display = 'block';
  setTimeout(() => { notice.style.display = 'none'; }, 3000);
}

function loadSavedFingerprints() {
  // Fingerprints are now loaded from server via WebSocket
  // This is called when we receive 'saved_fingerprints' message
  console.log(`[FINGERPRINT] ${savedFingerprints.length} fingerprints available from server`);
}

// Handle fingerprints received from server
function handleSavedFingerprints(fingerprints) {
  savedFingerprints = fingerprints || [];
  console.log(`[FINGERPRINT] Loaded ${savedFingerprints.length} fingerprints from server`);
}

// Handle loaded 3D map from server (when area recognized)
function handleLoaded3DMap(name, mapData) {
  if (!mapData || !mapData.points) {
    console.log(`[3D MAP] No map data for ${name}`);
    return;
  }

  console.log(`[3D MAP] Loading saved map: ${name} (${mapData.points.length} points)`);

  // Clear current SLAM points and add saved ones
  lidar3dSlamPoints = [];

  // Add points from saved map
  for (const pt of mapData.points) {
    lidar3dSlamPoints.push({
      x: pt.x || 0,
      y: pt.y || 0,
      z: pt.z || 0,
      r: pt.r || 128,
      g: pt.g || 128,
      b: pt.b || 128
    });
  }

  console.log(`[3D MAP] Loaded ${lidar3dSlamPoints.length} points from saved map`);

  // Show notification
  showRecognitionNotice(name, 1.0);
}

// AUTO-SAVE: Automatically save fingerprint when we have good data
function autoSaveFingerprint(points) {
  if (!autoSaveEnabled) return;
  if (!window.robotWs || window.robotWs.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  if (now - lastAutoSave < AUTO_SAVE_INTERVAL) return;

  // Check if we have enough points
  const totalPoints = lidar3dSlamPoints.length;
  if (totalPoints < AUTO_SAVE_MIN_POINTS) return;

  // Get current robot position
  const odom = window.odomState || { x: 0, y: 0 };
  const robotX = odom.x || 0;
  const robotY = odom.y || 0;

  // Check if we've moved enough from last save position
  const dx = robotX - lastAutoSavePosition.x;
  const dy = robotY - lastAutoSavePosition.y;
  const distFromLastSave = Math.sqrt(dx * dx + dy * dy);

  // Only create NEW fingerprint if moved enough, otherwise update existing
  const isNewArea = distFromLastSave >= AUTO_SAVE_MIN_DISTANCE;

  // Create fingerprint from current scan
  const fingerprint = createFingerprint(points);
  if (!fingerprint) return;

  // Generate area name based on position
  const areaName = isNewArea
    ? `area_${Math.round(robotX / 100)}_${Math.round(robotY / 100)}_${Date.now()}`
    : findClosestSavedArea(robotX, robotY) || `area_${Math.round(robotX / 100)}_${Math.round(robotY / 100)}`;

  // Save fingerprint to SERVER (persistent storage)
  const fpData = {
    name: areaName,
    fingerprint: fingerprint,
    position: { x: robotX, y: robotY },
    pointCount: totalPoints,
    timestamp: Date.now()
  };

  // Send fingerprint to server for persistent storage
  window.robotWs.send(JSON.stringify({
    type: 'save_fingerprint',
    fingerprint: fpData
  }));

  // Also save the 3D map points to server
  const mapData = {
    points: lidar3dSlamPoints.slice(-50000),  // Last 50k points
    timestamp: Date.now(),
    position: { x: robotX, y: robotY }
  };
  window.robotWs.send(JSON.stringify({
    type: 'save_3d_map',
    name: areaName,
    mapData: mapData
  }));

  // Update local fingerprints array
  const existingIdx = savedFingerprints.findIndex(fp => fp.name === areaName);
  if (existingIdx >= 0) {
    savedFingerprints[existingIdx] = fpData;
  } else {
    savedFingerprints.push(fpData);
  }

  // Update tracking
  lastAutoSave = now;
  if (isNewArea) {
    lastAutoSavePosition = { x: robotX, y: robotY };
    console.log(`[AUTO-SAVE] NEW area: ${areaName} (${totalPoints} pts) → Server`);
  } else {
    console.log(`[AUTO-SAVE] Updated: ${areaName} (${totalPoints} pts) → Server`);
  }
}

// Find closest saved area to current position
function findClosestSavedArea(x, y) {
  let closest = null;
  let minDist = Infinity;

  for (const fp of savedFingerprints) {
    if (fp.position) {
      const dx = x - fp.position.x;
      const dy = y - fp.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist && dist < AUTO_SAVE_MIN_DISTANCE) {
        minDist = dist;
        closest = fp.name;
      }
    }
  }
  return closest;
}

function saveCurrentMap(name) {
  // Save occupancy grid
  if (window.OccupancyGrid) {
    const json = window.OccupancyGrid.exportMap();
    if (json) {
      localStorage.setItem(`robotMap_${name}`, json);
    }
  }

  // Save accumulated walls
  const wallData = [];
  for (const wall of accumulatedWalls) {
    const pos = wall.geometry.attributes.position.array;
    wallData.push(Array.from(pos));
  }
  localStorage.setItem(`robotWalls_${name}`, JSON.stringify(wallData));

  // Save fingerprint for area recognition
  if (currentFingerprint) {
    const fpData = {
      name: name,
      fingerprint: currentFingerprint,
      timestamp: Date.now()
    };
    localStorage.setItem(`robotFingerprint_${name}`, JSON.stringify(fpData));
    savedFingerprints.push(fpData);
    console.log(`[FINGERPRINT] Saved fingerprint for: ${name}`);
  }

  console.log(`[MAP] Saved map with fingerprint: ${name}`);
  return true;
}

function loadMap(name) {
  // Load occupancy grid
  if (window.OccupancyGrid) {
    const json = localStorage.getItem(`robotMap_${name}`);
    if (json) {
      window.OccupancyGrid.importMap(json);
    }
  }

  // Load accumulated walls
  const wallJson = localStorage.getItem(`robotWalls_${name}`);
  if (wallJson) {
    try {
      // Clear existing walls
      accumulatedWalls.forEach(w => {
        if (w.geometry) w.geometry.dispose();
        if (w.material) w.material.dispose();
        if (lidar3dWorldContainer) lidar3dWorldContainer.remove(w);
      });
      accumulatedWalls = [];
      wallGrid.clear();

      // Recreate walls
      const wallData = JSON.parse(wallJson);
      for (const posArray of wallData) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArray), 3));
        geom.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
          color: 0x4488aa, transparent: true, opacity: 0.5, side: THREE.DoubleSide
        });
        const wall = new THREE.Mesh(geom, mat);
        lidar3dWorldContainer.add(wall);
        accumulatedWalls.push(wall);
      }
      console.log(`[MAP] Loaded ${wallData.length} walls for: ${name}`);
    } catch (e) {
      console.error('[MAP] Error loading walls:', e);
    }
  }

  console.log(`[MAP] Loaded map: ${name}`);
  return true;
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
// Track last stable heading to filter noise
let lastStableCompassHeading = 0;

function updateCompass(heading, x, y, z) {
  window.compassState = { heading, x, y, z };

  // 2-DEGREE NOISE FILTER: Only update robot rotation if compass changed by more than 2°
  // This filters out small noise while still responding to real turns
  const headingDiff = Math.abs(heading - lastStableCompassHeading);
  const wrappedDiff = Math.min(headingDiff, 360 - headingDiff);  // Handle 359→1 wraparound

  if (wrappedDiff > 2) {
    // Real movement detected - update robot orientation
    lastStableCompassHeading = heading;

    // Apply to robot rotation (180 - heading to fix orientation)
    if (window.odomState) {
      window.odomState.heading = (180 - heading) * Math.PI / 180;
    }
  }

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

// ============ ACCUMULATED MAP FROM MAC PROCESSOR ============
// Textured 3D point cloud from depth + camera imagery
let accumulatedMapCloud = null;
let accumulatedMapMesh = null;  // For surface rendering
let accumulatedFrameMarkers = [];
let accumulatedMapVisible = false;  // DISABLED - splat/GPU mapping removed
let showPhotoMarkers = false;  // DISABLED - ugly floating photos on map
let mapRenderMode = 'points';  // 'points' works from all angles, 'splats' had bird's eye issues

// ============ RANSAC ROOM PLANES ============
// Solid wall/floor/ceiling surfaces detected from point cloud
let roomPlaneMeshes = [];
let roomPlanesVisible = false;  // DISABLED - only realtime LIDAR

// Point quality filters - SHOW EVERYTHING for immediate visual feedback
let mapMinObservations = 1;    // Show ALL points immediately (was 2 - caused delay)
let mapMinConfidence = 0.0;    // Allow all confidence levels
let mapMinZ = -0.5;            // Just below floor level
let mapMaxZ = 4.0;             // Higher ceiling for warehouses
let mapMaxMotion = 80;         // Allow more motion - filter less aggressively

// Custom shader for photorealistic splats (circular points that form solid surfaces)
const splatVertexShader = `
  attribute float size;
  attribute vec3 customColor;
  varying vec3 vColor;
  varying float vSize;
  varying float vDepth;
  void main() {
    vColor = customColor;
    vSize = size;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float cameraDist = length(mvPosition.xyz);
    vDepth = cameraDist;
    // Larger point sizes for better coverage with smoother falloff
    gl_PointSize = size * (1800.0 / max(cameraDist, 0.5));
    gl_PointSize = clamp(gl_PointSize, 3.0, 120.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const splatFragmentShader = `
  varying vec3 vColor;
  varying float vSize;
  varying float vDepth;
  void main() {
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);

    // True Gaussian falloff for natural blending
    if (dist > 0.5) discard;
    float gaussian = exp(-8.0 * dist * dist);
    float alpha = gaussian * 0.92;

    // Subtle depth-based ambient occlusion
    float ao = 1.0 - dist * 0.15;
    // Slight highlight at center for 3D feel
    float highlight = smoothstep(0.3, 0.0, dist) * 0.12;

    vec3 finalColor = vColor * ao + vec3(highlight);
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

// Control whether map updates automatically or only on request
let mapAutoUpdate = true;  // ON - show map data, with 30s rate limit to prevent flashing
let pendingMapData = null;  // Store latest data for manual refresh
let mapFirstUpdate = true;  // Force first update immediately

function updateAccumulatedMap(data, forceUpdate = false) {
  if (!lidar3dScene || !lidar3dWorldContainer) return;
  if (!accumulatedMapVisible) return;

  const points = data.points || [];
  if (points.length === 0) return;

  // Store latest data
  pendingMapData = data;

  // Only update if forced OR auto-update is enabled with rate limit
  if (!forceUpdate && !mapAutoUpdate) {
    // Silent - just store data, don't update display
    return;
  }

  // Force first update immediately so something is visible
  const now = Date.now();
  if (mapFirstUpdate) {
    mapFirstUpdate = false;
    console.log('[3D MAP] First update - showing data immediately');
  } else if (!forceUpdate && window._lastMapUpdate && (now - window._lastMapUpdate) < 3000) {
    // Rate limit to 3 seconds - fast enough for feedback, slow enough to prevent flicker
    return;
  }
  window._lastMapUpdate = now;

  console.log(`[3D MAP] Rendering ${points.length} points`);

  // Remove old cloud/mesh
  if (accumulatedMapCloud) {
    if (accumulatedMapCloud.geometry) accumulatedMapCloud.geometry.dispose();
    if (accumulatedMapCloud.material) accumulatedMapCloud.material.dispose();
    lidar3dWorldContainer.remove(accumulatedMapCloud);
    accumulatedMapCloud = null;
  }
  if (accumulatedMapMesh) {
    if (accumulatedMapMesh.geometry) accumulatedMapMesh.geometry.dispose();
    if (accumulatedMapMesh.material) accumulatedMapMesh.material.dispose();
    lidar3dWorldContainer.remove(accumulatedMapMesh);
    accumulatedMapMesh = null;
  }

  const positions = [];
  const colors = [];
  const sizes = [];
  const alphas = [];  // NEW: Per-point opacity for dynamic objects

  // Support compact_v2 format [x, y, z, r, g, b, obs, motion] and legacy formats
  const isCompactV2 = data.format === 'compact_v2';
  const isCompact = isCompactV2 || data.format === 'compact' || (points.length > 0 && Array.isArray(points[0]));

  let filteredCount = 0;
  let skippedObs = 0;
  let skippedConf = 0;
  let skippedZ = 0;
  let dynamicCount = 0;  // Track dynamic objects

  for (const p of points) {
    let px, py, pz, pr, pg, pb, pobs, pmotion;

    if (isCompact) {
      // Compact format: [x, y, z, r, g, b, obs, motion?]
      // compact_v2: motion is 0-100 (0 = static, 100 = dynamic)
      // legacy compact: 8th element might be conf (0-1 float)
      [px, py, pz, pr, pg, pb, pobs, pmotion] = p;
      pobs = pobs || 1;

      // Detect format: compact_v2 sends motion as 0-100 int, legacy sent conf as 0-1 float
      if (isCompactV2) {
        pmotion = pmotion || 0;  // 0-100, default static
      } else {
        pmotion = 0;  // Legacy format - treat as static
      }
    } else {
      // Object format: {x, y, z, r, g, b, obs, c}
      px = p.x; py = p.y; pz = p.z;
      pr = p.r; pg = p.g; pb = p.b;
      pobs = p.obs || 1;
      pmotion = p.motion || 0;
    }

    // Filter by quality thresholds
    if (pobs < mapMinObservations) {
      skippedObs++;
      continue;
    }
    if (pz < mapMinZ || pz > mapMaxZ) {
      skippedZ++;
      continue;
    }

    // Track dynamic objects and filter high-motion points
    const motionScore = pmotion / 100;  // Normalize to 0-1 (0=static, 1=dynamic)
    if (pmotion > mapMaxMotion) {
      dynamicCount++;
      continue;  // Skip dynamic objects above threshold
    }

    filteredCount++;

    // Convert to Three.js coordinates
    // px, py are world coords in meters, pz is height
    positions.push(px, pz || 0.15, -py);

    // USE ACTUAL CAMERA COLORS from the point data (not rainbow gradient)
    // This makes the 3D map look like a photo, not a "bee swarm"
    let r, g, b, alpha;

    // Use actual RGB from camera (0-255 -> 0-1)
    r = (pr || 128) / 255;
    g = (pg || 128) / 255;
    b = (pb || 128) / 255;
    alpha = 1.0;

    // Boost saturation and brightness for vivid colors
    const gray = (r + g + b) / 3;
    const satBoost = 1.3;  // Increase saturation
    const brightBoost = 1.1;  // Slight brightness boost
    r = Math.min(1.0, (gray + (r - gray) * satBoost) * brightBoost);
    g = Math.min(1.0, (gray + (g - gray) * satBoost) * brightBoost);
    b = Math.min(1.0, (gray + (b - gray) * satBoost) * brightBoost);

    colors.push(r, g, b);
    alphas.push(alpha);

    // LARGER DOTS visible from any angle including bird's eye
    // Size varies by observation count - more observed = more confident = larger
    const obsBoost = Math.min(pobs / 3, 1.5);
    const baseSize = 0.15 * (0.7 + obsBoost * 0.3);  // 0.105 to 0.157 - much larger for visibility
    sizes.push(baseSize);
  }

  // Log dynamic object stats
  if (dynamicCount > 0) {
    console.log(`[3D MAP] Dynamic objects detected: ${dynamicCount}/${filteredCount}`);
  }

  console.log(`[3D MAP] Filtered: ${filteredCount}/${points.length} (skipped: obs=${skippedObs}, conf=${skippedConf}, z=${skippedZ})`);

  if (positions.length === 0) {
    console.log('[3D MAP] No points passed filters');
    return;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('customColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('alpha', new THREE.Float32BufferAttribute(alphas, 1));  // Per-point opacity for dynamic objects

  if (mapRenderMode === 'splats') {
    // Use custom shader for photorealistic splats with soft edge blending
    const material = new THREE.ShaderMaterial({
      vertexShader: splatVertexShader,
      fragmentShader: splatFragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: true,  // Write depth so back points are occluded
      blending: THREE.NormalBlending  // Enable blending for soft edges
    });

    // Sort points by depth (back-to-front) so closer points render last and occlude
    // This ensures proper painter's algorithm even with depth buffer
    const posArray = geometry.getAttribute('position').array;
    const colorArray = geometry.getAttribute('customColor').array;
    const sizeArray = geometry.getAttribute('size').array;
    const numPoints = posArray.length / 3;

    // Create index array for sorting
    const indices = new Array(numPoints);
    for (let i = 0; i < numPoints; i++) indices[i] = i;

    // Sort by Y (depth in Three.js) - back to front
    indices.sort((a, b) => {
      const ay = posArray[a * 3 + 2];  // Z in world = depth
      const by = posArray[b * 3 + 2];
      return ay - by;  // Back to front
    });

    // Reorder all attributes
    const sortedPos = new Float32Array(posArray.length);
    const sortedColor = new Float32Array(colorArray.length);
    const sortedSize = new Float32Array(sizeArray.length);

    for (let i = 0; i < numPoints; i++) {
      const srcIdx = indices[i];
      sortedPos[i * 3] = posArray[srcIdx * 3];
      sortedPos[i * 3 + 1] = posArray[srcIdx * 3 + 1];
      sortedPos[i * 3 + 2] = posArray[srcIdx * 3 + 2];
      sortedColor[i * 3] = colorArray[srcIdx * 3];
      sortedColor[i * 3 + 1] = colorArray[srcIdx * 3 + 1];
      sortedColor[i * 3 + 2] = colorArray[srcIdx * 3 + 2];
      sortedSize[i] = sizeArray[srcIdx];
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(sortedPos, 3));
    geometry.setAttribute('customColor', new THREE.Float32BufferAttribute(sortedColor, 3));
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(sortedSize, 1));

    accumulatedMapCloud = new THREE.Points(geometry, material);
    accumulatedMapCloud.renderOrder = 0;  // Render with scene
  } else if (mapRenderMode === 'surface') {
    // Simple approach: render as larger overlapping quads
    // For true surface reconstruction, would need Delaunay/Poisson on server
    accumulatedMapCloud = createSurfaceApproximation(points);
  } else {
    // Standard points (works from ALL angles including bird's eye)
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.2,  // Larger points visible from any angle
      map: getLidarPointTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      alphaTest: 0.01,
      sizeAttenuation: true,
      depthWrite: true  // Proper depth sorting
    });
    accumulatedMapCloud = new THREE.Points(geometry, material);
  }

  if (accumulatedMapCloud) {
    lidar3dWorldContainer.add(accumulatedMapCloud);
  }

  // Update stats display
  const pointCountEl = document.getElementById('accumulatedPointCount');
  if (pointCountEl) pointCountEl.textContent = points.length.toLocaleString();

  const statusEl = document.getElementById('map3dStatus');
  if (statusEl) {
    const stats = data.stats || {};
    const dynamicInfo = dynamicCount > 0 ? ` | dynamic=${dynamicCount}` : '';
    statusEl.textContent = `3D: ${points.length.toLocaleString()} pts${dynamicInfo} | scale=${stats.depth_scale || '?'}`;
  }

  // Store dynamic count globally for other UI elements
  window.dynamicObjectCount = dynamicCount;
}

// Create surface approximation using billboarded quads
function createSurfaceApproximation(points) {
  // For each point, create a quad facing the camera - larger = more solid walls
  const quadSize = 0.15;  // 15cm quads for solid-looking surfaces
  const positions = [];
  const colors = [];
  const uvs = [];

  for (const p of points) {
    const x = p.x;
    const y = p.z || 0.15;
    const z = -p.y;

    // Get color
    let r = (p.r || 128) / 255;
    let g = (p.g || 128) / 255;
    let b = (p.b || 128) / 255;

    // Create quad vertices (2 triangles)
    const hs = quadSize / 2;

    // Triangle 1
    positions.push(x - hs, y - hs, z);
    positions.push(x + hs, y - hs, z);
    positions.push(x + hs, y + hs, z);

    // Triangle 2
    positions.push(x - hs, y - hs, z);
    positions.push(x + hs, y + hs, z);
    positions.push(x - hs, y + hs, z);

    // 6 vertices per quad
    for (let i = 0; i < 6; i++) {
      colors.push(r, g, b);
    }

    uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9
  });

  return new THREE.Mesh(geometry, material);
}

// Toggle render mode
function setMapRenderMode(mode) {
  mapRenderMode = mode;
  console.log(`[3D MAP] Render mode set to: ${mode}`);
}

// ============ RANSAC ROOM PLANES RENDERING ============
// Creates solid wall/floor/ceiling surfaces from detected planes
function updateRoomPlanes(data) {
  if (!lidar3dScene || !lidar3dWorldContainer) return;
  if (!roomPlanesVisible) return;

  const planes = data.planes || [];
  if (planes.length === 0) return;

  // Remove old plane meshes
  for (const mesh of roomPlaneMeshes) {
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
    lidar3dWorldContainer.remove(mesh);
  }
  roomPlaneMeshes = [];

  // Create mesh for each detected plane
  for (const plane of planes) {
    const { type, normal, center, bounds, color } = plane;

    // Calculate plane dimensions from bounds
    const minX = bounds.min[0], maxX = bounds.max[0];
    const minY = bounds.min[1], maxY = bounds.max[1];
    const minZ = bounds.min[2], maxZ = bounds.max[2];

    let width, height, mesh;
    const normalVec = new THREE.Vector3(normal[0], normal[1], normal[2]);

    // Color from average RGB
    const planeColor = new THREE.Color(color[0]/255, color[1]/255, color[2]/255);

    // Create plane geometry based on orientation
    if (type === 'floor' || type === 'ceiling') {
      // Horizontal plane - lies on X-Y plane (floor/ceiling)
      width = maxX - minX;
      height = maxY - minY;
      const geometry = new THREE.PlaneGeometry(width, height);
      const material = new THREE.MeshLambertMaterial({
        color: planeColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85
      });
      mesh = new THREE.Mesh(geometry, material);

      // Position and rotate for horizontal
      // Convert: px, py -> world X, -Z; pz -> Y
      mesh.position.set(
        (minX + maxX) / 2,
        center[2],  // Z becomes Y (height)
        -(minY + maxY) / 2
      );
      mesh.rotation.x = -Math.PI / 2;  // Rotate to horizontal

    } else {
      // Vertical plane (wall)
      // Determine if wall faces X or Y direction based on normal
      const nx = Math.abs(normal[0]);
      const ny = Math.abs(normal[1]);

      if (nx > ny) {
        // Wall faces X direction (perpendicular to X axis)
        width = maxY - minY;
        height = maxZ - minZ;
        const geometry = new THREE.PlaneGeometry(width, height);
        const material = new THREE.MeshLambertMaterial({
          color: planeColor,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85
        });
        mesh = new THREE.Mesh(geometry, material);

        // Position: center of wall bounds
        mesh.position.set(
          center[0],
          (minZ + maxZ) / 2,
          -(minY + maxY) / 2
        );
        mesh.rotation.y = Math.PI / 2;  // Face along X

      } else {
        // Wall faces Y direction (perpendicular to Y axis)
        width = maxX - minX;
        height = maxZ - minZ;
        const geometry = new THREE.PlaneGeometry(width, height);
        const material = new THREE.MeshLambertMaterial({
          color: planeColor,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85
        });
        mesh = new THREE.Mesh(geometry, material);

        // Position: center of wall bounds
        mesh.position.set(
          (minX + maxX) / 2,
          (minZ + maxZ) / 2,
          -center[1]
        );
        // Default rotation faces along Y
      }
    }

    if (mesh) {
      mesh.userData = { planeType: type, pointCount: plane.point_count };
      lidar3dWorldContainer.add(mesh);
      roomPlaneMeshes.push(mesh);
    }
  }

  console.log(`[PLANES] Rendered ${roomPlaneMeshes.length} solid surfaces`);
}

// Toggle room planes visibility
function toggleRoomPlanesVisible(visible) {
  roomPlanesVisible = visible !== undefined ? visible : !roomPlanesVisible;
  for (const mesh of roomPlaneMeshes) {
    mesh.visible = roomPlanesVisible;
  }
  console.log(`[PLANES] Visibility: ${roomPlanesVisible}`);
  return roomPlanesVisible;
}

function updateFrameHistory(data) {
  if (!lidar3dScene || !lidar3dWorldContainer) return;
  if (!showPhotoMarkers) return;

  const frames = data.frames || [];

  // Clear old frame markers
  for (const marker of accumulatedFrameMarkers) {
    if (marker.material && marker.material.map) marker.material.map.dispose();
    if (marker.material) marker.material.dispose();
    if (marker.geometry) marker.geometry.dispose();
    lidar3dWorldContainer.remove(marker);
  }
  accumulatedFrameMarkers = [];

  console.log(`[FRAMES] Rendering ${frames.length} photo markers`);

  // Create new frame markers (floating photos on map)
  for (const frame of frames) {
    if (!frame.pose) continue;

    // Create a plane with the camera frame texture
    const loader = new THREE.TextureLoader();
    const texture = loader.load('data:image/jpeg;base64,' + frame.frame);

    // Bigger photos (0.6m x 0.4m) for better visibility
    const geometry = new THREE.PlaneGeometry(0.6, 0.4);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    });

    const marker = new THREE.Mesh(geometry, material);

    // Position at capture location (flip Y to Z, floating higher)
    const x = frame.pose.x / 100;  // cm to m
    const z = -frame.pose.y / 100;
    marker.position.set(x, 0.5, z);  // 50cm above ground

    // Face camera heading
    marker.rotation.y = -frame.pose.heading * Math.PI / 180;
    marker.rotation.x = -Math.PI * 0.15;  // Tilt slightly toward viewer

    lidar3dWorldContainer.add(marker);
    accumulatedFrameMarkers.push(marker);
  }

  // Update frame count display
  const frameCountEl = document.getElementById('accumulatedFrameCount');
  if (frameCountEl) frameCountEl.textContent = frames.length;
}

function toggleAccumulatedMapVisible() {
  accumulatedMapVisible = !accumulatedMapVisible;

  if (!accumulatedMapVisible) {
    // Hide accumulated cloud
    if (accumulatedMapCloud) {
      lidar3dWorldContainer.remove(accumulatedMapCloud);
    }
    // Hide frame markers
    for (const marker of accumulatedFrameMarkers) {
      lidar3dWorldContainer.remove(marker);
    }
  }

  return accumulatedMapVisible;
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

// ============ 3D ROOM MODEL LOADER ============
// Loads photorealistic room reconstructions from the scanner
let roomModelCloud = null;
let roomModelVisible = true;

async function loadRoomModel(filename = 'latest_room.json') {
  if (!lidar3dScene || !lidar3dWorldContainer) {
    console.log('[3D ROOM] Scene not ready');
    return false;
  }

  try {
    console.log(`[3D ROOM] Loading ${filename}...`);
    const response = await fetch(`/3d_models/${filename}`);
    if (!response.ok) {
      console.log('[3D ROOM] No room model available yet');
      return false;
    }

    const data = await response.json();
    const points = data.points || [];

    if (points.length === 0) {
      console.log('[3D ROOM] Model has no points');
      return false;
    }

    console.log(`[3D ROOM] Rendering ${points.length} points`);

    // Remove old model
    if (roomModelCloud) {
      if (roomModelCloud.geometry) roomModelCloud.geometry.dispose();
      if (roomModelCloud.material) roomModelCloud.material.dispose();
      lidar3dWorldContainer.remove(roomModelCloud);
    }

    const positions = [];
    const colors = [];

    for (const p of points) {
      // Position: x, y (height), z
      positions.push(p.x, p.y, -p.z);

      // RGB colors from camera imagery
      colors.push(
        (p.r || 128) / 255,
        (p.g || 128) / 255,
        (p.b || 128) / 255
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.04,  // Small points for detail
      map: getLidarPointTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      alphaTest: 0.01,
      sizeAttenuation: true,
      depthWrite: false
    });

    roomModelCloud = new THREE.Points(geometry, material);
    lidar3dWorldContainer.add(roomModelCloud);

    console.log(`[3D ROOM] Loaded ${points.length} points successfully`);

    // Update UI
    const statusEl = document.getElementById('roomModelStatus');
    if (statusEl) statusEl.textContent = `Room: ${points.length.toLocaleString()} pts`;

    return true;
  } catch (e) {
    console.log('[3D ROOM] Error loading model:', e);
    return false;
  }
}

function toggleRoomModelVisible() {
  roomModelVisible = !roomModelVisible;
  if (roomModelCloud) {
    roomModelCloud.visible = roomModelVisible;
  }
  return roomModelVisible;
}

// Try to load room model on init
setTimeout(() => {
  loadRoomModel();
}, 2000);

// ============ SEMANTIC LAYOUT VISUALIZATION ============
// Walls, doorways, and detected objects from semantic mapper
let semanticWalls = [];
let semanticDoorways = [];
let semanticObjects = [];
let semanticVisible = false;  // DISABLED - colored point cloud looks better

function updateSemanticLayout(data) {
  if (!lidar3dScene || !lidar3dWorldContainer) return;
  if (!semanticVisible) return;

  const layout = data.layout || {};
  const walls = layout.walls || [];
  const doorways = layout.doorways || [];
  const objects = layout.objects || [];

  console.log(`[SEMANTIC] Rendering: ${walls.length} walls, ${doorways.length} doorways, ${objects.length} objects`);

  // Clear old semantic objects
  semanticWalls.forEach(w => {
    if (w.geometry) w.geometry.dispose();
    if (w.material) w.material.dispose();
    lidar3dWorldContainer.remove(w);
  });
  semanticWalls = [];

  semanticDoorways.forEach(d => {
    if (d.geometry) d.geometry.dispose();
    if (d.material) d.material.dispose();
    lidar3dWorldContainer.remove(d);
  });
  semanticDoorways = [];

  semanticObjects.forEach(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    lidar3dWorldContainer.remove(o);
  });
  semanticObjects = [];

  // Render walls as semi-transparent planes
  for (const wall of walls) {
    if (wall.type !== 'wall' || !wall.bounds) continue;

    const b = wall.bounds;
    const width = Math.sqrt(Math.pow(b.max_x - b.min_x, 2) + Math.pow(b.max_y - b.min_y, 2));
    const height = b.max_z - b.min_z;

    if (width < 0.3 || height < 0.3) continue;

    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const wallMesh = new THREE.Mesh(geometry, material);

    // Position at wall center
    const centerX = (b.min_x + b.max_x) / 2;
    const centerY = (b.min_y + b.max_y) / 2;
    const centerZ = (b.min_z + b.max_z) / 2;
    wallMesh.position.set(centerX, centerZ, -centerY);

    // Rotate to face the wall normal
    if (wall.normal) {
      const angle = Math.atan2(wall.normal[1], wall.normal[0]);
      wallMesh.rotation.y = -angle;
    }

    lidar3dWorldContainer.add(wallMesh);
    semanticWalls.push(wallMesh);

    // Add wall outline
    const edges = new THREE.EdgesGeometry(geometry);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x4488ff }));
    line.position.copy(wallMesh.position);
    line.rotation.copy(wallMesh.rotation);
    lidar3dWorldContainer.add(line);
    semanticWalls.push(line);
  }

  // Render doorways as green rectangles
  for (const doorway of doorways) {
    const pos = doorway.position || [0, 0, 0];
    const width = doorway.width || 0.9;

    const geometry = new THREE.PlaneGeometry(width, 2.0);  // 2m tall doorway
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff44,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const doorMesh = new THREE.Mesh(geometry, material);
    doorMesh.position.set(pos[0], 1.0, -pos[1]);  // Center at 1m height

    if (doorway.normal && doorway.normal.length >= 2) {
      const angle = Math.atan2(doorway.normal[1], doorway.normal[0]);
      doorMesh.rotation.y = -angle + Math.PI/2;
    }

    lidar3dWorldContainer.add(doorMesh);
    semanticDoorways.push(doorMesh);
  }

  // Render detected objects as colored boxes with labels
  for (const obj of objects) {
    const pos = obj.position || [0, 0, 0];
    const size = obj.size || [0.5, 0.5, 0.5];

    // Object color based on class
    let color = 0xffaa00;  // Default orange
    const className = (obj.class || '').toLowerCase();
    if (className.includes('chair')) color = 0x8844ff;
    if (className.includes('table')) color = 0x884422;
    if (className.includes('couch') || className.includes('sofa')) color = 0x448844;
    if (className.includes('person')) color = 0xff4444;
    if (className.includes('plant') || className.includes('tree')) color = 0x22aa22;
    if (className.includes('tv') || className.includes('monitor')) color = 0x222222;
    if (className.includes('lamp') || className.includes('light')) color = 0xffff44;

    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    });

    const objMesh = new THREE.Mesh(geometry, material);
    objMesh.position.set(pos[0], pos[2], -pos[1]);

    lidar3dWorldContainer.add(objMesh);
    semanticObjects.push(objMesh);

    // Add wireframe
    const wireframe = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: color })
    );
    wireframe.position.copy(objMesh.position);
    lidar3dWorldContainer.add(wireframe);
    semanticObjects.push(wireframe);

    // Add floating label using sprite
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(obj.class || 'Object', 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(0.5, 0.125, 1);
    sprite.position.set(pos[0], pos[2] + size[1]/2 + 0.2, -pos[1]);
    lidar3dWorldContainer.add(sprite);
    semanticObjects.push(sprite);
  }

  // Update stats display
  const statsEl = document.getElementById('semanticStats');
  if (statsEl) {
    const stats = data.stats || {};
    statsEl.textContent = `Semantic: ${stats.planes||0} planes, ${stats.doorways||0} doors, ${stats.objects||0} objects`;
  }
}

function toggleSemanticVisible() {
  semanticVisible = !semanticVisible;
  if (!semanticVisible) {
    semanticWalls.forEach(w => lidar3dWorldContainer.remove(w));
    semanticDoorways.forEach(d => lidar3dWorldContainer.remove(d));
    semanticObjects.forEach(o => lidar3dWorldContainer.remove(o));
  }
  return semanticVisible;
}

// ============ MAP FILTER CONTROLS ============
function setMapFilters(options) {
  if (options.minObservations !== undefined) {
    mapMinObservations = options.minObservations;
    console.log(`[MAP] Min observations set to: ${mapMinObservations}`);
  }
  if (options.minConfidence !== undefined) {
    mapMinConfidence = options.minConfidence;
    console.log(`[MAP] Min confidence set to: ${mapMinConfidence}`);
  }
  if (options.minZ !== undefined) {
    mapMinZ = options.minZ;
    console.log(`[MAP] Min Z set to: ${mapMinZ}`);
  }
  if (options.maxZ !== undefined) {
    mapMaxZ = options.maxZ;
    console.log(`[MAP] Max Z set to: ${mapMaxZ}`);
  }
  if (options.maxMotion !== undefined) {
    mapMaxMotion = options.maxMotion;
    console.log(`[MAP] Max motion (dynamic filter) set to: ${mapMaxMotion}`);
  }
  return { mapMinObservations, mapMinConfidence, mapMinZ, mapMaxZ, mapMaxMotion };
}

function getMapFilters() {
  return { mapMinObservations, mapMinConfidence, mapMinZ, mapMaxZ, mapMaxMotion };
}

// Preset filter configurations
function setMapFilterPreset(preset) {
  switch (preset) {
    case 'strict':
      // High quality - only well-observed static points
      setMapFilters({ minObservations: 3, maxMotion: 30, minZ: -0.3, maxZ: 3.0 });
      break;
    case 'balanced':
      // Default - good quality with reasonable coverage
      setMapFilters({ minObservations: 2, maxMotion: 40, minZ: -0.5, maxZ: 3.5 });
      break;
    case 'permissive':
      // Show more points including uncertain ones
      setMapFilters({ minObservations: 1, maxMotion: 60, minZ: -1.0, maxZ: 5.0 });
      break;
    case 'all':
      // Show everything (debugging)
      setMapFilters({ minObservations: 1, maxMotion: 100, minZ: -10, maxZ: 10 });
      break;
    default:
      console.log(`[MAP] Unknown preset: ${preset}`);
  }
  console.log(`[MAP] Filter preset applied: ${preset}`);
}

// Manual map refresh - call this when MAP 1 completes
function refreshMap() {
  if (pendingMapData) {
    console.log('[3D MAP] Manual refresh triggered');
    updateAccumulatedMap(pendingMapData, true);  // Force update
  } else {
    console.log('[3D MAP] No pending data to refresh');
  }
}

// Toggle auto-update mode
function setMapAutoUpdate(enabled) {
  mapAutoUpdate = enabled;
  console.log(`[3D MAP] Auto-update: ${enabled}`);
}

// ============ GAUSSIAN SPLAT (SHARP) LOADER ============
// Loads PLY splat files from /splats/latest.ply
let gaussianSplatLastCheck = 0;
const GAUSSIAN_SPLAT_CHECK_INTERVAL = 5000;  // Check every 5 seconds

async function loadGaussianSplat() {
  if (!gaussianSplatEnabled || !lidar3dInitialized) return;

  try {
    // Fetch the PLY file (include credentials for auth)
    const response = await fetch('/splats/latest.ply?t=' + Date.now(), {
      credentials: 'include'
    });
    if (!response.ok) {
      // No splat file yet - that's fine
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = parseGaussianPLY(arrayBuffer);

    if (data && data.positions && data.positions.length > 0) {
      renderGaussianSplats(data);
      console.log('[SPLAT] Loaded', data.positions.length / 3, 'splats');
    }
  } catch (err) {
    // Silently ignore errors - don't break the main visualization
    console.log('[SPLAT] Load error:', err.message);
  }
}

function parseGaussianPLY(arrayBuffer) {
  try {
    const text = new TextDecoder().decode(arrayBuffer);
    const headerEnd = text.indexOf('end_header');
    if (headerEnd === -1) return null;

    const header = text.substring(0, headerEnd);

    // Parse vertex count
    const vertexMatch = header.match(/element vertex (\d+)/);
    if (!vertexMatch) return null;
    const vertexCount = parseInt(vertexMatch[1]);

    if (vertexCount === 0) return null;

    // Find property indices
    const props = header.split('\n').filter(l => l.startsWith('property'));
    let xIdx = -1, yIdx = -1, zIdx = -1;
    let rIdx = -1, gIdx = -1, bIdx = -1;
    let opacityIdx = -1;

    props.forEach((p, i) => {
      if (p.includes(' x')) xIdx = i;
      if (p.includes(' y')) yIdx = i;
      if (p.includes(' z')) zIdx = i;
      if (p.includes(' red') || p.includes(' f_dc_0')) rIdx = i;
      if (p.includes(' green') || p.includes(' f_dc_1')) gIdx = i;
      if (p.includes(' blue') || p.includes(' f_dc_2')) bIdx = i;
      if (p.includes(' opacity')) opacityIdx = i;
    });

    // Check if binary or ASCII
    const isBinary = header.includes('format binary');

    const positions = [];
    const colors = [];
    const opacities = [];

    if (isBinary) {
      // Binary PLY - read after header
      const headerBytes = new TextEncoder().encode(text.substring(0, headerEnd + 11)).length;
      const dataView = new DataView(arrayBuffer, headerBytes);

      // Assume float32 for each property
      const bytesPerVertex = props.length * 4;

      for (let i = 0; i < Math.min(vertexCount, 50000); i++) {  // Limit to 50k points
        const offset = i * bytesPerVertex;

        if (offset + bytesPerVertex > dataView.byteLength) break;

        // Read position (swap Y and Z for Three.js coordinate system)
        const x = dataView.getFloat32(offset + xIdx * 4, true);
        const y = dataView.getFloat32(offset + zIdx * 4, true);  // Z -> Y
        const z = dataView.getFloat32(offset + yIdx * 4, true);  // Y -> Z

        positions.push(x, y, z);

        // Read color (convert SH coefficients to RGB if needed)
        if (rIdx >= 0) {
          let r = dataView.getFloat32(offset + rIdx * 4, true);
          let g = dataView.getFloat32(offset + gIdx * 4, true);
          let b = dataView.getFloat32(offset + bIdx * 4, true);

          // SH to RGB conversion: C0 * SH_C0 + 0.5
          const SH_C0 = 0.28209479177387814;
          r = r * SH_C0 + 0.5;
          g = g * SH_C0 + 0.5;
          b = b * SH_C0 + 0.5;

          colors.push(
            Math.max(0, Math.min(1, r)),
            Math.max(0, Math.min(1, g)),
            Math.max(0, Math.min(1, b))
          );
        } else {
          colors.push(1, 1, 1);  // Default white
        }

        // Read opacity
        if (opacityIdx >= 0) {
          const opacity = dataView.getFloat32(offset + opacityIdx * 4, true);
          // Sigmoid activation for opacity
          opacities.push(1.0 / (1.0 + Math.exp(-opacity)));
        } else {
          opacities.push(1.0);
        }
      }
    } else {
      // ASCII PLY
      const dataStart = headerEnd + 11;  // Skip "end_header\n"
      const lines = text.substring(dataStart).trim().split('\n');

      for (let i = 0; i < Math.min(lines.length, 50000); i++) {
        const values = lines[i].trim().split(/\s+/).map(parseFloat);
        if (values.length < 3) continue;

        // Position (swap Y and Z)
        positions.push(values[xIdx], values[zIdx], values[yIdx]);

        // Color
        if (rIdx >= 0 && values.length > Math.max(rIdx, gIdx, bIdx)) {
          colors.push(
            values[rIdx] / 255,
            values[gIdx] / 255,
            values[bIdx] / 255
          );
        } else {
          colors.push(1, 1, 1);
        }

        opacities.push(1.0);
      }
    }

    return {
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      opacities: new Float32Array(opacities)
    };
  } catch (err) {
    console.log('[SPLAT] Parse error:', err.message);
    return null;
  }
}

function renderGaussianSplats(data) {
  try {
    // Remove old splat cloud
    if (gaussianSplatCloud) {
      lidar3dScene.remove(gaussianSplatCloud);
      gaussianSplatCloud.geometry.dispose();
      gaussianSplatCloud.material.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));

    // Create point cloud with vertex colors and circular texture
    const material = new THREE.PointsMaterial({
      size: 0.06,
      map: getLidarPointTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      alphaTest: 0.01,
      sizeAttenuation: true,
      depthWrite: false
    });

    gaussianSplatCloud = new THREE.Points(geometry, material);
    gaussianSplatCloud.name = 'gaussianSplat';

    // Center the geometry and place at ground level
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);

    // Position so bottom of splat cloud is at ground level
    const minY = geometry.boundingBox.min.y;
    gaussianSplatCloud.position.set(-center.x, -minY + 0.1, -center.z);

    lidar3dScene.add(gaussianSplatCloud);
  } catch (err) {
    console.log('[SPLAT] Render error:', err.message);
  }
}

function toggleGaussianSplat(enabled) {
  gaussianSplatEnabled = enabled !== undefined ? enabled : !gaussianSplatEnabled;
  if (gaussianSplatCloud) {
    gaussianSplatCloud.visible = gaussianSplatEnabled;
  }
  console.log('[SPLAT] Enabled:', gaussianSplatEnabled);
  return gaussianSplatEnabled;
}

// Advanced Gaussian splat renderer with per-point sizes
function renderGaussianSplatsAdvanced(data) {
  try {
    // Remove old splat cloud
    if (gaussianSplatCloud) {
      lidar3dScene.remove(gaussianSplatCloud);
      gaussianSplatCloud.geometry.dispose();
      gaussianSplatCloud.material.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));

    // Use ShaderMaterial for per-point sizes
    const vertexShader = `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      varying vec3 vColor;
      void main() {
        // Circular splat with soft edges
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        if (dist > 0.5) discard;
        // Gaussian falloff for soft splats
        float alpha = exp(-dist * dist * 8.0);
        gl_FragColor = vec4(vColor, alpha * 0.9);
      }
    `;

    // If sizes provided, use shader material
    if (data.sizes && data.sizes.length > 0) {
      geometry.setAttribute('size', new THREE.Float32BufferAttribute(data.sizes, 1));

      const material = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });

      gaussianSplatCloud = new THREE.Points(geometry, material);
    } else {
      // Fallback to basic point material
      const material = new THREE.PointsMaterial({
        size: 0.1,
        map: getLidarPointTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        alphaTest: 0.01,
        sizeAttenuation: true,
        depthWrite: false
      });
      gaussianSplatCloud = new THREE.Points(geometry, material);
    }

    gaussianSplatCloud.name = 'gaussianSplat';

    // SHARP splats are already in world coordinates - don't re-center
    // Just position at origin since coords are world-relative
    gaussianSplatCloud.position.set(0, 0, 0);

    lidar3dScene.add(gaussianSplatCloud);
    console.log(`[SPLAT] Added ${data.positions.length / 3} advanced splats to scene at origin`);
  } catch (err) {
    console.log('[SPLAT] Advanced render error:', err.message);
    // Fallback to basic render
    renderGaussianSplats(data);
  }
}

// Update Gaussian Splats from SHARP mapper (converts SHARP format to render format)
function updateGaussianSplats(data) {
  if (!lidar3dScene || !gaussianSplatEnabled) return;

  console.log(`[SHARP] Rendering ${data.num_splats} splats from ${data.num_frames} frames`);

  // Convert SHARP format (means, colors, scales, opacities) to render format
  const means = data.means || [];
  const colors = data.colors || [];
  const opacities = data.opacities || [];
  const scales = data.scales || [];

  if (means.length === 0) {
    console.log('[SHARP] No splats to render');
    return;
  }

  // Flatten arrays for Three.js
  const positions = [];
  const flatColors = [];
  const sizes = [];

  for (let i = 0; i < means.length; i++) {
    const m = means[i];
    const c = colors[i] || [0.5, 0.5, 0.5];
    const opacity = opacities[i] || 0.8;
    const scale = scales[i] || [0.02, 0.02, 0.02];

    // Only render splats with reasonable opacity
    if (opacity < 0.1) continue;

    // SHARP coords already transformed by sharp_mapper.py
    positions.push(m[0], m[1], -m[2]);

    // Apply opacity to colors (premultiplied alpha effect)
    flatColors.push(
      Math.min(1, c[0] * opacity * 1.5),
      Math.min(1, c[1] * opacity * 1.5),
      Math.min(1, c[2] * opacity * 1.5)
    );

    // Size from average scale
    const avgScale = (scale[0] + scale[1] + scale[2]) / 3;
    sizes.push(Math.max(0.02, Math.min(0.3, avgScale * 2)));
  }

  renderGaussianSplatsAdvanced({
    positions: positions,
    colors: flatColors,
    sizes: sizes
  });

  console.log(`[SHARP] Rendered ${positions.length / 3} Gaussian splats`);
}

// Check for new splats periodically
function checkForNewSplats() {
  const now = Date.now();
  if (now - gaussianSplatLastCheck > GAUSSIAN_SPLAT_CHECK_INTERVAL) {
    gaussianSplatLastCheck = now;
    loadGaussianSplat();
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', initLidar3D);
setTimeout(initLidar3D, 500);

// Start checking for splats after init
setTimeout(() => {
  loadGaussianSplat();
  setInterval(checkForNewSplats, GAUSSIAN_SPLAT_CHECK_INTERVAL);
}, 2000);

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
  // Jetson SLAM map visualization
  updateMapCells,
  toggleSlamMapVisible,
  // GPS/Compass functions
  updateCompass,
  updateGps,
  // Mac processor accumulated map
  updateAccumulatedMap,
  updateFrameHistory,
  toggleAccumulatedMapVisible,
  setMapRenderMode,  // Switch between 'points', 'splats', 'surface'
  refreshMap,        // Manual refresh - no flashing
  setMapAutoUpdate,  // Enable/disable auto-updates
  // RANSAC room planes (solid wall/floor/ceiling surfaces)
  updateRoomPlanes,
  toggleRoomPlanesVisible,
  // 3D room model
  loadRoomModel,
  toggleRoomModelVisible,
  // Semantic layout (walls, doorways, objects)
  updateSemanticLayout,
  toggleSemanticVisible,
  // Map quality filters
  setMapFilters,
  getMapFilters,
  setMapFilterPreset,
  // Fingerprint & persistent map storage
  handleSavedFingerprints,
  handleLoaded3DMap,
  // Gaussian Splat (SHARP)
  loadGaussianSplat,
  toggleGaussianSplat,
  updateGaussianSplats,  // For live SHARP mapper data
  // Navigation & exploration
  updateNavPath,
  updateFrontiers,
  handleGridUpdate,
  toggleOccupancyGrid: (show) => { showOccupancyGrid = show !== undefined ? show : !showOccupancyGrid; return showOccupancyGrid; }
};
