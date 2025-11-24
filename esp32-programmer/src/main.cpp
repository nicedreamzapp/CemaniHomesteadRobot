#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <Update.h>

WebServer server(80);

// HTML page with both ESP32 OTA and Teensy upload options
const char* htmlPage = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <title>Wireless Programmer</title>
  <style>
    body { font-family: Arial; margin: 40px; background: #1a1a2e; color: #eee; }
    .card { background: #16213e; padding: 20px; margin: 20px 0; border-radius: 10px; }
    h1 { color: #e94560; }
    h2 { color: #0f4c75; }
    input[type=submit] { background: #e94560; color: white; padding: 10px 30px; border: none; border-radius: 5px; cursor: pointer; }
    input[type=file] { margin: 10px 0; }
    .status { color: #00ff88; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>Wireless Programmer</h1>

  <div class="card">
    <h2>ESP32 Firmware (OTA)</h2>
    <p>Upload .bin file to update this ESP32</p>
    <form method='POST' action='/update-esp' enctype='multipart/form-data'>
      <input type='file' name='update' accept='.bin'><br><br>
      <input type='submit' value='Update ESP32'>
    </form>
  </div>

  <div class="card">
    <h2>Teensy 4.1 Firmware</h2>
    <p>Upload .hex file to update the Teensy</p>
    <form method='POST' action='/update-teensy' enctype='multipart/form-data'>
      <input type='file' name='firmware' accept='.hex'><br><br>
      <input type='submit' value='Update Teensy'>
    </form>
  </div>

  <div class="card">
    <h2>Serial Monitor</h2>
    <p>View Teensy serial output: <a href="/serial" style="color:#00ff88;">Open Monitor</a></p>
  </div>
</body>
</html>
)rawliteral";

const char* serialPage = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <title>Serial Monitor</title>
  <style>
    body { font-family: monospace; margin: 20px; background: #000; color: #0f0; }
    #output { height: 400px; overflow-y: scroll; border: 1px solid #0f0; padding: 10px; }
    input { width: 80%; padding: 10px; background: #111; color: #0f0; border: 1px solid #0f0; }
    button { padding: 10px 20px; background: #0f0; color: #000; border: none; cursor: pointer; }
  </style>
</head>
<body>
  <h2>Teensy Serial Monitor</h2>
  <div id="output"></div>
  <br>
  <input type="text" id="cmd" placeholder="Send to Teensy...">
  <button onclick="sendCmd()">Send</button>
  <script>
    setInterval(function(){
      fetch('/serial-data').then(r=>r.text()).then(t=>{
        if(t) document.getElementById('output').innerHTML += t + '<br>';
        document.getElementById('output').scrollTop = document.getElementById('output').scrollHeight;
      });
    }, 500);
    function sendCmd() {
      var cmd = document.getElementById('cmd').value;
      fetch('/send?cmd=' + encodeURIComponent(cmd));
      document.getElementById('cmd').value = '';
    }
  </script>
</body>
</html>
)rawliteral";

String serialBuffer = "";

void setup() {
  Serial.begin(115200);  // USB debug
  Serial1.begin(115200, SERIAL_8N1, 16, 17);  // RX=GPIO16, TX=GPIO17 for Teensy

  // Start WiFi Access Point
  WiFi.softAP("TeensyProgrammer", "teensy41");
  Serial.println("WiFi AP Started: TeensyProgrammer / teensy41");
  Serial.print("IP: ");
  Serial.println(WiFi.softAPIP());

  // Setup Arduino OTA for ESP32 self-update
  ArduinoOTA.setHostname("teensy-programmer");
  ArduinoOTA.setPassword("teensy41");
  ArduinoOTA.onStart([]() { Serial.println("OTA Start"); });
  ArduinoOTA.onEnd([]() { Serial.println("OTA End"); });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA Progress: %u%%\r", (progress / (total / 100)));
  });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA Error[%u]\n", error); });
  ArduinoOTA.begin();

  // Main page
  server.on("/", HTTP_GET, [](){
    server.send(200, "text/html", htmlPage);
  });

  // ESP32 OTA update via web
  server.on("/update-esp", HTTP_POST, [](){
    server.sendHeader("Connection", "close");
    server.send(200, "text/plain", Update.hasError() ? "ESP32 Update FAILED" : "ESP32 Update OK! Rebooting...");
    delay(1000);
    ESP.restart();
  }, [](){
    HTTPUpload& upload = server.upload();
    if (upload.status == UPLOAD_FILE_START) {
      Serial.printf("ESP32 Update: %s\n", upload.filename.c_str());
      if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
        Update.printError(Serial);
      }
    } else if (upload.status == UPLOAD_FILE_WRITE) {
      if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
        Update.printError(Serial);
      }
    } else if (upload.status == UPLOAD_FILE_END) {
      if (Update.end(true)) {
        Serial.printf("ESP32 Update Success: %u bytes\n", upload.totalSize);
      } else {
        Update.printError(Serial);
      }
    }
  });

  // Teensy firmware upload
  server.on("/update-teensy", HTTP_POST, [](){
    server.send(200, "text/html", "<h1>Teensy Update Sent!</h1><p>Check serial monitor for status.</p><a href='/'>Back</a>");
  }, [](){
    HTTPUpload& upload = server.upload();
    if (upload.status == UPLOAD_FILE_START) {
      Serial.printf("Teensy Update: %s\n", upload.filename.c_str());
      // Send FlasherX trigger command to Teensy
      Serial1.println("FLASH_START");
      delay(100);
    } else if (upload.status == UPLOAD_FILE_WRITE) {
      // Forward hex file data to Teensy
      Serial1.write(upload.buf, upload.currentSize);
    } else if (upload.status == UPLOAD_FILE_END) {
      Serial1.println();
      Serial1.println("FLASH_END");
      Serial.printf("Teensy hex sent: %u bytes\n", upload.totalSize);
    }
  });

  // Serial monitor page
  server.on("/serial", HTTP_GET, [](){
    server.send(200, "text/html", serialPage);
  });

  // Serial data endpoint
  server.on("/serial-data", HTTP_GET, [](){
    server.send(200, "text/plain", serialBuffer);
    serialBuffer = "";
  });

  // Send command to Teensy
  server.on("/send", HTTP_GET, [](){
    if (server.hasArg("cmd")) {
      Serial1.println(server.arg("cmd"));
    }
    server.send(200, "text/plain", "OK");
  });

  server.begin();
  Serial.println("HTTP server started on http://192.168.4.1");
}

void loop() {
  ArduinoOTA.handle();
  server.handleClient();

  // Buffer serial data from Teensy
  while (Serial1.available()) {
    char c = Serial1.read();
    serialBuffer += c;
    Serial.write(c);
    if (serialBuffer.length() > 2000) {
      serialBuffer = serialBuffer.substring(1000);
    }
  }

  // Pass through from USB to Teensy
  while (Serial.available()) {
    Serial1.write(Serial.read());
  }
}
