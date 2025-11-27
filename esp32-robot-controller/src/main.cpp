#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include "credentials.h"

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

// Connection status
bool wsConnected = false;
unsigned long lastWiFiCheck = 0;
const unsigned long WIFI_CHECK_INTERVAL = 10000;

// Heartbeat
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 30000;

// Forward declarations
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);
void forwardTeensySerial();
void handleFlashMessage(uint8_t * payload, size_t length);
void sendTelemetry();

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[ESP32] Cemani Robot Controller Starting...");
  Serial.println("[ESP32] Version 2.0.1 (WiFi Only)");

  // Setup Teensy Serial
  teensySerial.begin(115200, SERIAL_8N1, TEENSY_TX, TEENSY_RX);
  Serial.println("[TEENSY] Serial initialized on GPIO16/17 @ 115200 baud");

  // Setup WiFi with multiple networks
  Serial.println("[WiFi] Configuring WiFiMulti...");
  wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);  // Home
  wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);  // Work
  wifiMulti.addAP(WIFI_SSID_3, WIFI_PASS_3);  // Phone hotspot

  Serial.print("[WiFi] Connecting");
  int attempts = 0;
  while (wifiMulti.run() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected!");
    Serial.print("[WiFi] IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] Network: ");
    Serial.println(WiFi.SSID());
    Serial.print("[WiFi] Signal: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n[WiFi] FAILED to connect!");
  }

  // Setup WebSocket
  Serial.println("[WS] Connecting to robot.marijuanaunion.com...");
  webSocket.begin("robot.marijuanaunion.com", 80, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  Serial.println("[SYSTEM] All systems ready!");
}

void loop() {
  webSocket.loop();

  unsigned long now = millis();

  // Keep WiFi alive
  if (now - lastWiFiCheck > WIFI_CHECK_INTERVAL) {
    lastWiFiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] Connection lost, reconnecting...");
      wifiMulti.run();
    }
  }

  // Send periodic telemetry
  if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendTelemetry();
    lastHeartbeat = now;
  }

  // Forward Teensy serial data to VPS
  forwardTeensySerial();

  delay(10);
}

void sendTelemetry() {
  if (!wsConnected) return;

  String telemetry = "{\"type\":\"telemetry\",\"version\":\"2.0.1\",\"wifi\":\"" +
                     WiFi.SSID() + "\",\"rssi\":" + String(WiFi.RSSI()) +
                     ",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"connected\":true,\"uptime\":" + String(millis() / 1000) + "}";

  webSocket.sendTXT(telemetry);
  Serial.println("[TELEMETRY] Sent to VPS");
}

void forwardTeensySerial() {
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
      wsConnected = false;
      Serial.println("[WS] Disconnected from VPS");
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("[WS] Connected to VPS!");
      sendTelemetry();
      lastHeartbeat = millis();
      break;

    case WStype_TEXT:
      Serial.printf("[WS] Received: %s\n", payload);
      handleFlashMessage(payload, length);
      break;

    case WStype_PING:
      Serial.println("[WS] Ping");
      break;

    case WStype_PONG:
      Serial.println("[WS] Pong");
      break;

    case WStype_ERROR:
      wsConnected = false;
      Serial.println("[WS] Error!");
      break;
  }
}

void handleFlashMessage(uint8_t * payload, size_t length) {
  String msg = String((char*)payload);

  if (msg.indexOf("\"type\":\"flash_start\"") != -1) {
    Serial.println("[FLASH] Starting hex reception...");
    hexBuffer = "";
    receivedChunks = 0;
    flashingInProgress = true;

    int idx = msg.indexOf("\"totalChunks\":");
    if (idx != -1) {
      expectedChunks = msg.substring(idx + 14).toInt();
      Serial.printf("[FLASH] Expecting %d chunks\n", expectedChunks);
    }

    teensySerial.println("FLASH_MODE");
    delay(100);
    return;
  }

  if (msg.indexOf("\"type\":\"flash_chunk\"") != -1) {
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

  if (msg.indexOf("\"type\":\"flash_complete\"") != -1) {
    Serial.printf("[FLASH] All chunks received! Total: %d bytes\n", hexBuffer.length());
    Serial.println("[FLASH] Forwarding hex to Teensy...");

    const int TEENSY_CHUNK = 128;
    for (int i = 0; i < hexBuffer.length(); i += TEENSY_CHUNK) {
      String chunk = hexBuffer.substring(i, min(i + TEENSY_CHUNK, (int)hexBuffer.length()));
      teensySerial.print(chunk);
      delay(10);
    }

    teensySerial.println("\nEND_FLASH");
    Serial.println("[FLASH] Hex forwarded to Teensy!");

    hexBuffer = "";
    receivedChunks = 0;
    expectedChunks = 0;
    flashingInProgress = false;

    webSocket.sendTXT("{\"type\":\"flash_ack\",\"status\":\"success\"}");
    return;
  }

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
