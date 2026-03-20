// ============ ROBOT AGENT - Claude AI with Tools ============
// Always-on Claude agent with real access to robot systems
// Can read code, check logs, run commands, inspect sensors

const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('./server-state');
const WebSocket = require('ws');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-haiku-4-5-20251001';
const SERVER_DIR = '/opt/robot-server';

// Conversation history per session
const conversations = new Map();
const MAX_HISTORY = 30;

// ============ LIVE TELEMETRY ============
let latestTelemetry = {};
let latestUltrasonic = {};
let latestCompass = 0;
let latestDetections = { cam1: [], cam2: [], updated: 0 };
let latestOdom = { x: 0, y: 0, heading: 0, distance: 0 };

function updateTelemetry(data) {
  if (data.type === 'teensy_telemetry') {
    latestTelemetry = {
      voltage: (data.voltage || 0) / 100,
      motorTemp1: (data.motorTemp1 || 0) / 10,
      motorTemp2: (data.motorTemp2 || 0) / 10,
      driverTemp1: (data.driverTemp1 || 0) / 10,
      driverTemp2: (data.driverTemp2 || 0) / 10,
      velocityL: (data.velocityL || 0) / 10,
      velocityR: (data.velocityR || 0) / 10,
      torqueL: (data.torqueL || 0) / 10,
      torqueR: (data.torqueR || 0) / 10,
      posL: data.posL || 0,
      posR: data.posR || 0,
      updated: Date.now()
    };
  } else if (data.type === 'ultrasonic') {
    latestUltrasonic = { fl: data.fl, fr: data.fr, rl: data.rl, rr: data.rr, updated: Date.now() };
  } else if (data.type === 'compass') {
    latestCompass = data.heading || 0;
  } else if (data.type === 'dead_reckoning') {
    latestOdom = {
      x: data.odomX || 0, y: data.odomY || 0,
      heading: data.odomHeadingDeg || 0, distance: data.odomDistance || 0,
      updated: Date.now()
    };
  } else if (data.type === 'detections' || data.type === 'DETECTIONS') {
    const cam = data.camera || 1;
    const dets = data.detections || [];
    if (cam === 1) latestDetections.cam1 = dets;
    else latestDetections.cam2 = dets;
    if (dets.length > 0) latestDetections.updated = Date.now();
  }
}

// ============ TOOLS THE AGENT CAN USE ============
const tools = [
  {
    name: "get_sensors",
    description: "Get all current sensor readings: battery voltage, motor speeds/temps, ultrasonic distances (4 corners), compass heading, odometry position, and recent object detections. Call this whenever the user asks about the robot's current state.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "read_file",
    description: "Read a file from the robot server codebase. Use to look at source code, configs, or logs. Path is relative to /opt/robot-server/ or absolute.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to /opt/robot-server/ or absolute)" },
        lines: { type: "number", description: "Max lines to read (default 100)" }
      },
      required: ["path"]
    }
  },
  {
    name: "run_command",
    description: "Run a shell command on the VPS server. Use for: checking pm2 status/logs, listing files, checking processes, network status, disk space. Do NOT run destructive commands.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (read-only, non-destructive)" }
      },
      required: ["command"]
    }
  },
  {
    name: "send_robot_command",
    description: "Send a movement command to the robot brain. Actions: forward (value=feet), backward (value=feet), turn (value=degrees, positive=right), explore, go_home, stop, status",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Command: forward, backward, turn, explore, go_home, stop, status" },
        value: { type: "string", description: "Value for command (feet for forward/back, degrees for turn)" }
      },
      required: ["action"]
    }
  },
  {
    name: "list_files",
    description: "List files in a directory on the server. Use to explore the codebase structure.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: /opt/robot-server/)" }
      },
      required: []
    }
  }
];

// ============ TOOL EXECUTION ============
function executeTool(name, input) {
  try {
    switch (name) {
      case 'get_sensors': {
        const t = latestTelemetry;
        const u = latestUltrasonic;
        const age = t.updated ? Math.round((Date.now() - t.updated) / 1000) : -1;
        const rs = state.robotStatus;
        const ts = state.teensyStatus;

        // Count connected clients
        const wss = state.getWss();
        let browsers = 0, autonomous = 0;
        if (wss) wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            if (c.isBrowser) browsers++;
            if (c.isAutonomous) autonomous++;
          }
        });

        // Recent detections summary
        let detSummary = 'none';
        const allDets = [...(latestDetections.cam1 || []), ...(latestDetections.cam2 || [])];
        if (allDets.length > 0) {
          const classes = allDets.map(d => d.class || d.label).filter(Boolean);
          detSummary = classes.length > 0 ? classes.join(', ') : `${allDets.length} objects`;
        }

        return JSON.stringify({
          connection: {
            esp32: rs.connected ? 'ONLINE' : 'OFFLINE',
            teensy: ts.connected ? 'ONLINE' : 'OFFLINE',
            wifi: rs.wifi, rssi: rs.rssi,
            brain_running: autonomous > 0,
            browsers_connected: browsers
          },
          battery: { voltage: t.voltage || 0, percent: t.voltage ? Math.round((t.voltage - 21.6) / (28.8 - 21.6) * 100) : 0 },
          motors: {
            left_rpm: t.velocityL || 0, right_rpm: t.velocityR || 0,
            left_torque: t.torqueL || 0, right_torque: t.torqueR || 0,
            motor_temp1: t.motorTemp1 || 0, motor_temp2: t.motorTemp2 || 0,
            driver_temp1: t.driverTemp1 || 0, driver_temp2: t.driverTemp2 || 0
          },
          ultrasonic_cm: { front_left: u.fl, front_right: u.fr, rear_left: u.rl, rear_right: u.rr },
          compass_degrees: latestCompass,
          odometry: {
            x_mm: latestOdom.x, y_mm: latestOdom.y,
            heading_deg: latestOdom.heading,
            total_distance_ft: Math.round(latestOdom.distance / 304.8 * 10) / 10
          },
          encoders: { left: t.posL || 0, right: t.posR || 0 },
          detections: detSummary,
          data_age_seconds: age
        }, null, 2);
      }

      case 'read_file': {
        let filePath = input.path;
        if (!filePath.startsWith('/')) filePath = path.join(SERVER_DIR, filePath);
        // Security: only allow reading in known dirs
        const allowed = ['/opt/robot-server', '/home/jetson/Desktop/CemaniHomesteadRobot', '/tmp'];
        if (!allowed.some(d => filePath.startsWith(d))) {
          return 'Error: access denied. Can only read files in robot directories.';
        }
        if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;
        const maxLines = input.lines || 100;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        if (lines.length > maxLines) {
          return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
        }
        return content;
      }

      case 'list_files': {
        const dir = input.path || SERVER_DIR;
        const allowed = ['/opt/robot-server', '/home/jetson/Desktop/CemaniHomesteadRobot'];
        if (!allowed.some(d => dir.startsWith(d))) {
          return 'Error: access denied.';
        }
        const result = execSync(`find ${dir} -maxdepth 2 -type f -name "*.js" -o -name "*.py" -o -name "*.h" -o -name "*.cpp" -o -name "*.json" -o -name "*.sh" -o -name "*.css" -o -name "*.html" 2>/dev/null | head -50`, { timeout: 5000 }).toString();
        return result || 'No files found.';
      }

      case 'run_command': {
        const cmd = input.command;
        // Block dangerous commands
        const blocked = ['rm ', 'rmdir', 'mkfs', 'dd ', 'shutdown', 'reboot', '> /', 'curl ', 'wget ', 'apt ', 'npm install', 'pip install'];
        if (blocked.some(b => cmd.includes(b))) {
          return 'Error: command blocked for safety.';
        }
        const output = execSync(cmd, { timeout: 10000, maxBuffer: 50000 }).toString();
        return output.slice(0, 3000) || '(no output)';
      }

      case 'send_robot_command': {
        const wss = state.getWss();
        if (!wss) return 'Error: no WebSocket server';
        let sent = false;
        wss.clients.forEach(c => {
          if (c.isAutonomous && c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({
              type: 'brain_command',
              action: input.action,
              value: input.value || ''
            }));
            sent = true;
          }
        });
        return sent ? `Command sent: ${input.action} ${input.value || ''}` : 'Error: robot brain is not connected. Start it with: cd /home/jetson/Desktop/CemaniHomesteadRobot/robot-brain && bash start.sh';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ============ SYSTEM PROMPT ============
function getSystemPrompt() {
  return `You are the AI agent for the Cemani Homestead Robot — an autonomous 1kW tank-drive platform built for homestead tasks.

You have TOOLS to inspect and interact with the robot. USE THEM when the user asks questions. Don't guess — look it up.

When user asks about sensors, battery, position, what's around the robot → use get_sensors
When user asks about code, how something works, config → use read_file or list_files
When user asks to check logs, processes, status → use run_command (pm2 logs, pm2 status, etc.)
When user asks to move the robot → use send_robot_command
When user asks about the codebase → use list_files then read_file

KEY SYSTEM KNOWLEDGE:
- Server: Node.js on VPS (72.60.124.34), port 3001, managed by pm2 as "robot"
- Teensy 4.1: motor control via Modbus RS-485, config in teensy-robot/include/config.h
- ESP32: WiFi bridge with Xbox controller support (Bluepad32)
- Jetson Orin Nano: YOLOv8 detection, LIDAR relay, robot brain (autonomous movement)
- Mac Mini M1: Depth Anything V2, 3D mapping, iMessage relay
- Codebase: /opt/robot-server/ (deployed) and /home/jetson/Desktop/CemaniHomesteadRobot/ (source)
- Motors: 4x ZLLG80ASM250 (250W each), ZLAC8015D drivers, 4096 encoder counts/rev
- Wheels: 10" pneumatic, 638.4mm circumference, 550mm wheelbase
- Battery: 24V LiFePO4 8S (21.6V empty, 28.8V full)
- Safety: Teensy has ultrasonic stop at 20cm, watchdog at 2s/5s
- Autonomous: AUTO_ prefix commands capped at 10 RPM, 500ms timeout auto-stop

Keep responses SHORT and useful. Use tools to get real data before answering. The owner is a builder, not a coder — be direct.`;
}

// ============ CLAUDE API CALL WITH TOOLS ============
function callClaude(sessionId, userMessage) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) return reject(new Error('No ANTHROPIC_API_KEY set. Check VPS /root/.env'));

    if (!conversations.has(sessionId)) conversations.set(sessionId, []);
    const history = conversations.get(sessionId);
    history.push({ role: 'user', content: userMessage });
    while (history.length > MAX_HISTORY) history.shift();

    function apiCall(messages) {
      const body = JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: getSystemPrompt(),
        tools: tools,
        messages: messages
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
            if (parsed.error) return reject(new Error(parsed.error.message));

            // Check if Claude wants to use tools
            if (parsed.stop_reason === 'tool_use') {
              const toolUses = parsed.content.filter(c => c.type === 'tool_use');
              const textParts = parsed.content.filter(c => c.type === 'text');

              // Add assistant message with tool calls
              history.push({ role: 'assistant', content: parsed.content });

              // Execute tools and build results
              const toolResults = toolUses.map(tu => ({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: executeTool(tu.name, tu.input)
              }));

              // Add tool results
              history.push({ role: 'user', content: toolResults });

              // Call Claude again with tool results
              apiCall(history);
              return;
            }

            // Final text response
            const textContent = parsed.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            history.push({ role: 'assistant', content: parsed.content });
            resolve(textContent || 'No response');
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    }

    apiCall(history);
  });
}

// ============ HANDLE CHAT MESSAGE ============
async function handleChat(ws, data) {
  const sessionId = data.sessionId || 'default';
  const message = data.message || '';
  if (!message.trim()) return;

  try {
    const reply = await callClaude(sessionId, message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'agent_reply', message: reply, sessionId }));
    }
  } catch (err) {
    console.error('[AGENT] Error:', err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'agent_reply', message: `Error: ${err.message}`, sessionId, error: true }));
    }
  }
}

function clearConversation(sessionId) {
  conversations.delete(sessionId || 'default');
}

module.exports = { handleChat, clearConversation, updateTelemetry, callClaude };
