#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <Bluepad32.h>

// WiFi credentials
WiFiMulti wifiMulti;
WebSocketsClient webSocket;

// Teensy Serial
#define TEENSY_RX 16  // ESP32 TX -> Teensy RX
#define TEENSY_TX 17  // ESP32 RX -> Teensy TX
HardwareSerial teensySerial(2);

// Hex flashing state
String hexBuffer = "";
int expectedChunks = 0;
int receivedChunks = 0;
bool flashingInProgress = false;

// Controller state
ControllerPtr myController = nullptr;

// Forward declarations
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);
void onConnectedController(ControllerPtr ctl);
void onDisconnectedController(ControllerPtr ctl);
void forwardTeensySerial();
void handleFlashMessage(uint8_t * payload, size_t length);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[ESP32] Cemani Robot Controller Starting...");

  // Setup Teensy Serial
  teensySerial.begin(115200, SERIAL_8N1, TEENSY_TX, TEENSY_RX);
  Serial.println("[TEENSY] Serial initialized on GPIO16/17 @ 115200 baud");

  // Setup WiFi with multiple networks
  Serial.println("[WiFi] Configuring WiFiMulti...");
  wifiMulti.addAP("MyAltice 7a4283", "elephant8988");
  wifiMulti.addAP("MyOptimum 6b7c4d", "9621-granite-62");
  wifiMulti.addAP("divine tribe", "hemp1234");

  Serial.print("[WiFi] Connecting");
  while (wifiMulti.run() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] Connected!");
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("[WiFi] Network: ");
  Serial.println(WiFi.SSID());

  // Setup WebSocket
  Serial.println("[WS] Connecting to robot.marijuanaunion.com...");
  webSocket.begin("robot.marijuanaunion.com", 80, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  // Setup Bluepad32
  Serial.println("[BP32] Initializing Bluepad32...");
  BP32.setup(&onConnectedController, &onDisconnectedController);
  BP32.forgetBluetoothKeys();
  BP32.enableVirtualDevice(false);

  Serial.println("[SYSTEM] ✅ All systems ready!");
}

void loop() {
  // Update connections
  webSocket.loop();
  BP32.update();

  // Keep WiFi alive
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost, reconnecting...");
    wifiMulti.run();
  }

  // Forward Teensy serial data to VPS
  forwardTeensySerial();

  // Handle Xbox controller input
  if (myController && myController->isConnected()) {
    int lx = myController->axisX();
    int ly = myController->axisY();

    // Send joystick data to VPS (which forwards to dashboard)
    if (abs(lx) > 10 || abs(ly) > 10) { // Deadzone
      String msg = "{\"type\":\"joystick\",\"lx\":" + String(lx) + ",\"ly\":" + String(ly) + "}";
      webSocket.sendTXT(msg);
    }

    // Also send directly to Teensy for immediate control
    teensySerial.print("L" + String(lx) + "\n");
    teensySerial.print("R" + String(ly) + "\n");
  }

  delay(10);
}

void forwardTeensySerial() {
  // Read from Teensy and send to VPS
  while (teensySerial.available()) {
    String line = teensySerial.readStringUntil('\n');
    if (line.length() > 0) {
      String msg = "{\"type\":\"serial\",\"data\":\"" + line + "\"}";
      webSocket.sendTXT(msg);
      Serial.println("[TEENSY->VPS] " + line);
    }
  }
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from VPS");
      break;

    case WStype_CONNECTED:
      Serial.println("[WS] Connected to VPS!");
      // Announce ourselves as the robot
      webSocket.sendTXT("{\"type\":\"robot_hello\"}");
      break;

    case WStype_TEXT:
      Serial.printf("[WS] Received: %s\n", payload);
      handleFlashMessage(payload, length);
      break;

    case WStype_ERROR:
      Serial.println("[WS] Error!");
      break;
  }
}

void handleFlashMessage(uint8_t * payload, size_t length) {
  // Parse JSON message
  String msg = String((char*)payload);

  // Check for flash_start
  if (msg.indexOf("\"type\":\"flash_start\"") != -1) {
    Serial.println("[FLASH] Starting hex reception...");
    hexBuffer = "";
    receivedChunks = 0;
    flashingInProgress = true;

    // Parse totalChunks
    int idx = msg.indexOf("\"totalChunks\":");
    if (idx != -1) {
      expectedChunks = msg.substring(idx + 14).toInt();
      Serial.printf("[FLASH] Expecting %d chunks\n", expectedChunks);
    }

    // Tell Teensy to enter bootloader mode
    teensySerial.println("FLASH_MODE");
    delay(100);
    return;
  }

  // Check for flash_chunk
  if (msg.indexOf("\"type\":\"flash_chunk\"") != -1) {
    // Extract data field
    int dataStart = msg.indexOf("\"data\":\"") + 8;
    int dataEnd = msg.indexOf("\"", dataStart);

    if (dataStart > 8 && dataEnd > dataStart) {
      String chunk = msg.substring(dataStart, dataEnd);
      hexBuffer += chunk;
      receivedChunks++;

      if (receivedChunks % 10 == 0) {
        Serial.printf("[FLASH] Received %d/%d chunks (%d bytes)\n",
                      receivedChunks, expectedChunks, hexBuffer.length());
      }
    }
    return;
  }

  // Check for flash_complete
  if (msg.indexOf("\"type\":\"flash_complete\"") != -1) {
    Serial.printf("[FLASH] All chunks received! Total: %d bytes\n", hexBuffer.length());
    Serial.println("[FLASH] Forwarding hex to Teensy via FlasherX...");

    // Send hex data to Teensy in smaller chunks for FlasherX
    const int TEENSY_CHUNK = 128;
    for (int i = 0; i < hexBuffer.length(); i += TEENSY_CHUNK) {
      String chunk = hexBuffer.substring(i, min(i + TEENSY_CHUNK, (int)hexBuffer.length()));
      teensySerial.print(chunk);
      delay(10); // Small delay for Teensy to process
    }

    // Signal end of transmission
    teensySerial.println("\nEND_FLASH");

    Serial.println("[FLASH] ✅ Hex forwarded to Teensy!");

    // Cleanup
    hexBuffer = "";
    receivedChunks = 0;
    expectedChunks = 0;
    flashingInProgress = false;

    // Send confirmation to VPS
    webSocket.sendTXT("{\"type\":\"flash_ack\",\"status\":\"success\"}");
    return;
  }

  // Check for command (from dashboard)
  if (msg.indexOf("\"type\":\"command\"") != -1) {
    int dataStart = msg.indexOf("\"data\":\"") + 8;
    int dataEnd = msg.indexOf("\"", dataStart);

    if (dataStart > 8 && dataEnd > dataStart) {
      String cmd = msg.substring(dataStart, dataEnd);
      Serial.println("[CMD] Forwarding to Teensy: " + cmd);
      teensySerial.println(cmd);
    }
  }
}

void onConnectedController(ControllerPtr ctl) {
  myController = ctl;
  Serial.println("[BP32] ✅ Xbox Controller Connected!");
  webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Xbox Controller Connected\"}");
}

void onDisconnectedController(ControllerPtr ctl) {
  if (myController == ctl) {
    myController = nullptr;
    Serial.println("[BP32] Xbox Controller Disconnected");
    webSocket.sendTXT("{\"type\":\"serial\",\"data\":\"Xbox Controller Disconnected\"}");
  }
}
