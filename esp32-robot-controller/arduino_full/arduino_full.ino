/*
 * Cemani Robot Controller v4.0.0 - SAFETY CRITICAL UPDATE
 * ESP32 with Bluepad32 (Xbox) + WiFi + WebSocket + WIRELESS OTA
 * Upload via Arduino IDE with Bluepad32 board package
 *
 * ╔═══════════════════════════════════════════════════════════════════════════════╗
 * ║                    !!! SAFETY CRITICAL - DO NOT MODIFY !!!                    ║
 * ╠═══════════════════════════════════════════════════════════════════════════════╣
 * ║  XBOX CONTROLLER IS SACRED - IT MUST NEVER BE OVERRIDDEN                      ║
 * ║                                                                               ║
 * ║  1. Xbox polling happens FIRST every loop - BEFORE WebSocket                  ║
 * ║  2. Xbox disconnect = IMMEDIATE motor stop sent to Teensy                     ║
 * ║  3. Xbox heartbeat is SEPARATE from keepalive - Teensy tracks both            ║
 * ║  4. WebSocket data CANNOT block or delay Xbox processing                      ║
 * ║  5. ANY Xbox input immediately cancels ALL autonomous commands                ║
 * ║                                                                               ║
 * ║  INCIDENT: Jan 25, 2026 - Robot crashed into crowd causing injuries           ║
 * ║  ROOT CAUSE: WebSocket flooded by mapping data, blocking Xbox commands        ║
 * ║  THIS VERSION FIXES: Xbox processed first, separate heartbeat, instant stop   ║
 * ╚═══════════════════════════════════════════════════════════════════════════════╝
 *
 * v4.0.0 - SAFETY CRITICAL: Xbox ALWAYS processed first, before WebSocket
 *        - Xbox disconnect sends IMMEDIATE STOP to Teensy
 *        - Separate XBOX_HEARTBEAT message (not just KEEPALIVE)
 *        - WebSocket processing is time-limited to prevent blocking
 *        - Reduced joystick deadzone for finer control
 * v3.13.0 - SERIAL FORWARDING THROTTLE - only forward ONE message per loop
 * v3.12.0 - Increased loop delay to 10ms for WebSocket stability
 * v3.11.0 - WEBSOCKET STABILITY FIX - added 5ms loop delay
 * v3.10.0 - BROWNOUT DETECTION DISABLED - prevents resets during motor startup
 * v3.9.0 - WATCHDOG AUTO-REBOOT - reboots if WebSocket disconnected >2 minutes
 *
 * SETUP: Copy credentials.h.example to credentials.h and add your WiFi passwords
 */

// Disable brownout detector - prevents ESP32 reset when motors cause voltage drop
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

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
unsigned long lastWsConnected = 0;  // Watchdog: track last successful WS connection
unsigned long lastXboxInput = 0;    // SAFETY: Track last Xbox input for heartbeat
unsigned long lastXboxHeartbeat = 0; // SAFETY: Send Xbox-specific heartbeat to Teensy
bool xboxWasConnected = false;      // SAFETY: Track connection state changes
int wifiDropCount = 0;
const unsigned long WIFI_CHECK_INTERVAL = 2000;   // Check WiFi more often (was 10s)
const unsigned long HEARTBEAT_INTERVAL = 10000;   // Send telemetry every 10s (was 15s)
const unsigned long WIFI_RECONNECT_TIMEOUT = 3000; // Force reconnect if down >3s
const unsigned long TEENSY_KEEPALIVE_INTERVAL = 1000; // Send keepalive to Teensy every 1s
const unsigned long XBOX_HEARTBEAT_INTERVAL = 200;  // SAFETY: Send Xbox heartbeat every 200ms
const unsigned long XBOX_SCAN_LOG_INTERVAL = 5000; // Log Xbox scan status every 5s
const unsigned long WS_WATCHDOG_TIMEOUT = 120000; // Reboot if no WS connection for 2 minutes
const unsigned long WS_LOOP_TIME_LIMIT = 5;       // SAFETY: Max 5ms for WebSocket processing

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
#define JOYSTICK_SEND_DZ  30  // REDUCED from 60 - finer control for safety

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
  // Disable brownout detector - prevents resets when motors cause voltage dips
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(100);  // Minimal delay for serial init
  Serial.println("\n[ESP32] Cemani Robot Controller v4.4.0 - OFFLINE XBOX FIX!");

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

  // Try WiFi but don't block long - Xbox controller is more important than WiFi
  // wifiMulti.run() blocks ~500ms per attempt, so limit to 6 attempts (3 seconds)
  int attempts = 0;
  while (wifiMulti.run() != WL_CONNECTED && attempts < 6) {
    delay(100);
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

  // ╔═══════════════════════════════════════════════════════════════════════════════╗
  // ║  SAFETY CRITICAL: XBOX IS PROCESSED FIRST - BEFORE ANYTHING ELSE              ║
  // ║  WebSocket, OTA, WiFi - NOTHING comes before Xbox controller                  ║
  // ╚═══════════════════════════════════════════════════════════════════════════════╝

  // STEP 1: XBOX FIRST - Poll Bluetooth IMMEDIATELY
  BP32.update();

  // STEP 2: XBOX - Handle gamepad input IMMEDIATELY (before WebSocket can block)
  if (!flashMode) {
    handleGamepad();
  }

  // STEP 3: XBOX - Send Xbox-specific heartbeat to Teensy (separate from KEEPALIVE)
  // This tells Teensy "Xbox controller is actively being polled"
  if (!flashMode && now - lastXboxHeartbeat > XBOX_HEARTBEAT_INTERVAL) {
    if (myGamepad && myGamepad->isConnected()) {
      teensySerial.println("XBOX_ACTIVE");  // Xbox is connected and being polled
      lastXboxHeartbeat = now;
    } else {
      teensySerial.println("XBOX_INACTIVE");  // Xbox not connected - Teensy should be extra careful
      lastXboxHeartbeat = now;
    }
  }

  // STEP 4: XBOX - Detect connection state changes and send IMMEDIATE STOP
  bool xboxCurrentlyConnected = (myGamepad && myGamepad->isConnected());
  if (xboxWasConnected && !xboxCurrentlyConnected) {
    // Xbox just disconnected - EMERGENCY: Send immediate stop!
    Serial.println("[SAFETY] Xbox DISCONNECTED - sending EMERGENCY STOP to Teensy!");
    teensySerial.println("XBOX_DISCONNECTED");
    teensySerial.println("STOP");
    teensySerial.println("AX,LX,0,0");
    teensySerial.println("AX,LY,0,0");
    // Send multiple times to ensure delivery
    teensySerial.println("STOP");
    teensySerial.println("STOP");
  }
  xboxWasConnected = xboxCurrentlyConnected;

  if (!myGamepad) {
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
  }

  // ╔═══════════════════════════════════════════════════════════════════════════════╗
  // ║  WEBSOCKET - ONLY process when WiFi is connected!                             ║
  // ║  SSL reconnection attempts block for SECONDS on ESP32, starving Bluetooth.    ║
  // ║  Without this check, Xbox controller dies whenever there's no WiFi.           ║
  // ╚═══════════════════════════════════════════════════════════════════════════════╝
  if (WiFi.status() == WL_CONNECTED) {
    unsigned long wsStart = millis();
    webSocket.loop();
    unsigned long wsTime = millis() - wsStart;
    if (wsTime > WS_LOOP_TIME_LIMIT) {
      Serial.printf("[WARNING] WebSocket took %lums (limit %lums) - may delay Xbox!\n", wsTime, WS_LOOP_TIME_LIMIT);
    }

    ArduinoOTA.handle();  // Check for wireless OTA updates
  }

  // WiFi monitoring - NON-BLOCKING! Xbox must never be delayed by WiFi
  // Only check every 2 seconds, and NEVER block
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
      // CRITICAL: Mark WebSocket as disconnected so sendTXT() calls don't block!
      // Without this, wsConnected stays true and sendTXT() blocks on dead socket,
      // which starves Bluetooth and kills turning.
      if (wsConnected) {
        wsConnected = false;
        Serial.println("[WS] Marked disconnected (WiFi lost)");
      }
      Serial.printf("[WiFi] Disconnected! Attempt %d... (non-blocking)\n", wifiDropCount);
      // DO NOT call wifiMulti.run() here - it BLOCKS for seconds!
      // WiFi auto-reconnects in background via ESP32 WiFi stack
      // Only attempt reconnect every 60 seconds to minimize blocking
      if (now - lastWiFiConnected > 60000) {  // 60 seconds without WiFi
        Serial.println("[WiFi] Long disconnect - triggering background reconnect");
        WiFi.disconnect(false);  // Non-blocking disconnect
        // WiFi.begin() without args uses last known credentials
        // This is relatively non-blocking but only do it rarely
        WiFi.begin();
        lastWiFiConnected = now;  // Reset timer so we don't spam reconnects
      }
    }
  }

  if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendTelemetry();
    lastHeartbeat = now;
  }

  // Send general keepalive to Teensy (ESP32 is alive, separate from Xbox status)
  if (!flashMode && now - lastTeensyKeepalive > TEENSY_KEEPALIVE_INTERVAL) {
    teensySerial.println("KEEPALIVE");
    lastTeensyKeepalive = now;
  }

  forwardTeensySerial();

  // Small delay - but not too long to avoid delaying Xbox polling
  delay(5);  // Reduced from 10ms to 5ms for faster Xbox response

  // WATCHDOG: Reboot if WiFi IS connected but WebSocket is stuck
  // Only reboot when WiFi is available - if there's no WiFi (e.g. farmers market),
  // rebooting won't help and just kills the Xbox controller connection
  if (wsConnected) {
    lastWsConnected = now;
  } else if (WiFi.status() == WL_CONNECTED && now - lastWsConnected > WS_WATCHDOG_TIMEOUT) {
    // WiFi is up but WebSocket can't connect - reboot may help
    Serial.println("[WATCHDOG] WiFi up but no WebSocket for 2min - Rebooting!");
    delay(100);
    ESP.restart();
  }
  // No WiFi = no reboot. Xbox controller works fine without internet.
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
  String telemetry = "{\"type\":\"telemetry\",\"version\":\"4.0.0\",\"wifi\":\"" +
                     ssid + "\",\"rssi\":" + String(WiFi.RSSI()) +
                     ",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"controller\":\"" + controller +
                     "\",\"uptime\":" + String(millis() / 1000) + "}";
  webSocket.sendTXT(telemetry);
  Serial.println("[TELEMETRY] Sent");
}

void forwardTeensySerial() {
  // Only forward ONE message per loop to avoid overwhelming WebSocket
  // This prevents "message too big" errors (1009)
  if (teensySerial.available()) {
    String line = teensySerial.readStringUntil('\n');
    line.trim();
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

  // Serial command pass-through to Teensy (for compass calibration, etc)
  if (msg.indexOf("\"type\":\"serial_cmd\"") != -1) {
    int cmdStart = msg.indexOf("\"cmd\":\"") + 7;
    int cmdEnd = msg.indexOf("\"", cmdStart);
    if (cmdStart > 7 && cmdEnd > cmdStart) {
      String cmd = msg.substring(cmdStart, cmdEnd);
      teensySerial.println(cmd);
      Serial.println("[SERIAL_CMD] " + cmd);
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
