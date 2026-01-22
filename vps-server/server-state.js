// ============ SHARED STATE MODULE ============
// Robot, Camera, Teensy state and broadcast function

const WebSocket = require("ws");

// ============ ROBOT STATE ============
let robotSocket = null;
let robotStatus = {
  connected: false,
  version: "unknown",
  wifi: "unknown",
  rssi: 0,
  ip: "unknown",
  uptime: 0,
  controller: "none",
  lastSeen: null
};

// ============ TEENSY STATE ============
let teensyStatus = {
  connected: false,
  lastSeen: 0,
  version: "unknown"
};
const TEENSY_TIMEOUT_MS = 15000;  // Increased to prevent jumpy status

// ============ CAMERA STATE ============
let cameraSocket = null;
let cameraStatus = {
  connected: false,
  ip: "unknown",
  streaming: false
};

// ============ WIFI RELAY STATE ============
let wifiRelaySocket = null;

// ============ MAC LAUNCHER STATE ============
let macLauncherSocket = null;

// Per-camera streaming status with timeout detection
const perCameraStatus = {
  1: { streaming: false, lastFrame: 0 },
  2: { streaming: false, lastFrame: 0 }
};
const CAMERA_TIMEOUT_MS = 3000;

// ============ MAP STATE ============
let mapStatus = {
  robot_x: 0,
  robot_y: 0,
  robot_heading: 0,
  static_cells: 0,
  total_cells: 0,
  map_coverage: 0,
  updated: 0
};

// WebSocket server reference (set by main server.js)
let wss = null;

// ============ SETTERS ============
function setWss(server) {
  wss = server;
}

function setRobotSocket(socket) {
  robotSocket = socket;
}

function setCameraSocket(socket) {
  cameraSocket = socket;
}

// ============ GETTERS ============
function getRobotSocket() {
  return robotSocket;
}

function getCameraSocket() {
  return cameraSocket;
}

function getWss() {
  return wss;
}

function getOdometry() {
  return {
    x: mapStatus.robot_x || 0,
    y: mapStatus.robot_y || 0,
    heading: mapStatus.robot_heading || 0
  };
}

// ============ BROADCAST ============
// IMPORTANT: Always skip robot and camera sockets!
// The ESP32 has a small WebSocket buffer and will disconnect if overwhelmed
// with broadcasts (status updates, LIDAR data, etc) it doesn't need.
function broadcast(data, skip = null) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    // Skip the robot socket (ESP32) - it can't handle receiving broadcasts
    // Skip the camera socket - it only sends frames, doesn't need status
    // Check both the socket reference AND the isRobot/isCamera flags
    if (c === robotSocket || c === cameraSocket || c.isRobot || c.isCamera) return;
    // Send to browsers and processors (Mac Mini needs LIDAR data for accumulation)
    if (c !== skip && c.readyState === WebSocket.OPEN && (c.isBrowser || c.isProcessor)) {
      c.send(msg);
    }
  });
}

module.exports = {
  // State objects
  robotStatus,
  teensyStatus,
  cameraStatus,
  perCameraStatus,

  // Constants
  TEENSY_TIMEOUT_MS,
  CAMERA_TIMEOUT_MS,

  // Socket getters/setters
  setWss,
  setRobotSocket,
  setCameraSocket,
  getRobotSocket,
  getCameraSocket,
  getWss,
  getOdometry,

  // Map status
  mapStatus,

  // WiFi relay socket (direct access for simplicity)
  get wifiRelaySocket() { return wifiRelaySocket; },
  set wifiRelaySocket(socket) { wifiRelaySocket = socket; },

  // Mac launcher socket (GPU mapping daemon)
  get macLauncherSocket() { return macLauncherSocket; },
  set macLauncherSocket(socket) { macLauncherSocket = socket; },

  // Broadcast
  broadcast
};
