// ============ MAC MINI LIDAR + CAMERA PROCESSOR ============
// Runs on Mac Mini M4 Pro - heavy 3D processing
// Connects to VPS, processes data, sends accumulated map back to VPS
// Result displayed on robot.marijuanaunion.com

const WebSocket = require('ws');

// VPS WebSocket URL
const VPS_WS = 'ws://YOUR_VPS_IP:3001';

// State
let vpsConnection = null;
let robotPose = { x: 0, y: 0, heading: 0 };

// Accumulated point cloud for building the map
let accumulatedPoints = new Map(); // Use Map for deduplication
const MAX_ACCUMULATED_POINTS = 50000;
const GRID_RESOLUTION = 10; // 10cm grid for deduplication

// Camera frame history with positions
let frameHistory = [];
const MAX_FRAME_HISTORY = 50;

// Periodic send timer
let lastSendTime = 0;
const SEND_INTERVAL = 2000; // Send every 2 seconds

// ============ VPS CONNECTION ============
function connectToVPS() {
  console.log('[VPS] Connecting to', VPS_WS);

  try {
    vpsConnection = new WebSocket(VPS_WS);

    vpsConnection.on('open', () => {
      console.log('[VPS] Connected!');
      // Register as a processor client
      vpsConnection.send(JSON.stringify({
        type: 'register_processor',
        name: 'mac-mini-m4'
      }));
    });

    vpsConnection.on('message', (data) => {
      handleVPSMessage(data);
    });

    vpsConnection.on('close', () => {
      console.log('[VPS] Disconnected, reconnecting in 3s...');
      vpsConnection = null;
      setTimeout(connectToVPS, 3000);
    });

    vpsConnection.on('error', (err) => {
      console.log('[VPS] Error:', err.message);
    });

  } catch (err) {
    console.log('[VPS] Connection failed:', err.message);
    setTimeout(connectToVPS, 3000);
  }
}

function handleVPSMessage(data) {
  // Convert Buffer to string for JSON parsing
  const str = data.toString();

  // Check if this is binary camera frame data (starts with byte 0, 1, 2, or 3)
  // Camera frames are binary JPEG data, not JSON
  if (data instanceof Buffer && data.length > 100) {
    const firstByte = data[0];
    // Camera packet types: 0=cam1 video, 1=cam1 audio, 2=cam2 video, 3=cam2 audio
    if (firstByte >= 0 && firstByte <= 3 && !str.startsWith('{')) {
      const camId = Math.floor(firstByte / 2) + 1;
      const isVideo = firstByte % 2 === 0;

      if (isVideo && data.length > 100) {
        const frameData = data.slice(1);

        // Store frame with current position (only keep recent ones)
        if (frameHistory.length >= MAX_FRAME_HISTORY) {
          frameHistory.shift();
        }
        frameHistory.push({
          camId,
          frame: frameData.toString('base64'),
          pose: { ...robotPose },
          timestamp: Date.now()
        });
      }
      return;
    }
  }

  try {
    const msg = JSON.parse(data.toString());

    // LIDAR data - accumulate points
    if (msg.type === 'lidar') {
      const points = msg.points || [];
      accumulatePoints(points);

      // Periodically send accumulated data to VPS
      const now = Date.now();
      if (now - lastSendTime > SEND_INTERVAL) {
        sendAccumulatedData();
        lastSendTime = now;
      }
    }

    // Dead reckoning (robot position) - VPS sends odomX/odomY/odomHeading
    if (msg.type === 'dead_reckoning') {
      robotPose.x = msg.odomX || msg.x || 0;
      robotPose.y = msg.odomY || msg.y || 0;
      robotPose.heading = msg.odomHeadingDeg || msg.heading || 0;
      // console.log('[POSE] Updated:', robotPose);
    }

  } catch (err) {
    // Ignore parse errors
  }
}

function accumulatePoints(points) {
  // Convert LIDAR points to world coordinates and accumulate with deduplication
  const headingRad = robotPose.heading * Math.PI / 180;

  for (const p of points) {
    const angle = p[0];
    const dist = p[1];

    if (dist < 100 || dist > 8000) continue; // Filter invalid

    // Convert to world coordinates (mm to m)
    const angleRad = (angle * Math.PI / 180) + headingRad;
    const worldX = robotPose.x / 100 + (dist / 1000) * Math.cos(angleRad);
    const worldY = robotPose.y / 100 + (dist / 1000) * Math.sin(angleRad);

    // Grid-based deduplication key (10cm grid)
    const gridX = Math.round(worldX * GRID_RESOLUTION);
    const gridY = Math.round(worldY * GRID_RESOLUTION);
    const key = `${gridX}_${gridY}`;

    // Only add if not already in map, or update with better intensity
    if (!accumulatedPoints.has(key)) {
      accumulatedPoints.set(key, {
        x: worldX,
        y: worldY,
        z: 0,
        intensity: Math.min(dist / 5000, 1),
        count: 1
      });
    } else {
      // Increment count (more observations = more confident)
      const existing = accumulatedPoints.get(key);
      existing.count++;
    }
  }

  // Trim to max size (remove oldest by converting to array and back)
  if (accumulatedPoints.size > MAX_ACCUMULATED_POINTS) {
    const entries = Array.from(accumulatedPoints.entries());
    // Sort by count (keep most observed points)
    entries.sort((a, b) => b[1].count - a[1].count);
    accumulatedPoints = new Map(entries.slice(0, MAX_ACCUMULATED_POINTS));
  }
}

function sendAccumulatedData() {
  if (!vpsConnection || vpsConnection.readyState !== WebSocket.OPEN) return;

  // Convert accumulated points Map to array
  const pointsArray = Array.from(accumulatedPoints.values());

  console.log(`[PROC] Sending ${pointsArray.length} accumulated points, ${frameHistory.length} frames`);

  // Send accumulated point cloud
  vpsConnection.send(JSON.stringify({
    type: 'accumulated_map',
    points: pointsArray,
    pointCount: pointsArray.length,
    frameCount: frameHistory.length,
    robotPose: robotPose
  }));

  // Send frame history (only last 20 frames to save bandwidth)
  if (frameHistory.length > 0) {
    vpsConnection.send(JSON.stringify({
      type: 'frame_history',
      frames: frameHistory.slice(-20)
    }));
  }
}

// ============ START ============
console.log('');
console.log('='.repeat(50));
console.log('  MAC MINI LIDAR + CAMERA PROCESSOR');
console.log('  M4 Pro - 64GB');
console.log('='.repeat(50));
console.log('');
console.log('  Processing data and sending to VPS');
console.log('  View at: https://robot.marijuanaunion.com');
console.log('');

// Connect to VPS
connectToVPS();

// Keep process alive
setInterval(() => {
  console.log(`[STATUS] Points: ${accumulatedPoints.size}, Frames: ${frameHistory.length}, Connected: ${vpsConnection?.readyState === WebSocket.OPEN}`);
}, 30000);
