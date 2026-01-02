// ============ HYBRID LIDAR + CAMERA VISUALIZER ============
// Three.js visualization with accumulated point cloud and camera frames

// ============ THREE.JS SETUP ============
const canvas = document.getElementById('canvas3d');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 0);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// ============ LIGHTING ============
const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(5, 10, 5);
scene.add(directionalLight);

// ============ GRID ============
const gridHelper = new THREE.GridHelper(50, 50, 0x333333, 0x222222);
scene.add(gridHelper);

// ============ ROBOT MARKER ============
const robotGeometry = new THREE.ConeGeometry(0.3, 0.6, 8);
robotGeometry.rotateX(Math.PI / 2);
const robotMaterial = new THREE.MeshPhongMaterial({ color: 0x00ff88 });
const robotMesh = new THREE.Mesh(robotGeometry, robotMaterial);
robotMesh.position.y = 0.3;
scene.add(robotMesh);

// ============ POINT CLOUD ============
const MAX_POINTS = 100000;
const pointsGeometry = new THREE.BufferGeometry();
const positions = new Float32Array(MAX_POINTS * 3);
const colors = new Float32Array(MAX_POINTS * 3);
pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
pointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

const pointsMaterial = new THREE.PointsMaterial({
  size: 0.08,
  vertexColors: true,
  sizeAttenuation: true
});
const pointCloud = new THREE.Points(pointsGeometry, pointsMaterial);
scene.add(pointCloud);

let pointCount = 0;

// ============ LIVE LIDAR POINTS ============
const livePointsGeometry = new THREE.BufferGeometry();
const livePositions = new Float32Array(3600 * 3);
const liveColors = new Float32Array(3600 * 3);
livePointsGeometry.setAttribute('position', new THREE.BufferAttribute(livePositions, 3));
livePointsGeometry.setAttribute('color', new THREE.BufferAttribute(liveColors, 3));

const livePointsMaterial = new THREE.PointsMaterial({
  size: 0.12,
  vertexColors: true,
  sizeAttenuation: true
});
const livePointCloud = new THREE.Points(livePointsGeometry, livePointsMaterial);
scene.add(livePointCloud);

// ============ FRAME MARKERS (Photo positions) ============
const frameMarkers = new THREE.Group();
scene.add(frameMarkers);

// ============ STATE ============
let robotPose = { x: 0, y: 0, heading: 0 };
let followRobot = false;
let showFrames = true;
let viewMode = 'topdown';
let frameHistory = [];

// ============ WEBSOCKET ============
const ws = new WebSocket(`ws://${location.host}`);

ws.onopen = () => {
  console.log('[WS] Connected to Mac visualizer server');
  document.getElementById('connection').className = 'connected';
  document.getElementById('connection').textContent = 'CONNECTED';
};

ws.onclose = () => {
  console.log('[WS] Disconnected');
  document.getElementById('connection').className = 'disconnected';
  document.getElementById('connection').textContent = 'Disconnected - Reconnecting...';
  setTimeout(() => location.reload(), 3000);
};

ws.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  } catch (err) {
    console.error('[WS] Parse error:', err);
  }
};

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      document.getElementById('pointCount').textContent = msg.accumulatedPointCount.toLocaleString();
      document.getElementById('frameCount').textContent = msg.frameHistoryCount;
      break;

    case 'lidar':
      updateLivePoints(msg.points);
      document.getElementById('pointCount').textContent = msg.accumulated.toLocaleString();
      break;

    case 'robot_pose':
      robotPose = { x: msg.x, y: msg.y, heading: msg.heading };
      updateRobotMesh();
      document.getElementById('robotX').textContent = (msg.x / 100).toFixed(2) + 'm';
      document.getElementById('robotY').textContent = (msg.y / 100).toFixed(2) + 'm';
      document.getElementById('robotHeading').textContent = msg.heading.toFixed(1) + '°';
      break;

    case 'accumulated_points':
      loadAccumulatedPoints(msg.points);
      break;

    case 'frame_history':
      frameHistory = msg.frames;
      updateFrameMarkers();
      document.getElementById('frameCount').textContent = frameHistory.length;
      break;

    case 'camera_frame':
      updateCameraView(msg.camera, msg.frame);
      break;

    case 'map_cleared':
      clearLocalMap();
      break;
  }
}

// ============ POINT CLOUD UPDATES ============
function updateLivePoints(points) {
  const posAttr = livePointsGeometry.attributes.position;
  const colAttr = livePointsGeometry.attributes.color;
  const headingRad = robotPose.heading * Math.PI / 180;

  let idx = 0;
  for (const p of points) {
    if (idx >= 3600) break;

    const angle = p[0];
    const dist = p[1];

    if (dist < 100 || dist > 8000) continue;

    // Convert to world coordinates
    const angleRad = (angle * Math.PI / 180) + headingRad;
    const worldX = robotPose.x / 100 + (dist / 1000) * Math.cos(angleRad);
    const worldZ = robotPose.y / 100 + (dist / 1000) * Math.sin(angleRad);

    posAttr.array[idx * 3] = worldX;
    posAttr.array[idx * 3 + 1] = 0.1;
    posAttr.array[idx * 3 + 2] = worldZ;

    // Color based on distance (green close, blue far)
    const intensity = Math.min(dist / 5000, 1);
    colAttr.array[idx * 3] = 0;
    colAttr.array[idx * 3 + 1] = 1 - intensity * 0.5;
    colAttr.array[idx * 3 + 2] = intensity;

    idx++;
  }

  // Clear remaining points
  for (let i = idx; i < 3600; i++) {
    posAttr.array[i * 3 + 1] = -100;
  }

  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  livePointsGeometry.setDrawRange(0, idx);
}

function loadAccumulatedPoints(points) {
  const posAttr = pointsGeometry.attributes.position;
  const colAttr = pointsGeometry.attributes.color;

  pointCount = Math.min(points.length, MAX_POINTS);

  for (let i = 0; i < pointCount; i++) {
    const p = points[i];
    posAttr.array[i * 3] = p.x;
    posAttr.array[i * 3 + 1] = p.z || 0;
    posAttr.array[i * 3 + 2] = p.y;

    // Color gradient
    const intensity = p.intensity || 0.5;
    colAttr.array[i * 3] = 0.2;
    colAttr.array[i * 3 + 1] = 0.6 + intensity * 0.4;
    colAttr.array[i * 3 + 2] = 0.8;
  }

  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  pointsGeometry.setDrawRange(0, pointCount);

  document.getElementById('pointCount').textContent = pointCount.toLocaleString();
}

// ============ ROBOT MESH ============
function updateRobotMesh() {
  robotMesh.position.x = robotPose.x / 100;
  robotMesh.position.z = robotPose.y / 100;
  robotMesh.rotation.y = -robotPose.heading * Math.PI / 180;

  if (followRobot) {
    if (viewMode === 'topdown') {
      camera.position.x = robotMesh.position.x;
      camera.position.z = robotMesh.position.z;
    } else {
      // Behind and above robot
      const offset = 3;
      camera.position.x = robotMesh.position.x - offset * Math.sin(robotMesh.rotation.y);
      camera.position.z = robotMesh.position.z - offset * Math.cos(robotMesh.rotation.y);
      camera.position.y = 2;
      camera.lookAt(robotMesh.position);
    }
  }
}

// ============ FRAME MARKERS ============
function updateFrameMarkers() {
  // Clear existing
  while (frameMarkers.children.length) {
    frameMarkers.remove(frameMarkers.children[0]);
  }

  if (!showFrames) return;

  for (const frame of frameHistory) {
    // Create a sprite with the camera image
    const texture = new THREE.TextureLoader().load('data:image/jpeg;base64,' + frame.frame);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9
    });
    const sprite = new THREE.Sprite(material);

    // Position at capture location
    sprite.position.x = frame.pose.x / 100;
    sprite.position.y = 0.5;
    sprite.position.z = frame.pose.y / 100;
    sprite.scale.set(0.8, 0.5, 1);

    frameMarkers.add(sprite);
  }
}

// ============ CAMERA VIEWS ============
function updateCameraView(camId, frameBase64) {
  const img = document.getElementById('cam' + camId);
  if (img) {
    img.src = 'data:image/jpeg;base64,' + frameBase64;
  }
}

// ============ CONTROLS ============
document.getElementById('btnTopDown').onclick = () => {
  viewMode = 'topdown';
  camera.position.set(robotMesh.position.x, 15, robotMesh.position.z);
  camera.lookAt(robotMesh.position.x, 0, robotMesh.position.z);
  updateButtonStates();
};

document.getElementById('btnPerspective').onclick = () => {
  viewMode = 'perspective';
  camera.position.set(robotMesh.position.x + 5, 5, robotMesh.position.z + 5);
  camera.lookAt(robotMesh.position);
  updateButtonStates();
};

document.getElementById('btnFollowRobot').onclick = () => {
  followRobot = !followRobot;
  updateButtonStates();
};

document.getElementById('btnShowFrames').onclick = () => {
  showFrames = !showFrames;
  updateFrameMarkers();
  updateButtonStates();
};

document.getElementById('btnClearMap').onclick = () => {
  if (confirm('Clear the accumulated map?')) {
    ws.send(JSON.stringify({ type: 'clear_map' }));
  }
};

function updateButtonStates() {
  document.getElementById('btnTopDown').className = viewMode === 'topdown' ? 'btn active' : 'btn';
  document.getElementById('btnPerspective').className = viewMode === 'perspective' ? 'btn active' : 'btn';
  document.getElementById('btnFollowRobot').className = followRobot ? 'btn active' : 'btn';
  document.getElementById('btnShowFrames').className = showFrames ? 'btn active' : 'btn';
}

function clearLocalMap() {
  // Clear accumulated points
  const posAttr = pointsGeometry.attributes.position;
  for (let i = 0; i < MAX_POINTS * 3; i++) {
    posAttr.array[i] = 0;
  }
  posAttr.needsUpdate = true;
  pointsGeometry.setDrawRange(0, 0);
  pointCount = 0;

  // Clear frame markers
  while (frameMarkers.children.length) {
    frameMarkers.remove(frameMarkers.children[0]);
  }
  frameHistory = [];

  document.getElementById('pointCount').textContent = '0';
  document.getElementById('frameCount').textContent = '0';
}

// ============ MOUSE CONTROLS ============
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  previousMousePosition = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging) return;

  const deltaX = e.clientX - previousMousePosition.x;
  const deltaY = e.clientY - previousMousePosition.y;

  if (viewMode === 'topdown') {
    camera.position.x -= deltaX * 0.02;
    camera.position.z -= deltaY * 0.02;
  } else {
    // Orbit around target
    const target = robotMesh.position.clone();
    const offset = camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= deltaX * 0.01;
    spherical.phi -= deltaY * 0.01;
    spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
    offset.setFromSpherical(spherical);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }

  previousMousePosition = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('mouseup', () => isDragging = false);
canvas.addEventListener('mouseleave', () => isDragging = false);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (viewMode === 'topdown') {
    camera.position.y += e.deltaY * 0.01;
    camera.position.y = Math.max(2, Math.min(50, camera.position.y));
  } else {
    const direction = camera.position.clone().sub(robotMesh.position).normalize();
    camera.position.add(direction.multiplyScalar(e.deltaY * 0.01));
  }
}, { passive: false });

// ============ RESIZE ============
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============ ANIMATION LOOP ============
function animate() {
  requestAnimationFrame(animate);

  if (viewMode === 'topdown' && !isDragging) {
    camera.lookAt(camera.position.x, 0, camera.position.z);
  }

  renderer.render(scene, camera);
}

animate();
