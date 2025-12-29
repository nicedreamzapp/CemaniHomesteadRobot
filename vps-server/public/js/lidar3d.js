// ============ 3D LIDAR VISUALIZATION ============
// Three.js scene, robot model, grid, and SLAM mapping

let lidar3dScene, lidar3dCamera, lidar3dRenderer, lidar3dControls;
let lidar3dRobot, lidar3dWalls = [], lidar3dPointCloud;
let lidar3dTrailLine = null, lidar3dTrailGeom = null;
let lidar3dInitialized = false;
let lidar3dFrameCount = 0;
let lidar3dGrid = null;
let lidar3dWorldContainer = null;
let lidar3dSlamPoints = [];
let lidar3dSlamCloud = null;
let lidar3dUltrasonicCones = { FL: null, FR: null, RL: null, RR: null };
const SLAM_MAX_POINTS = 50000;
const SLAM_POINT_SPACING = 0.03;
let lastLidarUpdate = 0;
const LIDAR_UPDATE_INTERVAL = 100;
let animFrameCount = 0;

// Initialize odomState
window.odomState = window.odomState || { x: 0, y: 0, heading: 0, totalDistance: 0, trail: [{ x: 0, y: 0 }] };

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

  // Grid - 30ft x 30ft
  const gridSizeFt = 30;
  const gridSizeM = gridSizeFt * 0.3048;
  lidar3dGrid = new THREE.GridHelper(gridSizeM, gridSizeFt, 0x00ffff, 0x006666);
  lidar3dGrid.position.y = 0.005;
  lidar3dWorldContainer.add(lidar3dGrid);

  // Ground
  const groundGeom = new THREE.PlaneGeometry(30, 30);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a1520, transparent: true, opacity: 0.7 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  lidar3dWorldContainer.add(ground);

  lidar3dRobot = createRobot3D();
  lidar3dScene.add(lidar3dRobot);

  // Trail line
  lidar3dTrailGeom = new THREE.BufferGeometry();
  const trailMat = new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 });
  lidar3dTrailLine = new THREE.Line(lidar3dTrailGeom, trailMat);
  lidar3dWorldContainer.add(lidar3dTrailLine);

  // SLAM point cloud
  lidar3dSlamCloud = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.08, vertexColors: true, transparent: true, opacity: 0.8 })
  );
  lidar3dWorldContainer.add(lidar3dSlamCloud);

  lidar3dInitialized = true;
  animateLidar3D();
}

// ============ ROBOT MODEL ============
function createRobot3D() {
  const group = new THREE.Group();

  const bodyGeom = new THREE.BoxGeometry(0.35, 0.2, 0.45);
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x1a5a3a, emissive: 0x0a2a1a });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.12;
  group.add(body);

  const edges = new THREE.EdgesGeometry(bodyGeom);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x00ff88 }));
  line.position.y = 0.12;
  group.add(line);

  const wheelGeom = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12);
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
  [[-0.18, 0.06, 0.15], [0.18, 0.06, 0.15], [-0.18, 0.06, -0.15], [0.18, 0.06, -0.15]].forEach(pos => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(...pos);
    group.add(wheel);
  });

  // Front arrow
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.12);
  arrowShape.lineTo(-0.06, 0);
  arrowShape.lineTo(0.06, 0);
  arrowShape.closePath();
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(arrowShape),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.23, -0.3);
  group.add(arrow);

  // Lidar sensor
  const lidarGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12);
  const lidarMat = new THREE.MeshPhongMaterial({ color: 0x333333, emissive: 0x00ff88, emissiveIntensity: 0.3 });
  const lidar = new THREE.Mesh(lidarGeom, lidarMat);
  lidar.position.y = 0.24;
  group.add(lidar);

  // Ultrasonic cones
  const conePositions = {
    FL: { x: -0.12, z: -0.22, rotY: Math.PI * 0.15 },
    FR: { x: 0.12, z: -0.22, rotY: -Math.PI * 0.15 },
    RL: { x: -0.12, z: 0.22, rotY: Math.PI - Math.PI * 0.15 },
    RR: { x: 0.12, z: 0.22, rotY: Math.PI + Math.PI * 0.15 }
  };

  Object.keys(conePositions).forEach(sensor => {
    const pos = conePositions[sensor];
    const coneGeom = new THREE.ConeGeometry(0.15, 0.5, 16, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false
    });
    const cone = new THREE.Mesh(coneGeom, coneMat);
    cone.rotation.x = Math.PI / 2;
    cone.rotation.z = pos.rotY;
    cone.position.set(pos.x, 0.1, pos.z);
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
  const coneLength = Math.min(distM * 0.8, 4);
  const coneRadius = 0.08 + (distM * 0.05);
  cone.scale.set(coneRadius / 0.15, coneLength / 0.5, coneRadius / 0.15);

  let color;
  if (distCm < 50) color = 0xff0000;
  else if (distCm < 100) color = 0xff8800;
  else if (distCm < 200) color = 0xffff00;
  else color = 0x00ffff;
  cone.material.color.setHex(color);
  cone.material.opacity = distCm < 100 ? 0.5 : 0.25;
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
  lidar3dRenderer.render(lidar3dScene, lidar3dCamera);
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
  getDistanceColor3D
};
