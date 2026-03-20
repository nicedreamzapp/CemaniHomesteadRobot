// ============ ROBOT AGENT - Claude AI Chat Interface ============
// Always-on Claude agent with full robot system access
// Accessible from web UI chat panel and SMS

const https = require('https');
const state = require('./server-state');
const WebSocket = require('ws');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-haiku-4-5-20251001';

// Conversation history per session (keeps last 20 messages)
const conversations = new Map();
const MAX_HISTORY = 20;

// ============ ROBOT CONTEXT ============
function getRobotContext() {
  const rs = state.robotStatus;
  const ts = state.teensyStatus;
  const cs = state.cameraStatus;
  const odom = state.getOdometry();
  const map = state.mapStatus;

  // Count connected clients
  const wss = state.getWss();
  let browserCount = 0, autonomousCount = 0;
  if (wss) {
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        if (c.isBrowser) browserCount++;
        if (c.isAutonomous) autonomousCount++;
      }
    });
  }

  return `You are the AI agent for the Cemani Homestead Robot. You run on the VPS server and have access to the robot's systems.

CURRENT ROBOT STATE:
- ESP32: ${rs.connected ? 'ONLINE' : 'OFFLINE'} (WiFi: ${rs.wifi}, RSSI: ${rs.rssi}dBm)
- Teensy: ${ts.connected ? 'ONLINE' : 'OFFLINE'} (v${ts.version})
- Cameras: ${cs.connected ? 'ONLINE' : 'OFFLINE'}
- Brain (autonomous): ${autonomousCount > 0 ? 'RUNNING' : 'NOT RUNNING'}
- Browsers connected: ${browserCount}
- Position: x=${odom.x}mm, y=${odom.y}mm, heading=${Math.round((odom.heading || 0) * 180 / Math.PI)}°
- Map: ${map.static_cells} static cells, ${map.total_cells} total, ${map.map_coverage}m² coverage

WHAT YOU CAN DO:
1. Answer questions about the robot, its sensors, code, and capabilities
2. Send commands to the robot (forward, backward, turn, stop, explore)
3. Check system status (battery, motors, sensors, cameras)
4. Help plan tasks and automation
5. Advise on hardware upgrades and improvements
6. Help debug issues

ROBOT HARDWARE:
- 4x 250W hub motors (1kW total), tank drive, 10" pneumatic wheels
- RPLidar A1 (360°), 4x ultrasonic sensors (FL, FR, RL, RR)
- 2x PTZ cameras (1080p), HMC5883L compass, GPS
- Teensy 4.1 (motor control) + ESP32 (WiFi) + Jetson Orin Nano (AI) + Mac Mini M1 (3D mapping)
- 24V LiFePO4 battery (720Wh)
- YOLOv8 object detection (601 classes)

AVAILABLE COMMANDS (you can tell the user to use these or trigger them):
- To move: send a brain_command via the chat
- Robot Brain API: http://localhost:5000 on the Jetson
- PM2 processes: robot (this server), robot-brain (if running)
- Server code: /opt/robot-server/

Keep responses concise and helpful. You're talking to the robot's owner via chat or text message. Be practical, not wordy.`;
}

// ============ LATEST TELEMETRY ============
// Store latest sensor readings for the agent to reference
let latestTelemetry = {};
let latestUltrasonic = {};
let latestCompass = 0;

function updateTelemetry(data) {
  if (data.type === 'teensy_telemetry') {
    latestTelemetry = {
      voltage: (data.voltage || 0) / 100,
      motorTemp1: (data.motorTemp1 || 0) / 10,
      motorTemp2: (data.motorTemp2 || 0) / 10,
      velocityL: (data.velocityL || 0) / 10,
      velocityR: (data.velocityR || 0) / 10,
      posL: data.posL || 0,
      posR: data.posR || 0,
      updated: Date.now()
    };
  } else if (data.type === 'ultrasonic') {
    latestUltrasonic = {
      fl: data.fl || 999,
      fr: data.fr || 999,
      rl: data.rl || 999,
      rr: data.rr || 999,
      updated: Date.now()
    };
  } else if (data.type === 'compass') {
    latestCompass = data.heading || 0;
  }
}

function getSensorSummary() {
  const t = latestTelemetry;
  const u = latestUltrasonic;
  if (!t.updated) return 'No telemetry data yet.';

  const age = Math.round((Date.now() - t.updated) / 1000);
  return `Battery: ${t.voltage}V | Motors: L=${t.velocityL}RPM R=${t.velocityR}RPM | Temps: ${t.motorTemp1}°C/${t.motorTemp2}°C | Ultrasonic: FL=${u.fl}cm FR=${u.fr}cm RL=${u.rl}cm RR=${u.rr}cm | Compass: ${latestCompass}° | Data age: ${age}s`;
}

// ============ CLAUDE API CALL ============
function callClaude(sessionId, userMessage) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) {
      return reject(new Error('No ANTHROPIC_API_KEY set'));
    }

    // Get or create conversation
    if (!conversations.has(sessionId)) {
      conversations.set(sessionId, []);
    }
    const history = conversations.get(sessionId);

    // Add sensor data to user message context
    const sensorInfo = getSensorSummary();
    const enrichedMessage = `${userMessage}\n\n[Live sensors: ${sensorInfo}]`;

    // Add to history
    history.push({ role: 'user', content: enrichedMessage });

    // Trim history
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: getRobotContext(),
      messages: history
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            const reply = parsed.content[0].text;
            // Add to history
            history.push({ role: 'assistant', content: reply });
            resolve(reply);
          } else if (parsed.error) {
            reject(new Error(parsed.error.message));
          } else {
            reject(new Error('Unexpected response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ HANDLE CHAT MESSAGE ============
async function handleChat(ws, data) {
  const sessionId = data.sessionId || 'default';
  const message = data.message || '';

  if (!message.trim()) return;

  try {
    const reply = await callClaude(sessionId, message);

    // Send reply to the requesting browser
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'agent_reply',
        message: reply,
        sessionId: sessionId
      }));
    }

    // Check if Claude suggested a robot command
    // Simple pattern matching for action triggers
    const lowerReply = reply.toLowerCase();
    if (lowerReply.includes('[command:') || lowerReply.includes('[action:')) {
      // Extract command between brackets
      const match = reply.match(/\[(command|action):\s*(.+?)\]/i);
      if (match) {
        const cmd = match[2].trim();
        console.log(`[AGENT] Triggering command: ${cmd}`);
        // Forward to brain
        const wss = state.getWss();
        if (wss) {
          wss.clients.forEach(c => {
            if (c.isAutonomous && c.readyState === WebSocket.OPEN) {
              c.send(JSON.stringify({ type: 'brain_command', action: 'text', value: cmd }));
            }
          });
        }
      }
    }
  } catch (err) {
    console.error('[AGENT] Error:', err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'agent_reply',
        message: `Error: ${err.message}`,
        sessionId: sessionId,
        error: true
      }));
    }
  }
}

// Clear conversation
function clearConversation(sessionId) {
  conversations.delete(sessionId || 'default');
}

module.exports = {
  handleChat,
  clearConversation,
  updateTelemetry,
  callClaude
};
