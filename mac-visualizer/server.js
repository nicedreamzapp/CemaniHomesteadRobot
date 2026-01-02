// ============ HYBRID LIDAR + CAMERA VISUALIZER ============
// Runs on Mac Mini M4 Pro - heavy 3D processing
// Connects to VPS for data, serves visualization locally

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// VPS WebSocket URL
const VPS_WS = 'ws://72.60.124.34:3001';

// State
let vpsConnection = null;
let lidarPoints = [];
let cameraFrames = { 1: null, 2: null };
let robotPose = { x: 0, y: 0, heading: 0 };
let mapCells = { static: [], dynamic: [], free: [] };
let connectedClients = new Set();

// Accumulated point cloud for building the map
let accumulatedPoints = [];
const MAX_ACCUMULATED_POINTS = 50000;

// Camera frame history with positions
let frameHistory = [];
const MAX_FRAME_HISTORY = 100;

// ============ VPS CONNECTION ============
function connectToVPS() {
  console.log('[VPS] Connecting to', VPS_WS);

  try {
    vpsConnection = new WebSocket(VPS_WS);

    vpsConnection.on('open', () => {
      console.log('[VPS] Connected!');
      // Register as a visualizer client
      vpsConnection.send(JSON.stringify({
        type: 'get_status'
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
  // Handle binary data (camera frames)
  if (data instanceof Buffer) {
    // Check frame header
    if (data.length > 2) {
      const camId = data[0];
      if (camId === 1 || camId === 2) {
        const frameData = data.slice(1);
        cameraFrames[camId] = frameData;

        // Store frame with current position
        if (frameHistory.length >= MAX_FRAME_HISTORY) {
          frameHistory.shift();
        }
        frameHistory.push({
          camId,
          frame: frameData.toString('base64'),
          pose: { ...robotPose },
          timestamp: Date.now()
        });

        // Broadcast to local clients
        broadcastToClients({
          type: 'camera_frame',
          camera: camId,
          frame: frameData.toString('base64')
        });
      }
    }
    return;
  }

  try {
    const msg = JSON.parse(data.toString());

    // LIDAR data
    if (msg.type === 'lidar') {
      lidarPoints = msg.points || [];

      // Accumulate points in world coordinates
      accumulatePoints(lidarPoints);

      // Broadcast to local clients
      broadcastToClients({
        type: 'lidar',
        points: lidarPoints,
        accumulated: accumulatedPoints.length
      });
    }

    // Dead reckoning (robot position)
    if (msg.type === 'dead_reckoning') {
      robotPose.x = msg.x || 0;
      robotPose.y = msg.y || 0;
      robotPose.heading = msg.heading || 0;

      broadcastToClients({
        type: 'robot_pose',
        ...robotPose
      });
    }

    // Map cells from autonomous
    if (msg.type === 'map_cells') {
      mapCells = {
        static: msg.static || [],
        dynamic: msg.dynamic || [],
        free: msg.free || [],
        resolution: msg.resolution || 0.05
      };

      broadcastToClients({
        type: 'map_cells',
        ...mapCells
      });
    }

    // Map status
    if (msg.type === 'map_status') {
      broadcastToClients({
        type: 'map_status',
        robot_x: msg.robot_x,
        robot_y: msg.robot_y,
        robot_heading: msg.robot_heading,
        static_cells: msg.static_cells,
        total_cells: msg.total_cells
      });
    }

    // Semantic map data
    if (msg.type === 'semantic_map_data') {
      broadcastToClients(msg);
    }

    // Lookable targets
    if (msg.type === 'lookable_targets') {
      broadcastToClients(msg);
    }

  } catch (err) {
    // Ignore parse errors
  }
}

function accumulatePoints(points) {
  // Convert LIDAR points to world coordinates and accumulate
  const headingRad = robotPose.heading * Math.PI / 180;

  for (const p of points) {
    const angle = p[0];
    const dist = p[1];

    if (dist < 100 || dist > 8000) continue; // Filter invalid

    // Convert to world coordinates (mm to m)
    const angleRad = (angle * Math.PI / 180) + headingRad;
    const worldX = robotPose.x / 100 + (dist / 1000) * Math.cos(angleRad);
    const worldY = robotPose.y / 100 + (dist / 1000) * Math.sin(angleRad);

    // Add with some subsampling to avoid duplicates
    const key = `${Math.round(worldX * 10)}_${Math.round(worldY * 10)}`;

    accumulatedPoints.push({
      x: worldX,
      y: worldY,
      z: 0,
      intensity: Math.min(dist / 5000, 1)
    });
  }

  // Trim to max size
  if (accumulatedPoints.length > MAX_ACCUMULATED_POINTS) {
    accumulatedPoints = accumulatedPoints.slice(-MAX_ACCUMULATED_POINTS);
  }
}

// ============ LOCAL CLIENTS ============
function broadcastToClients(msg) {
  const data = JSON.stringify(msg);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('[LOCAL] Client connected');
  connectedClients.add(ws);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    robotPose,
    accumulatedPointCount: accumulatedPoints.length,
    frameHistoryCount: frameHistory.length,
    mapCells
  }));

  // Send accumulated point cloud
  ws.send(JSON.stringify({
    type: 'accumulated_points',
    points: accumulatedPoints
  }));

  // Send frame history
  ws.send(JSON.stringify({
    type: 'frame_history',
    frames: frameHistory.slice(-20) // Last 20 frames
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Request full accumulated map
      if (msg.type === 'get_accumulated') {
        ws.send(JSON.stringify({
          type: 'accumulated_points',
          points: accumulatedPoints
        }));
      }

      // Clear accumulated points
      if (msg.type === 'clear_map') {
        accumulatedPoints = [];
        frameHistory = [];
        broadcastToClients({ type: 'map_cleared' });
      }

      // Forward commands to VPS
      if (msg.type === 'look_at' || msg.type === 'semantic_map_request' ||
          msg.type === 'lookable_targets_request') {
        if (vpsConnection && vpsConnection.readyState === WebSocket.OPEN) {
          vpsConnection.send(JSON.stringify(msg));
        }
      }

    } catch (err) {
      // Ignore
    }
  });

  ws.on('close', () => {
    console.log('[LOCAL] Client disconnected');
    connectedClients.delete(ws);
  });
});

// ============ STATIC FILES ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ START ============
const PORT = 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('  HYBRID LIDAR + CAMERA VISUALIZER');
  console.log('  Mac Mini M4 Pro - 64GB');
  console.log('='.repeat(50));
  console.log('');
  console.log(`  Open: http://localhost:${PORT}`);
  console.log('');

  // Connect to VPS
  connectToVPS();
});
