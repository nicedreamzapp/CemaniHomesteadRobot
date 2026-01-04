#!/usr/bin/env node
/**
 * CEMANI ROBOT - GPU Renderer using Puppeteer + Three.js
 * ======================================================
 *
 * Uses Mac's M4 Pro GPU via headless Chrome to render 3D scene.
 * Streams rendered frames as MJPEG to browsers.
 *
 * Your Mac's GPU does ALL rendering - browsers just show video.
 *
 * Requirements:
 *   npm install puppeteer express ws
 *
 * Usage:
 *   node gpu_renderer_puppeteer.js
 */

const puppeteer = require('puppeteer');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// Configuration
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 720;
const TARGET_FPS = 30;
const MJPEG_PORT = 8089;
const VPS_WS = 'ws://72.60.124.34:3001';

// State
let browser = null;
let page = null;
let latestFrame = null;
let pointCount = 0;
let wsConnection = null;

// HTML page with Three.js renderer
const RENDERER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; overflow: hidden; background: #0a0a12; }
    canvas { display: block; }
  </style>
</head>
<body>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script>
    // Three.js scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.Fog(0x0a0a12, 10, 30);

    const camera = new THREE.PerspectiveCamera(55, ${RENDER_WIDTH}/${RENDER_HEIGHT}, 0.1, 100);
    camera.position.set(0, 4, 5);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(${RENDER_WIDTH}, ${RENDER_HEIGHT});
    renderer.setPixelRatio(1);
    document.body.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0x404040, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(5, 10, 5);
    scene.add(dirLight);

    // Ground plane
    const groundGeom = new THREE.PlaneGeometry(30, 30);
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a1520, transparent: true, opacity: 0.7 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    scene.add(ground);

    // Robot placeholder
    const robotGeom = new THREE.BoxGeometry(0.3, 0.25, 0.4);
    const robotMat = new THREE.MeshPhongMaterial({ color: 0xc0c0c0 });
    const robot = new THREE.Mesh(robotGeom, robotMat);
    robot.position.set(0, 0.125, 0);
    scene.add(robot);

    // Point cloud (use var for hoisting)
    var pointCloud = null;

    // Camera orbit
    var angle = 0;
    const orbitRadius = 6;
    const orbitHeight = 4;
    const orbitSpeed = 0.1; // degrees per frame

    function updatePointCloud(points) {
      // Remove old point cloud
      if (pointCloud) {
        scene.remove(pointCloud);
        pointCloud.geometry.dispose();
        pointCloud.material.dispose();
      }

      if (!points || points.length === 0) return;

      const positions = [];
      const colors = [];

      for (const p of points) {
        if (p.length >= 6) {
          // Convert coordinates: [x, y, z, r, g, b]
          // Three.js: Y is up, so swap y/z
          positions.push(p[0], p[2], -p[1]);
          colors.push(p[3]/255, p[4]/255, p[5]/255);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

      const material = new THREE.PointsMaterial({
        size: 0.04,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true
      });

      pointCloud = new THREE.Points(geometry, material);
      scene.add(pointCloud);

      window.pointCount = points.length;
    }

    // Expose update function
    window.updatePointCloud = updatePointCloud;
    window.pointCount = 0;

    // Animation loop
    function animate() {
      requestAnimationFrame(animate);

      // Slowly orbit camera
      angle += orbitSpeed;
      const rad = angle * Math.PI / 180;
      camera.position.x = Math.sin(rad) * orbitRadius;
      camera.position.z = Math.cos(rad) * orbitRadius;
      camera.position.y = orbitHeight;
      camera.lookAt(0, 0.5, 0);

      renderer.render(scene, camera);
    }

    animate();
    console.log('Three.js renderer initialized');
  </script>
</body>
</html>
`;

async function initBrowser() {
  console.log('[GPU] Launching headless Chrome with GPU acceleration...');

  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=metal',  // Use Metal on macOS
      '--enable-gpu',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      `--window-size=${RENDER_WIDTH},${RENDER_HEIGHT}`,
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  page = await browser.newPage();
  await page.setViewport({ width: RENDER_WIDTH, height: RENDER_HEIGHT });

  // Load our Three.js renderer
  await page.setContent(RENDERER_HTML);
  await page.waitForFunction(() => window.updatePointCloud !== undefined, { timeout: 10000 });

  console.log('[GPU] Three.js renderer ready');
  return page;
}

async function captureFrame() {
  if (!page) return null;

  try {
    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      encoding: 'binary'
    });
    return screenshot;
  } catch (e) {
    console.error('[GPU] Capture error:', e.message);
    return null;
  }
}

async function updatePoints(points) {
  if (!page) return;

  try {
    await page.evaluate((pts) => {
      window.updatePointCloud(pts);
    }, points);
    pointCount = points.length;
    console.log(`[GPU] Updated ${pointCount.toLocaleString()} points`);
  } catch (e) {
    console.error('[GPU] Update error:', e.message);
  }
}

// Frame capture loop
async function frameLoop() {
  const frameTime = 1000 / TARGET_FPS;

  while (true) {
    const start = Date.now();

    const frame = await captureFrame();
    if (frame) {
      latestFrame = frame;
    }

    const elapsed = Date.now() - start;
    if (elapsed < frameTime) {
      await new Promise(r => setTimeout(r, frameTime - elapsed));
    }
  }
}

// MJPEG streaming server
function startMJPEGServer() {
  const app = express();
  const server = http.createServer(app);

  // Status page
  app.get('/', (req, res) => {
    res.send(`
      <html>
      <head><title>GPU Renderer</title></head>
      <body style="background:#111;color:#fff;font-family:monospace;">
        <h1>Cemani Robot - GPU Renderer</h1>
        <p>Mac M4 Pro GPU rendering @ ${RENDER_WIDTH}x${RENDER_HEIGHT} ${TARGET_FPS}fps</p>
        <p>Points: ${pointCount.toLocaleString()}</p>
        <img src="/stream.mjpg" style="max-width:100%;border:2px solid #333;">
      </body>
      </html>
    `);
  });

  // MJPEG stream
  app.get('/stream.mjpg', (req, res) => {
    console.log(`[MJPEG] Client connected from ${req.ip}`);

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendFrame = () => {
      if (latestFrame) {
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n\r\n');
        res.write(latestFrame);
        res.write('\r\n');
      }
    };

    const interval = setInterval(sendFrame, 1000 / TARGET_FPS);

    req.on('close', () => {
      clearInterval(interval);
      console.log('[MJPEG] Client disconnected');
    });
  });

  server.listen(MJPEG_PORT, () => {
    console.log(`[MJPEG] Server running at http://localhost:${MJPEG_PORT}/`);
    console.log(`[MJPEG] Stream URL: http://localhost:${MJPEG_PORT}/stream.mjpg`);
  });

  return server;
}

// WebSocket connection to VPS
async function connectToVPS() {
  const connect = () => {
    console.log(`[WS] Connecting to ${VPS_WS}...`);

    wsConnection = new WebSocket(VPS_WS);

    wsConnection.on('open', () => {
      console.log('[WS] Connected!');
      wsConnection.send(JSON.stringify({
        type: 'register_processor',
        name: 'gpu-renderer',
        capabilities: ['gpu_render', 'video_stream']
      }));

      // Start sending frames to VPS
      startFrameStreaming();
    });

    wsConnection.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'accumulated_map' && msg.points) {
          await updatePoints(msg.points);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    wsConnection.on('close', () => {
      console.log('[WS] Disconnected, reconnecting in 3s...');
      stopFrameStreaming();
      setTimeout(connect, 3000);
    });

    wsConnection.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  };

  connect();
}

// Stream frames to VPS via WebSocket
let frameStreamInterval = null;
const FRAME_STREAM_FPS = 15; // Lower FPS for WS streaming

function startFrameStreaming() {
  if (frameStreamInterval) return;

  console.log(`[WS] Starting frame streaming at ${FRAME_STREAM_FPS} FPS`);

  frameStreamInterval = setInterval(() => {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN && latestFrame) {
      // Send frame as base64 to VPS
      wsConnection.send(JSON.stringify({
        type: 'gpu_frame',
        frame: latestFrame.toString('base64'),
        width: RENDER_WIDTH,
        height: RENDER_HEIGHT,
        timestamp: Date.now()
      }));
    }
  }, 1000 / FRAME_STREAM_FPS);
}

function stopFrameStreaming() {
  if (frameStreamInterval) {
    clearInterval(frameStreamInterval);
    frameStreamInterval = null;
  }
}

// Load existing map
async function loadExistingMap() {
  const fs = require('fs');
  const mapFile = path.join(__dirname, 'confirmed_walls.json');

  if (fs.existsSync(mapFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      const points = data.points || [];

      if (points.length > 0) {
        // Convert object format to compact if needed
        const compact = points.map(p => {
          if (Array.isArray(p)) return p;
          return [p.x, p.y, p.z, p.r, p.g, p.b];
        });

        await updatePoints(compact);
        console.log(`[GPU] Loaded ${compact.length.toLocaleString()} points from map file`);
      }
    } catch (e) {
      console.error('[GPU] Failed to load map:', e.message);
    }
  }
}

// Main
async function main() {
  console.log('='.repeat(60));
  console.log('  CEMANI ROBOT - GPU RENDERER (Puppeteer + Three.js)');
  console.log('  Mac M4 Pro GPU acceleration via Metal');
  console.log('='.repeat(60));
  console.log();

  // Initialize browser
  await initBrowser();

  // Start MJPEG server
  startMJPEGServer();

  // Load existing map
  await loadExistingMap();

  // Connect to VPS for live updates
  connectToVPS();

  // Start frame capture loop
  frameLoop();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
