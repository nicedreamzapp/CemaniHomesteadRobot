/*
 * Cemani Robot Controller v3.8.0
 * ESP32 with Bluepad32 (Xbox) + WiFi + WebSocket + WIRELESS OTA
 * Upload via Arduino IDE with Bluepad32 board package
 *
 * v3.8.0 - AGGRESSIVE XBOX SCANNING - polls 5x per loop until connected
 *        - Re-enables Bluetooth scan every 2s when no controller
 *        - Instant re-scan on disconnect for fast reconnection
 * v3.7.0 - Instant Xbox controller connection at boot
 * v3.3.0 - WIRELESS OTA for ESP32! Never need USB again
 *        - Aerospace-grade deadzone (50) to eliminate stick drift
 * v3.2.1 - Fix OTA flash: disable keepalive/gamepad during flash mode
 * v3.2.0 - Keepalive heartbeat to Teensy for watchdog safety
 * v3.1.0 - Fix D-pad PTZ: use Arduino String for websocket (was corrupting with char*)
 * v3.0.9 - Xbox D-pad controls camera PTZ, Y button toggles camera 1/2
 *
 * SETUP: Copy credentials.h.example to credentials.h and add your WiFi passwords
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <ArduinoOTA.h>  // ESP32 wireless updates
#include <Bluepad32.h>
#include <nvs_flash.h>
#include "credentials.h"  // WiFi credentials (gitignored)

#define TEENSY_TX 17
#define TEENSY_RX 16
HardwareSerial teensySerial(1);

WiFiMulti wifiMulti;
WebSocketsClient webSocket;
GamepadPtr myGamepad = nullptr;

bool wsConnected = false;
unsigned long lastWiFiCheck = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastWiFiConnected = 0;
unsigned long lastTeensyKeepalive = 0;
unsigned long lastXboxScanLog = 0;
int wifiDropCount = 0;
const unsigned long WIFI_CHECK_INTERVAL = 2000;   // Check WiFi more often (was 10s)
const unsigned long HEARTBEAT_INTERVAL = 10000;   // Send telemetry every 10s (was 15s)
const unsigned long WIFI_RECONNECT_TIMEOUT = 3000; // Force reconnect if down >3s
const unsigned long TEENSY_KEEPALIVE_INTERVAL = 1000; // Send keepalive to Teensy every 1s
const unsigned long XBOX_SCAN_LOG_INTERVAL = 5000; // Log Xbox scan status every 5s

int16_t plx = 0, ply = 0, prx = 0, pry = 0;
int16_t plt = 0, prt = 0;
uint16_t pbtn = 0;
int8_t pdpad = -2;
int activePtzCamera = 1;  // 1 or 2, Y button toggles

// Flash mode state - MUST be declared before loop() uses it
bool flashMode = false;
int hexLinesReceived = 0;

// AEROSPACE-GRADE DEADZONE - eliminates ALL stick drift
// Xbox controllers drift 30-50 units after hours of use
#define AXIS_DZ       50    // Deadzone for raw axis values (was 15 - too small!)
#define AXIS_CHANGE   10    // Minimum change to send update
#define TRIG_CHANGE   8     // Trigger change threshold
#define JOYSTICK_SEND_DZ  60  // Must exceed this to send joystick commands

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length);
void onConnectedGamepad(GamepadPtr gp);
void onDisconnectedGamepad(GamepadPtr gp);
void sendTelemetry();
void handleGamepad();
void forwardTeensySerial();
void handleFlashMessage(uint8_t* payload, size_t length);

static inline int16_t deadzone(int v) {
  return (abs(v) <= AXIS_DZ) ? 0 : v;
}

void setup() {
  Serial.begin(115200);
  delay(100);  // Minimal delay for serial init
  Serial.println("\n[ESP32] Cemani Robot Controller v3.8.0 - AGGRESSIVE XBOX SCAN!");

  // Initialize NVS - keeps paired Bluetooth devices for instant reconnection
  nvs_flash_init();

  teensySerial.begin(115200, SERIAL_8N1, TEENSY_RX, TEENSY_TX);

  // Initialize Bluepad32 IMMEDIATELY - no delays
  BP32.setup(&onConnectedGamepad, &onDisconnectedGamepad);
  BP32.enableNewBluetoothConnections(true);

  // Aggressive Xbox scan - poll every 25ms for up to 3 seconds
  // Paired controllers typically reconnect in <500ms
  Serial.println("[BP32] Scanning for Xbox...");
  for (int i = 0; i < 120; i++) {  // 3 seconds max (120 x 25ms)
    BP32.update();
    if (myGamepad) {
      Serial.printf("[BP32] Xbox connected in %dms!\n", i * 25);
      break;
    }
    delay(25);
  }

  Serial.println("[WiFi] Connecting...");
  wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);
  wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);
  wifiMulti.addAP(WIFI_SSID_3, WIFI_PASS_3);

  int attempts = 0;
  while (wifiMulti.run() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
    BP32.update();
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected to %s\n", WiFi.SSID().c_str());
    Serial.printf("[WiFi] IP: %s, RSSI: %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    lastWiFiConnected = millis();

    // ===== WIRELESS OTA SETUP =====
    // This allows ESP32 updates over WiFi - no more USB needed!
    ArduinoOTA.setHostname("cemani-esp32");
    ArduinoOTA.setPassword("cemani2024");  // OTA password

    ArduinoOTA.onStart([]() {
      String type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
      Serial.println("[OTA] Start updating " + type);
    });

    ArduinoOTA.onEnd([]() {
      Serial.println("\n[OTA] Update complete! Rebooting...");
    });

    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
      Serial.printf("[OTA] Progress: %u%%\r", (progress / (total / 100)));
    });

    ArduinoOTA.onError([](ota_error_t error) {
      Serial.printf("[OTA] Error[%u]: ", error);
      if (error == OTA_AUTH_ERROR) Serial.println("Auth Failed");
      else if (error == OTA_BEGIN_ERROR) Serial.println("Begin Failed");
      else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
      else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
      else if (error == OTA_END_ERROR) Serial.println("End Failed");
    });

    ArduinoOTA.begin();
    Serial.println("[OTA] Wireless updates enabled! Use Arduino IDE or platformio");
  } else {
    Serial.println("\n[WiFi] Failed - controller still works!");
  }

  webSocket.beginSSL("robot.marijuanaunion.com", 443, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
  // Heartbeat: ping every 30s, allow 15s for response, disconnect after 5 missed
  // Very tolerant to prevent bouncing on/offline
  webSocket.enableHeartbeat(30000, 15000, 5);

  Serial.println("[SYSTEM] Ready!");
}

void loop() {
  unsigned long now = millis();

  // XBOX PRIORITY: If no controller, poll Bluetooth aggressively
  // This is the key to fast Xbox connection - don't let WiFi slow us down
  if (!myGamepad) {
    // Aggressive Bluetooth polling - multiple updates per loop iteration
    for (int i = 0; i < 5; i++) {
      BP32.update();
      if (myGamepad) break;  // Connected! Stop polling
      delayMicroseconds(500);  // 0.5ms between polls
    }

    // Re-enable scanning periodically in case it got disabled
    static unsigned long lastScanEnable = 0;
    if (now - lastScanEnable > 2000) {
      BP32.enableNewBluetoothConnections(true);
      lastScanEnable = now;
    }

    // Log scanning status every 5 seconds
    if (now - lastXboxScanLog > XBOX_SCAN_LOG_INTERVAL) {
      Serial.println("[BP32] Scanning for Xbox controller...");
      lastXboxScanLog = now;
    }
  } else {
    // Controller connected - normal single update
    BP32.update();
  }

  webSocket.loop();
  ArduinoOTA.handle();  // Check for wireless OTA updates

  // More aggressive WiFi monitoring
  if (now - lastWiFiCheck > WIFI_CHECK_INTERVAL) {
    lastWiFiCheck = now;
    if (WiFi.status() == WL_CONNECTED) {
      lastWiFiConnected = now;
      if (wifiDropCount > 0) {
        Serial.printf("[WiFi] Reconnected after %d drops! RSSI: %d\n", wifiDropCount, WiFi.RSSI());
        wifiDropCount = 0;
      }
    } else {
      wifiDropCount++;
      Serial.printf("[WiFi] Disconnected! Attempt %d...\n", wifiDropCount);

      // Force WiFi reconnect
      if (now - lastWiFiConnected > WIFI_RECONNECT_TIMEOUT) {
        Serial.println("[WiFi] Forcing disconnect/reconnect...");
        WiFi.disconnect(true);
        delay(100);
      }
      wifiMulti.run();
    }
  }

  if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendTelemetry();
    lastHeartbeat = now;
  }

  // Send keepalive to Teensy to prevent watchdog timeout
  // This ensures Teensy knows ESP32 is alive even when no Xbox input
  // IMPORTANT: Don't send keepalives during flash mode - they corrupt the hex stream!
  if (!flashMode && now - lastTeensyKeepalive > TEENSY_KEEPALIVE_INTERVAL) {
    teensySerial.println("KEEPALIVE");
    lastTeensyKeepalive = now;
  }

  // Don't handle gamepad during flash mode - avoid sending commands to Teensy
  if (!flashMode) {
    handleGamepad();
  }
  forwardTeensySerial();

  // Only delay when controller is connected - maximize scan speed otherwise
  if (myGamepad) {
    delay(1);
  }
}

void onConnectedGamepad(GamepadPtr gp) {
  myGamepad = gp;
  Serial.println("[BP32] XBOX CONNECTED!");
  teensySerial.println("STATE,CONNECTED");
  if (wsConnected) {
    webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Xbox Connected\"}");
  }
}

void onDisconnectedGamepad(GamepadPtr gp) {
  if (myGamepad == gp) {
    myGamepad = nullptr;
    Serial.println("[BP32] XBOX DISCONNECTED - Restarting scan immediately");
    teensySerial.println("STATE,DISCONNECTED");
    teensySerial.println("AX,LX,0,0");
    teensySerial.println("AX,LY,0,0");

    // Immediately re-enable scanning for fast reconnection
    BP32.enableNewBluetoothConnections(true);

    if (wsConnected) {
      webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Xbox Disconnected - Scanning...\"}");
    }
  }
}

void handleGamepad() {
  if (!(myGamepad && myGamepad->isConnected())) return;

  uint32_t ms = millis();
  int16_t lx = deadzone(myGamepad->axisX());
  int16_t ly = deadzone(myGamepad->axisY());
  int16_t rx = deadzone(myGamepad->axisRX());
  int16_t ry = deadzone(myGamepad->axisRY());
  int16_t lt = myGamepad->brake();
  int16_t rt = myGamepad->throttle();
  uint16_t btn = myGamepad->buttons();
  int8_t dpad = myGamepad->dpad();

  if (abs(lx - plx) >= AXIS_CHANGE) {
    plx = lx;
    teensySerial.printf("AX,LX,%d,%lu\n", lx, (unsigned long)ms);
    Serial.printf("AX,LX,%d\n", lx);
  }
  if (abs(ly - ply) >= AXIS_CHANGE) {
    ply = ly;
    teensySerial.printf("AX,LY,%d,%lu\n", ly, (unsigned long)ms);
    Serial.printf("AX,LY,%d\n", ly);
  }
  if (abs(rx - prx) >= AXIS_CHANGE) {
    prx = rx;
    teensySerial.printf("AX,RX,%d,%lu\n", rx, (unsigned long)ms);
  }
  if (abs(ry - pry) >= AXIS_CHANGE) {
    pry = ry;
    teensySerial.printf("AX,RY,%d,%lu\n", ry, (unsigned long)ms);
  }

  if (abs(lt - plt) >= TRIG_CHANGE) {
    plt = lt;
    teensySerial.printf("AX,LT,%d,%lu\n", lt, (unsigned long)ms);
  }
  if (abs(rt - prt) >= TRIG_CHANGE) {
    prt = rt;
    teensySerial.printf("AX,RT,%d,%lu\n", rt, (unsigned long)ms);
  }

  uint16_t diff = btn ^ pbtn;
  if (diff) {
    for (int b = 0; b < 16; ++b) {
      if (diff & (1U << b)) {
        int state = (btn & (1U << b)) ? 1 : 0;
        teensySerial.printf("BTN,%d,%d,%lu\n", b, state, (unsigned long)ms);
        Serial.printf("BTN,%d,%d\n", b, state);

        // Y button (button 3) toggles active PTZ camera on press
        if (b == 3 && state == 1) {
          activePtzCamera = (activePtzCamera == 1) ? 2 : 1;
          Serial.printf("[PTZ] Switched to Camera %d\n", activePtzCamera);
          if (wsConnected) {
            String msg = "{\"type\":\"serial\",\"data\":\"PTZ Camera: " + String(activePtzCamera) + "\"}";
            webSocket.sendTXT(msg);
          }
        }

        // B button (button 1) - currently unused
        // if (b == 1 && state == 1) { }
      }
    }
    pbtn = btn;
  }

  if (dpad != pdpad) {
    pdpad = dpad;
    teensySerial.printf("DPAD,%d,%lu\n", (int)dpad, (unsigned long)ms);
    Serial.printf("[DPAD] Value: %d, wsConnected: %d\n", (int)dpad, wsConnected ? 1 : 0);

    // Send D-pad as camera PTZ commands via WebSocket
    // D-pad values: 0=none, 1=up, 2=down, 4=right, 8=left (can be combined)
    if (wsConnected && dpad != 0) {
      int pan = 0, tilt = 0;
      if (dpad & 0x01) tilt = 1;   // Up
      if (dpad & 0x02) tilt = -1;  // Down
      if (dpad & 0x04) pan = 1;    // Right
      if (dpad & 0x08) pan = -1;   // Left

      // Use Arduino String (not char*) for websocket - matches telemetry which works
      String ptzMsg = "{\"type\":\"ptz_cmd\",\"cmd\":\"PTZ_MOVE," +
                      String(activePtzCamera) + "," + String(pan) + "," + String(tilt) + "\"}";
      Serial.println("[PTZ] Sending: " + ptzMsg);
      webSocket.sendTXT(ptzMsg);
      // Also log to VPS
      webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"[DPAD] PTZ MOVE cam" + String(activePtzCamera) + " pan=" + String(pan) + " tilt=" + String(tilt) + "\"}");
    } else if (wsConnected && dpad == 0) {
      // D-pad released - send stop using Arduino String
      String ptzMsg = "{\"type\":\"ptz_cmd\",\"cmd\":\"PTZ_STOP," + String(activePtzCamera) + "\"}";
      Serial.println("[PTZ] Sending: " + ptzMsg);
      webSocket.sendTXT(ptzMsg);
      webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"[DPAD] PTZ STOP cam" + String(activePtzCamera) + "\"}");
    }
  }

  // Track if we were moving (to send explicit STOP when returning to center)
  static bool wasMoving = false;

  // Check if joystick is outside deadzone
  bool isMoving = (abs(lx) > JOYSTICK_SEND_DZ || abs(ly) > JOYSTICK_SEND_DZ);

  if (wsConnected) {
    if (isMoving) {
      // Send movement command
      String msg = "{\"type\":\"joystick\",\"lx\":" + String(lx) + ",\"ly\":" + String(ly) + "}";
      webSocket.sendTXT(msg);
      wasMoving = true;
    } else if (wasMoving) {
      // Joystick returned to center - send explicit STOP (0,0)
      webSocket.sendTXT("{\"type\":\"joystick\",\"lx\":0,\"ly\":0}");
      wasMoving = false;
      Serial.println("[GAMEPAD] Joystick centered - sent STOP");
    }
  }
}

// Escape string for safe JSON embedding
String escapeForJson(String input) {
  String escaped = "";
  for (unsigned int i = 0; i < input.length(); i++) {
    char c = input.charAt(i);
    if (c == '\\') escaped += "\\\\";
    else if (c == '"') escaped += "\\\"";
    else if (c == '\n') escaped += "\\n";
    else if (c == '\r') escaped += "\\r";
    else if (c == '\t') escaped += "\\t";
    else if (c < 32 || c > 126) escaped += "?";  // Replace control chars
    else escaped += c;
  }
  return escaped;
}

void sendTelemetry() {
  if (!wsConnected) return;
  String controller = myGamepad ? "connected" : "none";
  String ssid = escapeForJson(WiFi.SSID());  // Escape WiFi name for JSON safety
  String telemetry = "{\"type\":\"telemetry\",\"version\":\"3.8.0\",\"wifi\":\"" +
                     ssid + "\",\"rssi\":" + String(WiFi.RSSI()) +
                     ",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"controller\":\"" + controller +
                     "\",\"uptime\":" + String(millis() / 1000) + "}";
  webSocket.sendTXT(telemetry);
  Serial.println("[TELEMETRY] Sent");
}

void forwardTeensySerial() {
  while (teensySerial.available()) {
    String line = teensySerial.readStringUntil('\n');
    line.trim();  // Remove \r and whitespace
    if (line.length() > 0 && wsConnected) {
      String escaped = escapeForJson(line);
      String msg = "{\"type\":\"serial\",\"data\":\"" + escaped + "\"}";
      webSocket.sendTXT(msg);
      Serial.println("[TEENSY] " + line);
    }
  }
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("[WS] Disconnected");
      break;
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("[WS] Connected!");
      sendTelemetry();
      lastHeartbeat = millis();
      break;
    case WStype_TEXT:
      handleFlashMessage(payload, length);
      break;
    case WStype_PING:
      Serial.println("[WS] Ping");
      break;
    case WStype_PONG:
      Serial.println("[WS] Pong");
      break;
    default:
      break;
  }
}

void handleFlashMessage(uint8_t* payload, size_t length) {
  String msg = String((char*)payload);

  // New flash_mode command - puts Teensy in OTA mode
  if (msg.indexOf("\"type\":\"flash_mode\"") != -1) {
    Serial.println("[FLASH] Entering flash mode...");
    flashMode = true;
    hexLinesReceived = 0;
    teensySerial.println("FLASH_MODE");  // Tell Teensy to enter OTA mode
    delay(500);  // Give Teensy time to initialize flash buffer
    webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Teensy entering flash mode\"}");
    return;
  }

  // New hex_line command - sends one Intel HEX line at a time
  if (msg.indexOf("\"type\":\"hex_line\"") != -1) {
    int dataStart = msg.indexOf("\"data\":\"") + 8;
    int dataEnd = msg.indexOf("\"", dataStart);
    if (dataStart > 8 && dataEnd > dataStart) {
      String hexLine = msg.substring(dataStart, dataEnd);
      teensySerial.println(hexLine);  // Send hex line to Teensy
      hexLinesReceived++;
      // Progress every 500 lines
      if (hexLinesReceived % 500 == 0) {
        Serial.printf("[FLASH] Sent %d hex lines\n", hexLinesReceived);
      }
    }
    return;
  }

  // Legacy flash_start (keep for compatibility)
  if (msg.indexOf("\"type\":\"flash_start\"") != -1) {
    Serial.println("[FLASH] Legacy flash_start received");
    flashMode = true;
    hexLinesReceived = 0;
    teensySerial.println("FLASH_MODE");
    return;
  }

  // Legacy flash_chunk (keep for compatibility)
  if (msg.indexOf("\"type\":\"flash_chunk\"") != -1) {
    int dataStart = msg.indexOf("\"data\":\"") + 8;
    int dataEnd = msg.indexOf("\"", dataStart);
    if (dataStart > 8 && dataEnd > dataStart) {
      String chunk = msg.substring(dataStart, dataEnd);
      teensySerial.print(chunk);  // Send raw data (FlasherX expects lines)
    }
    return;
  }

  if (msg.indexOf("\"type\":\"flash_complete\"") != -1) {
    Serial.printf("[FLASH] Complete! Sent %d hex lines\n", hexLinesReceived);
    flashMode = false;
    webSocket.sendTXT("{\"type\":\"flash_ack\",\"status\":\"success\"}");
    return;
  }

  if (msg.indexOf("\"type\":\"command\"") != -1) {
    int dataStart = msg.indexOf("\"data\":\"") + 8;
    int dataEnd = msg.indexOf("\"", dataStart);
    if (dataStart > 8 && dataEnd > dataStart) {
      String cmd = msg.substring(dataStart, dataEnd);
      teensySerial.println(cmd);
    }
  }

  // ============ DISCRETE MOVEMENT COMMANDS ============
  // Handle move_command: { type: "move_command", distance: meters, direction: "N/E/S/W" }
  // Robot calculates optimal movement (forward/backward/turn) on Teensy side
  if (msg.indexOf("\"type\":\"move_command\"") != -1) {
    // Parse distance in meters
    int distStart = msg.indexOf("\"distance\":") + 11;
    int distEnd = msg.indexOf(",", distStart);
    if (distEnd == -1) distEnd = msg.indexOf("}", distStart);
    float distance = msg.substring(distStart, distEnd).toFloat();

    // Parse direction - web UI sends "FORWARD", "BACK", "LEFT", "RIGHT"
    int dirStart = msg.indexOf("\"direction\":\"") + 13;
    int dirEnd = msg.indexOf("\"", dirStart);
    String direction = msg.substring(dirStart, dirEnd);

    // Convert to single char for Teensy (F/B/L/R)
    char dirChar = 'F';
    if (direction == "BACK" || direction == "S" || direction == "B") dirChar = 'B';
    else if (direction == "LEFT" || direction == "W" || direction == "L") dirChar = 'L';
    else if (direction == "RIGHT" || direction == "E" || direction == "R") dirChar = 'R';
    else if (direction == "FORWARD" || direction == "N" || direction == "F") dirChar = 'F';

    Serial.printf("[MOVE] Direction: %s -> %c, Distance: %.2fm\n", direction.c_str(), dirChar, distance);

    // Send to Teensy as: MOVEDIR,direction,distance_cm
    int distanceCm = (int)(distance * 100);
    String moveCmd = "MOVEDIR," + String(dirChar) + "," + String(distanceCm);
    teensySerial.println(moveCmd);

    // Echo to WebSocket for confirmation
    if (wsConnected) {
      String confirmMsg = "{\"type\":\"serial\",\"data\":\"Move: " + String(distance) + "m " + direction + "\"}";
      webSocket.sendTXT(confirmMsg);
    }
  }

  // Handle emergency stop
  if (msg.indexOf("\"type\":\"emergency_stop\"") != -1) {
    Serial.println("[MOVE] EMERGENCY STOP!");
    teensySerial.println("STOP");
    // Also zero out the joystick
    teensySerial.println("AX,LX,0,0");
    teensySerial.println("AX,LY,0,0");
    if (wsConnected) {
      webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"EMERGENCY STOP\"}");
    }
  }
}
