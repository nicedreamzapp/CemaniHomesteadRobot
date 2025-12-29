// ============ PRIORITY PTZ CONTROL SERVER ============
// Separate WebSocket server for PTZ commands on port 3002
// Bypasses video traffic for instant PTZ response

const http = require("http");
const WebSocket = require("ws");

// PTZ relay and browser client tracking
let ptzRelaySocket = null;
let browserPtzClients = new Set();

// Create PTZ server and WebSocket
const ptzServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PTZ Control Server - Priority channel for camera control');
});

const ptzWss = new WebSocket.Server({ server: ptzServer });

// Handle PTZ WebSocket connections
ptzWss.on('connection', (ws, req) => {
  console.log('[PTZ-WS] Client connected from', req.socket.remoteAddress);

  // Enable TCP_NODELAY for instant PTZ response
  if (req.socket) {
    req.socket.setNoDelay(true);
  }

  ws.isAlive = true;
  ws.missedPings = 0;
  ws.on('pong', () => { ws.isAlive = true; ws.missedPings = 0; });

  ws.on('message', (msg) => {
    ws.isAlive = true;
    ws.missedPings = 0;

    try {
      const data = JSON.parse(msg.toString());
      console.log('[PTZ-WS] Received:', data.type);

      // Mac relay announcing itself on PTZ channel
      if (data.type === 'ptz_relay_hello') {
        ptzRelaySocket = ws;
        ws.isPtzRelay = true;
        console.log('[PTZ-WS] Mac PTZ relay connected');
        // Notify browsers
        browserPtzClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'ptz_relay_status', connected: true }));
          }
        });
        return;
      }

      // Browser announcing itself
      if (data.type === 'ptz_browser_hello') {
        ws.isBrowser = true;
        browserPtzClients.add(ws);
        console.log('[PTZ-WS] Browser connected, total:', browserPtzClients.size);
        ws.send(JSON.stringify({ type: 'ptz_relay_status', connected: !!ptzRelaySocket }));
        return;
      }

      // PTZ commands from browser -> forward to Mac relay INSTANTLY
      if (data.type === 'cam_ptz' && ptzRelaySocket && ptzRelaySocket.readyState === WebSocket.OPEN) {
        ptzRelaySocket.send(JSON.stringify(data));
        console.log('[PTZ-WS] CMD:', data.action, 'cam:', data.camera || 1);
        return;
      }

      // PTZ results from Mac relay -> forward to browsers
      if (data.type === 'cam_ptz_result' && ws.isPtzRelay) {
        browserPtzClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify(data));
          }
        });
        return;
      }

    } catch (err) {
      console.error('[PTZ-WS] Error:', err.message);
    }
  });

  ws.on('close', () => {
    if (ws.isPtzRelay) {
      ptzRelaySocket = null;
      console.log('[PTZ-WS] Mac PTZ relay disconnected');
      browserPtzClients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'ptz_relay_status', connected: false }));
        }
      });
    }
    if (ws.isBrowser) {
      browserPtzClients.delete(ws);
      console.log('[PTZ-WS] Browser disconnected, total:', browserPtzClients.size);
    }
  });

  ws.on('error', () => {
    browserPtzClients.delete(ws);
  });
});

// PTZ keepalive - faster interval for responsive control
setInterval(() => {
  ptzWss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.isPtzRelay) ptzRelaySocket = null;
      browserPtzClients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);  // 10 second ping for PTZ

// Start PTZ server
function startPtzServer(port = 3002) {
  ptzServer.listen(port, '0.0.0.0', () => {
    console.log('[PTZ-SERVER] Priority PTZ control listening on port', port);
  });
}

// Get PTZ relay socket for forwarding from main server
function getPtzRelaySocket() {
  return ptzRelaySocket;
}

module.exports = {
  startPtzServer,
  getPtzRelaySocket,
  ptzServer,
  ptzWss
};
