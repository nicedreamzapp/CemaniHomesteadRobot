/*
 * Cemani Robot Controller v3.0.2
 * ESP32 with Bluepad32 (Xbox) + WiFi + WebSocket
 * Upload via Arduino IDE with Bluepad32 board package
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <Bluepad32.h>
#include <nvs_flash.h>

const char* WIFI_SSID_1 = "MyAltice 7a4283";
const char* WIFI_PASS_1 = "granite-833-564";
const char* WIFI_SSID_2 = "MyOptimum 6b7c4d";
const char* WIFI_PASS_2 = "9621-granite-62";
const char* WIFI_SSID_3 = "divine tribe";
const char* WIFI_PASS_3 = "hemp1234";

#define TEENSY_TX 17
#define TEENSY_RX 16
HardwareSerial teensySerial(1);

WiFiMulti wifiMulti;
WebSocketsClient webSocket;
GamepadPtr myGamepad = nullptr;

bool wsConnected = false;
unsigned long lastWiFiCheck = 0;
unsigned long lastHeartbeat = 0;
const unsigned long WIFI_CHECK_INTERVAL = 10000;
const unsigned long HEARTBEAT_INTERVAL = 30000;

int16_t plx = 0, ply = 0, prx = 0, pry = 0;
int16_t plt = 0, prt = 0;
uint16_t pbtn = 0;
int8_t pdpad = -2;

#define AXIS_DZ       8
#define AXIS_CHANGE   8
#define TRIG_CHANGE   4

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
  delay(1000);
  Serial.println("\n[ESP32] Cemani Robot Controller v3.0.2");

  Serial.println("[NVS] Erasing Bluetooth storage...");
  nvs_flash_erase();
  nvs_flash_init();
  Serial.println("[NVS] Done");

  teensySerial.begin(115200, SERIAL_8N1, TEENSY_RX, TEENSY_TX);
  Serial.println("[TEENSY] Serial ready");

  Serial.println("[BP32] Initializing...");
  BP32.setup(&onConnectedGamepad, &onDisconnectedGamepad);
  BP32.forgetBluetoothKeys();
  BP32.enableNewBluetoothConnections(true);
  BP32.enableVirtualDevice(false);

  delay(500);
  for (int i = 0; i < 5; i++) {
    BP32.update();
    delay(100);
  }
  Serial.println("[BP32] Ready - hold Xbox+Sync to pair!");

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
    Serial.printf("[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Failed - controller still works!");
  }

  webSocket.begin("robot.marijuanaunion.com", 80, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  Serial.println("[SYSTEM] Ready!");
}

void loop() {
  BP32.update();
  webSocket.loop();

  unsigned long now = millis();

  if (now - lastWiFiCheck > WIFI_CHECK_INTERVAL) {
    lastWiFiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      wifiMulti.run();
    }
  }

  if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendTelemetry();
    lastHeartbeat = now;
  }

  handleGamepad();
  forwardTeensySerial();
  delay(1);
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
    Serial.println("[BP32] XBOX DISCONNECTED");
    teensySerial.println("STATE,DISCONNECTED");
    teensySerial.println("AX,LX,0,0");
    teensySerial.println("AX,LY,0,0");
    if (wsConnected) {
      webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Xbox Disconnected\"}");
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
      }
    }
    pbtn = btn;
  }

  if (dpad != pdpad) {
    pdpad = dpad;
    teensySerial.printf("DPAD,%d,%lu\n", (int)dpad, (unsigned long)ms);
  }

  if (wsConnected && (abs(lx) > 10 || abs(ly) > 10)) {
    String msg = "{\"type\":\"joystick\",\"lx\":" + String(lx) + ",\"ly\":" + String(ly) + "}";
    webSocket.sendTXT(msg);
  }
}

void sendTelemetry() {
  if (!wsConnected) return;
  String controller = myGamepad ? "connected" : "none";
  String telemetry = "{\"type\":\"telemetry\",\"version\":\"3.0.2\",\"wifi\":\"" +
                     WiFi.SSID() + "\",\"rssi\":" + String(WiFi.RSSI()) +
                     ",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"controller\":\"" + controller +
                     "\",\"uptime\":" + String(millis() / 1000) + "}";
  webSocket.sendTXT(telemetry);
  Serial.println("[TELEMETRY] Sent");
}

void forwardTeensySerial() {
  while (teensySerial.available()) {
    String line = teensySerial.readStringUntil('\n');
    if (line.length() > 0 && wsConnected) {
      String msg = "{\"type\":\"serial\",\"data\":\"" + line + "\"}";
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

bool flashMode = false;
int hexLinesReceived = 0;

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
}
