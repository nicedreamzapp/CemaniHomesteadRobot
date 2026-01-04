// ===== CEMANI HOMESTEAD ROBOT - MAIN =====
// Teensy 4.1 + 2x ZLAC8015D Motor Drivers
// V3.68 - Safety system (obstacle avoidance + tilt detection)
// =====================================================

#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
#include "config.h"
#include "modbus.h"
#include "flasher.h"
#include "telemetry.h"
#include "movement.h"
#include "ultrasonic.h"
#include "safety.h"

// ===== GPS + COMPASS =====
#define GPS_SERIAL Serial7
#define GPS_BAUD 38400
#define COMPASS_ADDR 0x0E

// EEPROM addresses for compass calibration
#define EEPROM_COMPASS_MAGIC 0
#define EEPROM_COMPASS_OFFX 4
#define EEPROM_COMPASS_OFFY 8
#define EEPROM_COMPASS_OFFZ 12
#define COMPASS_MAGIC_VALUE 0xCAFE  // Magic number to verify EEPROM has valid data

// GPS data
float gpsLat = 0, gpsLon = 0;
float gpsSpeed = 0;
int gpsSats = 0;
bool gpsValid = false;
float lastValidLat = 0, lastValidLon = 0;

// Compass data
float compassHeading = 0;
int16_t compassX = 0, compassY = 0, compassZ = 0;

// Compass AUTO-calibration - runs continuously while driving!
int16_t compassOffsetX = 0;
int16_t compassOffsetY = 0;
int16_t compassOffsetZ = 0;
bool compassCalibrating = true;  // ALWAYS calibrating in background
int16_t compassMinX = 32767, compassMaxX = -32768;
int16_t compassMinY = 32767, compassMaxY = -32768;
int16_t compassMinZ = 32767, compassMaxZ = -32768;
uint32_t lastCalSave = 0;
bool compassCalibrated = false;  // True once we have good calibration
#define MIN_CAL_RANGE 200  // Minimum range needed to consider calibrated

// I2C scan results (set in setup, used in loop to report)
int gCompassBus = -1;  // -1 = not found, 0=Wire, 1=Wire1, 2=Wire2
uint8_t gCompassAddr = 0;
bool i2cScanReported = false;

// ===== GLOBAL STATE =====
bool emergencyStop = false;
bool motorsEnabled = false;
int16_t lastLeftSpeed = 0;
int16_t lastRightSpeed = 0;
int16_t rightTriggerValue = 0;  // Right trigger for turbo mode (0-1023)

// Control modes: MANUAL = Xbox control (no auto-stop), MAPPING = slow autonomous with safety
enum ControlMode { MODE_MANUAL = 0, MODE_MAPPING = 1 };
ControlMode currentMode = MODE_MANUAL;
#define MAPPING_SPEED_RPM 5  // ~1/8 mph - very slow for precision mapping

// Autonomous navigation state
bool autonomousActive = false;
int16_t autoLeftSpeed = 0;
int16_t autoRightSpeed = 0;
uint32_t lastAutoCmd = 0;
#define AUTO_CMD_TIMEOUT 500  // Stop if no auto command for 500ms

static uint32_t lastMotorUpdate = 0;
static uint32_t lastComm = 0;
static uint32_t lastTelemetryUpdate = 0;
static uint32_t lastSonarSend = 0;
static uint32_t lastGpsUpdate = 0;
static uint32_t lastCompassUpdate = 0;
static bool watchdogTriggered = false;  // Tracks if watchdog stopped motors

// GPS parsing buffer
static char gpsBuf[128];
static int gpsIdx = 0;

// ===== SETUP =====
void setup() {
  Serial.begin(115200);   // USB debug
  Serial1.begin(115200);  // ESP32 communication
  Serial3.begin(115200);  // Modbus to drivers

  delay(2000);

  Serial.println("\n========================================");
  Serial.println("  CEMANI HOMESTEAD ROBOT - TANK DRIVE");
  Serial.printf("  V%s - Modular refactor\n", TEENSY_VERSION);
  Serial.println("========================================");
  Serial.println("Hardware: Teensy 4.1 + 2x ZLAC8015D");
  Serial.println("Motors: 4 hub motors (2 per driver)");
  Serial.println("----------------------------------------");
  Serial.printf("  Normal: %d RPM, %dms accel\n", MAX_SPEED_RPM, DRIVER_ACCEL_NORMAL);
  Serial.printf("  Turbo:  %d RPM (hold RT)\n", TURBO_SPEED_RPM);
  Serial.printf("  Turn:   %d RPM\n", MAX_TURN_RPM);
  Serial.println("----------------------------------------");
  Serial.println("Controls:");
  Serial.println("  Left Stick  = Tank drive");
  Serial.println("  Right Trig  = TURBO (fwd/back only)");
  Serial.println("  A Button    = Emergency Stop");
  Serial.println("----------------------------------------");
  Serial.println("OTA: Embedded FlasherX - wireless updates");
  Serial.println("========================================\n");

  fullReset();

  // Initialize ultrasonic sensors
  ultrasonicInit();

  // Initialize safety system (obstacle avoidance + tilt detection)
  safetyInit();

  // Initialize GPS
  GPS_SERIAL.begin(GPS_BAUD);
  Serial.println("[GPS] Serial7 @ 38400 baud initialized");

  // Initialize Compass I2C (Wire2 on pins 24/25)
  Wire.begin();
  Wire1.begin();
  Wire2.begin();
  Serial.println("[COMPASS] I2C buses initialized");

  // Full I2C scan of ALL buses to find compass
  // Wire=pins 18/19, Wire1=pins 17/16, Wire2=pins 25/24
  Serial.println("[I2C] Scanning ALL buses for devices...");

  const char* busNames[] = {"Wire(18/19)", "Wire1(17/16)", "Wire2(25/24)"};
  TwoWire* buses[] = {&Wire, &Wire1, &Wire2};
  bool compassFound = false;
  int compassBus = -1;
  uint8_t compassAddr = 0;

  for (int b = 0; b < 3; b++) {
    Serial.printf("[I2C] Scanning %s...\n", busNames[b]);
    for (uint8_t addr = 1; addr < 127; addr++) {
      buses[b]->beginTransmission(addr);
      if (buses[b]->endTransmission() == 0) {
        Serial.printf("[I2C] Found 0x%02X on %s\n", addr, busNames[b]);
        // Check if it's a compass address
        if (addr == 0x0D || addr == 0x0E || addr == 0x1E) {
          compassBus = b;
          compassAddr = addr;
          compassFound = true;
        }
      }
    }
  }

  // Store compass location globally for readCompass()
  gCompassBus = compassBus;
  gCompassAddr = compassAddr;

  if (compassFound) {
    Serial.printf("[COMPASS] Found at 0x%02X on %s\n", compassAddr, busNames[compassBus]);
    // Initialize based on address
    if (compassAddr == 0x1E) {
      // HMC5883L initialization
      buses[compassBus]->beginTransmission(0x1E);
      buses[compassBus]->write(0x00);
      buses[compassBus]->write(0x70);
      buses[compassBus]->endTransmission();
      buses[compassBus]->beginTransmission(0x1E);
      buses[compassBus]->write(0x01);
      buses[compassBus]->write(0x20);
      buses[compassBus]->endTransmission();
      buses[compassBus]->beginTransmission(0x1E);
      buses[compassBus]->write(0x02);
      buses[compassBus]->write(0x00);
      buses[compassBus]->endTransmission();
      Serial.println("[COMPASS] HMC5883L initialized");
    } else if (compassAddr == 0x0D) {
      // QMC5883L initialization
      buses[compassBus]->beginTransmission(0x0D);
      buses[compassBus]->write(0x0B);
      buses[compassBus]->write(0x01);
      buses[compassBus]->endTransmission();
      buses[compassBus]->beginTransmission(0x0D);
      buses[compassBus]->write(0x09);
      buses[compassBus]->write(0x1D);
      buses[compassBus]->endTransmission();
      Serial.println("[COMPASS] QMC5883L initialized");
    }
  } else {
    Serial.println("[COMPASS] WARNING: No compass found on ANY I2C bus!");
    Serial.println("[COMPASS] Check wiring: SDA/SCL to pins 18/19, 17/16, or 25/24");
  }

  // Load compass calibration from EEPROM
  uint16_t magic;
  EEPROM.get(EEPROM_COMPASS_MAGIC, magic);
  if (magic == COMPASS_MAGIC_VALUE) {
    EEPROM.get(EEPROM_COMPASS_OFFX, compassOffsetX);
    EEPROM.get(EEPROM_COMPASS_OFFY, compassOffsetY);
    EEPROM.get(EEPROM_COMPASS_OFFZ, compassOffsetZ);
    compassCalibrated = true;
    Serial.printf("[COMPASS] Loaded calibration from EEPROM: X=%d Y=%d Z=%d\n",
      compassOffsetX, compassOffsetY, compassOffsetZ);
  } else {
    Serial.println("[COMPASS] No saved calibration - will auto-calibrate while driving");
  }

  // Send version to ESP32
  Serial1.printf("TEENSY_VERSION,%s\n", TEENSY_VERSION);

  Serial.println(">>> READY TO DRIVE <<<\n");
}

// ===== GPS PARSING =====
void parseGpsLine(const char* line) {
  // Parse GNRMC: $GNRMC,time,status,lat,N/S,lon,E/W,speed,course,date,...
  // Parse GNGGA: $GNGGA,time,lat,N/S,lon,E/W,fix,sats,hdop,alt,...

  if (strncmp(line, "$GNRMC", 6) == 0 || strncmp(line, "$GPRMC", 6) == 0) {
    char status;
    float lat, lon, spd;
    char ns, ew;

    // Simple parsing - look for V (void) or A (active)
    const char* p = strchr(line + 7, ',');  // Skip time
    if (p) {
      p++;
      status = *p;
      gpsValid = (status == 'A');

      if (gpsValid) {
        // Parse lat/lon (simplified)
        p = strchr(p + 1, ',');
        if (p) {
          lat = atof(p + 1);
          // Convert NMEA format (DDMM.MMMM) to decimal degrees
          int deg = (int)(lat / 100);
          float min = lat - (deg * 100);
          gpsLat = deg + min / 60.0;

          p = strchr(p + 1, ',');
          if (p && *(p + 1) == 'S') gpsLat = -gpsLat;

          p = strchr(p + 1, ',');
          if (p) {
            lon = atof(p + 1);
            deg = (int)(lon / 100);
            min = lon - (deg * 100);
            gpsLon = deg + min / 60.0;

            p = strchr(p + 1, ',');
            if (p && *(p + 1) == 'W') gpsLon = -gpsLon;
          }
        }

        // Save last valid position
        if (gpsLat != 0 && gpsLon != 0) {
          lastValidLat = gpsLat;
          lastValidLon = gpsLon;
        }
      }
    }
  }
  else if (strncmp(line, "$GNGGA", 6) == 0 || strncmp(line, "$GPGGA", 6) == 0) {
    // Parse satellites
    const char* p = line;
    for (int i = 0; i < 7 && p; i++) p = strchr(p + 1, ',');
    if (p) gpsSats = atoi(p + 1);
  }
}

void readGps() {
  while (GPS_SERIAL.available()) {
    char c = GPS_SERIAL.read();
    if (c == '\n' || gpsIdx >= 127) {
      gpsBuf[gpsIdx] = 0;
      if (gpsIdx > 5) parseGpsLine(gpsBuf);
      gpsIdx = 0;
    } else if (c != '\r') {
      gpsBuf[gpsIdx++] = c;
    }
  }
}

// ===== COMPASS READING =====
void readCompass() {
  int16_t rawX = 0, rawY = 0, rawZ = 0;
  bool gotReading = false;
  static uint32_t lastDiagLog = 0;
  static int readFailCount = 0;

  // Use the bus/address detected in setup()
  TwoWire* buses[] = {&Wire, &Wire1, &Wire2};

  if (gCompassBus < 0 || gCompassBus > 2) {
    // No compass found during setup - log periodically
    static uint32_t lastFailLog = 0;
    if (millis() - lastFailLog > 5000) {
      lastFailLog = millis();
      Serial.println("[COMPASS] No compass detected during setup - check wiring");
      Serial1.println("[COMPASS] No compass detected - check wiring");
    }
    return;
  }

  // Periodic diagnostic log
  if (millis() - lastDiagLog > 10000) {
    lastDiagLog = millis();
    const char* busNames[] = {"Wire(18/19)", "Wire1(17/16)", "Wire2(25/24)"};
    Serial.printf("[COMPASS] Using 0x%02X on %s, failCount=%d\n", gCompassAddr, busNames[gCompassBus], readFailCount);
    Serial1.printf("[COMPASS] Using 0x%02X on %s, failCount=%d\n", gCompassAddr, busNames[gCompassBus], readFailCount);
  }

  TwoWire* bus = buses[gCompassBus];

  // Read based on detected address
  if (gCompassAddr == 0x0D) {
    // QMC5883L - data at register 0x00, LSB first
    bus->beginTransmission(0x0D);
    bus->write(0x00);
    if (bus->endTransmission() == 0) {
      bus->requestFrom((uint8_t)0x0D, (uint8_t)6);
      if (bus->available() >= 6) {
        rawX = bus->read() | (bus->read() << 8);  // LSB first
        rawY = bus->read() | (bus->read() << 8);
        rawZ = bus->read() | (bus->read() << 8);
        gotReading = true;
      }
    }
  } else if (gCompassAddr == 0x0E) {
    // IST8310 magnetometer - data at register 0x03, LSB first
    // First trigger a single measurement
    bus->beginTransmission(0x0E);
    bus->write(0x0A);  // CTRL1 register
    bus->write(0x01);  // Single measurement mode
    bus->endTransmission();

    delay(10);  // Wait for measurement

    // Read data from register 0x03
    bus->beginTransmission(0x0E);
    bus->write(0x03);
    if (bus->endTransmission() == 0) {
      bus->requestFrom((uint8_t)0x0E, (uint8_t)6);
      if (bus->available() >= 6) {
        rawX = bus->read() | (bus->read() << 8);  // LSB first
        rawY = bus->read() | (bus->read() << 8);
        rawZ = bus->read() | (bus->read() << 8);
        gotReading = true;
      }
    }
  } else {
    // HMC5883L (0x1E) - data at register 0x03, MSB first
    bus->beginTransmission(gCompassAddr);
    bus->write(0x03);
    if (bus->endTransmission() == 0) {
      bus->requestFrom(gCompassAddr, (uint8_t)6);
      if (bus->available() >= 6) {
        rawX = (bus->read() << 8) | bus->read();  // MSB first
        rawZ = (bus->read() << 8) | bus->read();
        rawY = (bus->read() << 8) | bus->read();
        gotReading = true;
      }
    }
  }

  if (!gotReading) {
    readFailCount++;
    static uint32_t lastFailLog = 0;
    if (millis() - lastFailLog > 5000) {
      lastFailLog = millis();
      Serial.printf("[COMPASS] Read failed from 0x%02X on bus %d (fails=%d)\n", gCompassAddr, gCompassBus, readFailCount);
      Serial1.printf("[COMPASS] Read failed 0x%02X bus%d fails=%d\n", gCompassAddr, gCompassBus, readFailCount);
    }
    return;
  }

  // AUTO-CALIBRATION: Always track min/max while driving
  bool updated = false;
  if (rawX < compassMinX) { compassMinX = rawX; updated = true; }
  if (rawX > compassMaxX) { compassMaxX = rawX; updated = true; }
  if (rawY < compassMinY) { compassMinY = rawY; updated = true; }
  if (rawY > compassMaxY) { compassMaxY = rawY; updated = true; }
  if (rawZ < compassMinZ) { compassMinZ = rawZ; updated = true; }
  if (rawZ > compassMaxZ) { compassMaxZ = rawZ; updated = true; }

  // Calculate current ranges
  int16_t rangeX = compassMaxX - compassMinX;
  int16_t rangeY = compassMaxY - compassMinY;

  // Check if we have enough range for good calibration (robot has turned enough)
  if (rangeX >= MIN_CAL_RANGE && rangeY >= MIN_CAL_RANGE) {
    // Calculate new offsets (center of min/max)
    int16_t newOffX = (compassMinX + compassMaxX) / 2;
    int16_t newOffY = (compassMinY + compassMaxY) / 2;
    int16_t newOffZ = (compassMinZ + compassMaxZ) / 2;

    // Update offsets if they changed significantly
    if (!compassCalibrated ||
        abs(newOffX - compassOffsetX) > 10 ||
        abs(newOffY - compassOffsetY) > 10) {
      compassOffsetX = newOffX;
      compassOffsetY = newOffY;
      compassOffsetZ = newOffZ;

      // Save to EEPROM every 30 seconds max (to avoid wear)
      uint32_t now = millis();
      if (now - lastCalSave > 30000) {
        lastCalSave = now;
        EEPROM.put(EEPROM_COMPASS_MAGIC, (uint16_t)COMPASS_MAGIC_VALUE);
        EEPROM.put(EEPROM_COMPASS_OFFX, compassOffsetX);
        EEPROM.put(EEPROM_COMPASS_OFFY, compassOffsetY);
        EEPROM.put(EEPROM_COMPASS_OFFZ, compassOffsetZ);
        Serial.printf("[COMPASS] Auto-saved calibration: X=%d Y=%d Z=%d\n",
          compassOffsetX, compassOffsetY, compassOffsetZ);
        Serial1.printf("COMPASS_CAL,SAVED,%d,%d,%d\n", compassOffsetX, compassOffsetY, compassOffsetZ);
      }

      if (!compassCalibrated) {
        compassCalibrated = true;
        Serial.println("[COMPASS] Auto-calibration complete!");
        Serial1.println("COMPASS_CAL,COMPLETE");
      }
    }
  }

  // Apply hard-iron calibration offsets
  compassX = rawX - compassOffsetX;
  compassY = rawY - compassOffsetY;
  compassZ = rawZ - compassOffsetZ;

  // Calculate magnetic heading (0-360 degrees)
  // Negate both X and Y to correct orientation for IST8310 mounting
  compassHeading = atan2((float)-compassY, (float)-compassX) * 180.0 / PI;
  if (compassHeading < 0) compassHeading += 360;

  // Apply mounting offset (arrow on GPS/compass points to BACK of robot)
  // Then apply magnetic declination to get TRUE north heading
  // Result: 0°=True North, 90°=East, 180°=South, 270°=West
  compassHeading = fmod(compassHeading + COMPASS_MOUNTING_OFFSET + MAGNETIC_DECLINATION + 360.0f, 360.0f);
}

// ===== MAIN LOOP =====
void loop() {
  static char buf[128];
  static int n = 0;
  uint32_t now = millis();

  // Report I2C scan results once after 5 seconds (ESP32 should be connected by then)
  if (!i2cScanReported && now > 5000) {
    i2cScanReported = true;
    const char* busNames[] = {"Wire(18/19)", "Wire1(17/16)", "Wire2(25/24)"};
    if (gCompassBus >= 0) {
      Serial.printf("[I2C] *** Compass found at 0x%02X on %s ***\n", gCompassAddr, busNames[gCompassBus]);
      Serial1.printf("I2C_SCAN,COMPASS,0x%02X,%s\n", gCompassAddr, busNames[gCompassBus]);
      // Also print raw compass values for debugging
      Serial.printf("[COMPASS] Raw X=%d Y=%d Z=%d Heading=%.1f\n", compassX, compassY, compassZ, compassHeading);
    } else {
      Serial.println("[I2C] *** No compass found on any bus! ***");
      Serial1.println("I2C_SCAN,COMPASS,NONE");
    }
  }


  // ===== PARSE INPUT FROM ESP32 (and USB for testing) =====
  // Check both Serial1 (ESP32) and Serial (USB) for commands
  while (Serial1.available() || Serial.available()) {
    char c;
    if (Serial1.available()) {
      c = Serial1.read();
    } else {
      c = Serial.read();
    }
    if (c == '\r') continue;

    if (c == '\n' || n >= 127) {
      buf[n] = 0;
      n = 0;
      lastComm = now;

      // OTA Flash mode
      if (strcmp(buf, "FLASH_MODE") == 0) {
        startOtaUpdate();
        continue;
      }

      // Xbox controller state
      if (strncmp(buf, "STATE,CONNECTED", 15) == 0) {
        controllerConnected = true;
        if (!motorsEnabled) {
          Serial.println("[CTRL] Xbox connected - enabling motors");
          fullReset();
        } else {
          Serial.println("[CTRL] Xbox connected");
        }
      }
      else if (strncmp(buf, "STATE,DISCONNECTED", 18) == 0) {
        controllerConnected = false;
        currentLX = 0;
        currentLY = 0;
        Serial.println("[CTRL] Xbox disconnected - joystick zeroed");
      }
      // Joystick axes
      else if (strncmp(buf, "AX,", 3) == 0) {
        char name[3];
        long val;
        unsigned long ms;
        if (sscanf(buf, "AX,%2[^,],%ld,%lu", name, &val, &ms) == 3) {
          if (val < -600 || val > 600) continue;

          // Auto-recover from E-STOP on significant input
          bool significantInput = (abs(val) > 100);
          if (significantInput && (emergencyStop || !motorsEnabled)) {
            Serial.println("[CTRL] Joystick input - auto-recovering from E-STOP");
            emergencyStop = false;
            fullReset();
          }
          controllerConnected = true;

          if (strcmp(name, "LX") == 0) currentLX = val;
          else if (strcmp(name, "LY") == 0) currentLY = val;
          else if (strcmp(name, "RT") == 0) {
            rightTriggerValue = val;
            // Log turbo activation - send to both USB and ESP32
            static bool wasTurbo = false;
            bool isTurbo = (val >= TURBO_TRIGGER_THRESHOLD);
            if (isTurbo && !wasTurbo) {
              Serial.println("[TURBO] Activated!");
              Serial1.println("TURBO,ON");
            } else if (!isTurbo && wasTurbo) {
              Serial.println("[TURBO] Deactivated");
              Serial1.println("TURBO,OFF");
            }
            wasTurbo = isTurbo;
          }
        }
      }
      // Button presses
      else if (strncmp(buf, "BTN,", 4) == 0) {
        long id, state;
        unsigned long ms;
        if (sscanf(buf, "BTN,%ld,%ld,%lu", &id, &state, &ms) == 3) {
          if (state == 1 && id == 0) {  // A button = E-STOP
            Serial.println("[BTN] A pressed - EMERGENCY STOP!");
            emergencyStopMotors();
            discreteMoveActive = false;
            discreteMovePhase = 0;
          }
        }
      }
      // Discrete movement (F/B/L/R)
      else if (strncmp(buf, "MOVEDIR,", 8) == 0) {
        char dir;
        int distCm;
        if (sscanf(buf, "MOVEDIR,%c,%d", &dir, &distCm) == 2) {
          Serial.printf("[CMD] MOVEDIR dir=%c dist=%dcm\n", dir, distCm);
          currentLX = 0;
          currentLY = 0;
          if (dir == 'F' || dir == 'B' || dir == 'L' || dir == 'R') {
            startRelativeMove(dir, distCm);
          } else {
            startDiscreteMoveDirection(dir, distCm);
          }
        }
      }
      // Legacy movement command
      else if (strncmp(buf, "MOVE,", 5) == 0) {
        int turnDeg, distCm;
        if (sscanf(buf, "MOVE,%d,%d", &turnDeg, &distCm) == 2) {
          Serial.printf("[CMD] MOVE turn=%d dist=%dcm\n", turnDeg, distCm);
          currentLX = 0;
          currentLY = 0;
          startDiscreteMove(turnDeg, distCm);
        }
      }
      // Stop command
      else if (strcmp(buf, "STOP") == 0) {
        Serial.println("[CMD] STOP received");
        emergencyStopMotors();
        discreteMoveActive = false;
        discreteMovePhase = 0;
        autonomousActive = false;  // Also stop autonomous mode
        autoLeftSpeed = 0;
        autoRightSpeed = 0;
        Serial1.println("STOPPED");
      }
      // Resume command
      else if (strcmp(buf, "RESUME") == 0) {
        Serial.println("[CMD] RESUME received");
        emergencyStop = false;
        safetyReset();  // Clear any safety override
        Serial1.println("RESUMED");
      }
      // Mode switching: MANUAL (Xbox) vs MAPPING (slow autonomous)
      else if (strcmp(buf, "MODE_MANUAL") == 0) {
        currentMode = MODE_MANUAL;
        Serial.println("[MODE] Switched to MANUAL (Xbox control, no auto-stop)");
        Serial1.println("MODE,MANUAL");
      }
      else if (strcmp(buf, "MODE_MAPPING") == 0) {
        currentMode = MODE_MAPPING;
        // Auto-enable motors when entering mapping mode
        if (!motorsEnabled || emergencyStop) {
          Serial.println("[MODE] Enabling motors for mapping mode...");
          fullReset();
        }
        Serial.println("[MODE] Switched to MAPPING (slow speed, safety active)");
        Serial1.println("MODE,MAPPING");
      }
      // ===== AUTONOMOUS NAVIGATION COMMANDS =====
      else if (strncmp(buf, "AUTO_FWD", 8) == 0) {
        // AUTO_FWD,speed - Move forward at given speed
        int speed = MAPPING_SPEED_RPM;
        if (buf[8] == ',') speed = atoi(buf + 9);
        if (speed < 1) speed = MAPPING_SPEED_RPM;
        if (speed > 10) speed = 10;  // Cap at safe speed
        autoLeftSpeed = speed;
        autoRightSpeed = speed;
        autonomousActive = true;
        lastAutoCmd = millis();
        Serial.printf("[AUTO] Forward at %d RPM\n", speed);
      }
      else if (strncmp(buf, "AUTO_REV", 8) == 0) {
        // AUTO_REV,speed - Reverse at given speed
        int speed = MAPPING_SPEED_RPM;
        if (buf[8] == ',') speed = atoi(buf + 9);
        if (speed < 1) speed = MAPPING_SPEED_RPM;
        if (speed > 10) speed = 10;
        autoLeftSpeed = -speed;
        autoRightSpeed = -speed;
        autonomousActive = true;
        lastAutoCmd = millis();
        Serial.printf("[AUTO] Reverse at %d RPM\n", speed);
      }
      else if (strncmp(buf, "AUTO_LEFT", 9) == 0) {
        // AUTO_LEFT,speed - Turn left in place
        int speed = MAPPING_SPEED_RPM;
        if (buf[9] == ',') speed = atoi(buf + 10);
        if (speed < 1) speed = MAPPING_SPEED_RPM;
        if (speed > 8) speed = 8;  // Slower for turns
        autoLeftSpeed = -speed;  // Left wheels backward
        autoRightSpeed = speed;  // Right wheels forward
        autonomousActive = true;
        lastAutoCmd = millis();
        Serial.printf("[AUTO] Turn left at %d RPM\n", speed);
      }
      else if (strncmp(buf, "AUTO_RIGHT", 10) == 0) {
        // AUTO_RIGHT,speed - Turn right in place
        int speed = MAPPING_SPEED_RPM;
        if (buf[10] == ',') speed = atoi(buf + 11);
        if (speed < 1) speed = MAPPING_SPEED_RPM;
        if (speed > 8) speed = 8;
        autoLeftSpeed = speed;   // Left wheels forward
        autoRightSpeed = -speed; // Right wheels backward
        autonomousActive = true;
        lastAutoCmd = millis();
        Serial.printf("[AUTO] Turn right at %d RPM\n", speed);
      }
      else if (strcmp(buf, "AUTO_STOP") == 0) {
        // Explicit autonomous stop
        autonomousActive = false;
        autoLeftSpeed = 0;
        autoRightSpeed = 0;
        Serial.println("[AUTO] Stopped");
      }
      // Keepalive from ESP32 - just resets the watchdog timer (lastComm already updated)
      else if (strcmp(buf, "KEEPALIVE") == 0) {
        // Keepalive received - watchdog timer reset by lastComm = now above
        // Don't print anything to avoid spamming serial output
      }
      // Compass calibration commands
      else if (strcmp(buf, "COMPASS_CAL_START") == 0) {
        compassCalibrating = true;
        compassMinX = 32767; compassMaxX = -32768;
        compassMinY = 32767; compassMaxY = -32768;
        compassMinZ = 32767; compassMaxZ = -32768;
        Serial.println("[COMPASS] Calibration started - rotate robot 360+ degrees");
        Serial1.println("COMPASS_CAL,STARTED");
      }
      else if (strcmp(buf, "COMPASS_CAL_STOP") == 0) {
        compassCalibrating = false;
        // Calculate offsets (center of min/max range)
        compassOffsetX = (compassMinX + compassMaxX) / 2;
        compassOffsetY = (compassMinY + compassMaxY) / 2;
        compassOffsetZ = (compassMinZ + compassMaxZ) / 2;
        Serial.printf("[COMPASS] Calibration done! Offsets: X=%d Y=%d Z=%d\n",
          compassOffsetX, compassOffsetY, compassOffsetZ);
        Serial.printf("[COMPASS] Min: X=%d Y=%d Z=%d  Max: X=%d Y=%d Z=%d\n",
          compassMinX, compassMinY, compassMinZ, compassMaxX, compassMaxY, compassMaxZ);
        Serial1.printf("COMPASS_CAL,DONE,%d,%d,%d\n", compassOffsetX, compassOffsetY, compassOffsetZ);
      }
      else if (strcmp(buf, "COMPASS_CAL_STATUS") == 0) {
        Serial1.printf("COMPASS_CAL,STATUS,%d,%d,%d,%d,%d,%d,%d\n",
          compassCalibrating ? 1 : 0, compassMinX, compassMaxX, compassMinY, compassMaxY, compassMinZ, compassMaxZ);
      }
    } else {
      buf[n++] = c;
    }
  }

  // ===== DISCRETE MOVEMENT UPDATE =====
  if (discreteMoveActive && !emergencyStop && motorsEnabled) {
    updateDiscreteMove();
  }
  // ===== AUTONOMOUS MOTOR CONTROL =====
  else if (autonomousActive && currentMode == MODE_MAPPING && !emergencyStop && motorsEnabled) {
    // Timeout check - stop if no commands received
    if (now - lastAutoCmd > AUTO_CMD_TIMEOUT) {
      autoLeftSpeed = 0;
      autoRightSpeed = 0;
      autonomousActive = false;
      setDriverSpeed(1, 0);
      setDriverSpeed(2, 0);
      lastLeftSpeed = 0;
      lastRightSpeed = 0;
      Serial.println("[AUTO] Command timeout - motors stopped");
    } else if (now - lastMotorUpdate >= MOTOR_UPDATE_INTERVAL) {
      lastMotorUpdate = now;

      int16_t newLeft = autoLeftSpeed;
      int16_t newRight = autoRightSpeed;

      // Apply safety check
      if (safetyCheck(newLeft, newRight)) {
        newLeft = 0;
        newRight = 0;
        Serial.println("[AUTO] Safety stop - obstacle detected");
      } else {
        bool movingFwd = (newLeft > 0 || newRight > 0);
        float speedLimit = safetyGetSpeedLimit(movingFwd);
        if (speedLimit < 1.0f) {
          newLeft = (int16_t)(newLeft * speedLimit);
          newRight = (int16_t)(newRight * speedLimit);
        }
      }

      // Send to motors if changed
      if (newLeft != lastLeftSpeed || newRight != lastRightSpeed) {
        setDriverSpeed(1, newLeft);
        setDriverSpeed(2, newRight);
        lastLeftSpeed = newLeft;
        lastRightSpeed = newRight;
        if (abs(newLeft) > 0 || abs(newRight) > 0) {
          Serial.printf("[AUTO] L:%+4d R:%+4d RPM\n", newLeft, newRight);
        }
      }
    }
  }
  // ===== JOYSTICK MOTOR CONTROL =====
  else if (controllerConnected && !emergencyStop && motorsEnabled && !discreteMoveActive && !autonomousActive) {
    if (now - lastMotorUpdate >= MOTOR_UPDATE_INTERVAL) {
      lastMotorUpdate = now;

      // AEROSPACE-GRADE FILTERING: Apply multi-stage noise rejection
      // This eliminates ALL noise even after hours of operation
      long filteredLX, filteredLY;
      filterJoystickInput(currentLX, currentLY, filteredLX, filteredLY);

      // Check if turbo mode is active (right trigger held)
      bool turboActive = (rightTriggerValue >= TURBO_TRIGGER_THRESHOLD);
      calculateTankSpeeds(filteredLX, filteredLY, targetLeftSpeed, targetRightSpeed, turboActive);

      // No more mode switching - same fast response for turning and driving
      int16_t newLeft = rampSpeed(lastLeftSpeed, targetLeftSpeed, turboActive);
      int16_t newRight = rampSpeed(lastRightSpeed, targetRightSpeed, turboActive);

      // CRITICAL: Hard clamp output speeds based on turbo state
      int16_t maxSpeed = turboActive ? TURBO_SPEED_RPM : MAX_SPEED_RPM;
      newLeft = constrain(newLeft, -maxSpeed, maxSpeed);
      newRight = constrain(newRight, -maxSpeed, maxSpeed);

      // ===== SAFETY SYSTEM CHECK =====
      // Obstacle avoidance only in MAPPING mode
      if (currentMode == MODE_MAPPING) {
        if (safetyCheck(newLeft, newRight)) {
          newLeft = 0;
          newRight = 0;
        } else {
          bool movingFwd = (newLeft > 0 || newRight > 0);
          float speedLimit = safetyGetSpeedLimit(movingFwd);
          if (speedLimit < 1.0f) {
            newLeft = (int16_t)(newLeft * speedLimit);
            newRight = (int16_t)(newRight * speedLimit);
          }
        }
      }

      // ===== COLLISION DETECTION - MAP MODE ONLY =====
      // Only auto-reverse in mapping mode - manual Xbox control has full control
      if (currentMode == MODE_MAPPING) {
        extern int16_t telemetry_torqueL;
        extern int16_t telemetry_torqueR;
        int16_t collisionSpeed = safetyCheckCollision(telemetry_torqueL, telemetry_torqueR, lastLeftSpeed, lastRightSpeed);
        if (collisionSpeed != 0) {
          // Override with collision recovery movement
          newLeft = collisionSpeed;
          newRight = collisionSpeed;
        }
      }

      // Always send 0 when target is 0 to ensure motors stop
      // Otherwise only send if change > 2 to reduce noise
      bool shouldStop = (targetLeftSpeed == 0 && targetRightSpeed == 0 && (lastLeftSpeed != 0 || lastRightSpeed != 0));
      bool significantChange = (abs(newLeft - lastLeftSpeed) > 2 || abs(newRight - lastRightSpeed) > 2);

      if (shouldStop || significantChange) {
        // Force to exactly 0 when stopping
        if (shouldStop) {
          newLeft = 0;
          newRight = 0;
        }

        setDriverSpeed(1, newLeft);
        setDriverSpeed(2, newRight);

        lastLeftSpeed = newLeft;
        lastRightSpeed = newRight;

        if (shouldStop) {
          Serial.println("[MOTOR] Joystick centered - motors STOPPED");
        } else if (abs(newLeft) > 5 || abs(newRight) > 5) {
          bool turbo = (rightTriggerValue >= TURBO_TRIGGER_THRESHOLD);
          Serial.printf("L:%+4d  R:%+4d RPM  %s%s\n", newLeft, newRight,
            isTurning ? "[TURN]" : "", turbo ? "[TURBO]" : "");
          Serial1.printf("SPEED,L:%d,R:%d%s\n", newLeft, newRight, turbo ? ",TURBO" : "");
        }
      }
    }
  }

  // ===== SAFETY: Controller timeout =====
  if (now - lastComm > 10000 && controllerConnected) {
    controllerConnected = false;
    currentLX = 0;
    currentLY = 0;
    Serial.println("[TIMEOUT] No Xbox data - joystick zeroed");
  }

  // ===== SAFETY: Watchdog - auto-stop if no communication =====
  // This is the CRITICAL safety feature - motors MUST stop if we lose contact
  uint32_t timeSinceComm = now - lastComm;
  if (timeSinceComm > WATCHDOG_TIMEOUT_MS && !watchdogTriggered && motorsEnabled) {
    // First threshold - zero the motors gracefully
    if (lastLeftSpeed != 0 || lastRightSpeed != 0) {
      Serial.println("[WATCHDOG] No commands for 2s - zeroing motors");
      setDriverSpeed(1, 0);
      setDriverSpeed(2, 0);
      lastLeftSpeed = 0;
      lastRightSpeed = 0;
      currentLX = 0;
      currentLY = 0;
      Serial1.println("WATCHDOG,ZERO");
    }

    // Second threshold - full emergency stop
    if (timeSinceComm > WATCHDOG_STOP_TIMEOUT) {
      Serial.println("[WATCHDOG] No commands for 5s - EMERGENCY STOP!");
      emergencyStopMotors();
      discreteMoveActive = false;
      discreteMovePhase = 0;
      watchdogTriggered = true;
      Serial1.println("WATCHDOG,ESTOP");
    }
  }

  // Reset watchdog flag when we receive new data
  if (timeSinceComm < 500 && watchdogTriggered) {
    watchdogTriggered = false;
    Serial.println("[WATCHDOG] Communication restored");
  }

  // ===== TELEMETRY UPDATE =====
  if (now - lastTelemetryUpdate >= TELEMETRY_INTERVAL) {
    lastTelemetryUpdate = now;
    readDriverTelemetry();
    sendTelemetryToESP32();
  }

  // ===== GPS UPDATE =====
  readGps();  // Always read incoming GPS data
  if (now - lastGpsUpdate >= 1000) {  // Send GPS data every second
    lastGpsUpdate = now;
    // Send to ESP32: GPS,valid,lat,lon,sats,lastLat,lastLon
    char gpsBuf[80];
    snprintf(gpsBuf, sizeof(gpsBuf), "GPS,%d,%.6f,%.6f,%d,%.6f,%.6f",
      gpsValid ? 1 : 0, gpsLat, gpsLon, gpsSats, lastValidLat, lastValidLon);
    Serial1.println(gpsBuf);
  }

  // ===== COMPASS UPDATE =====
  if (now - lastCompassUpdate >= 500) {  // Read compass 2x per second (was 5x - too fast)
    lastCompassUpdate = now;
    readCompass();
    // Only send compass data if a compass was actually detected
    if (gCompassBus >= 0) {
      char compassBuf[64];
      snprintf(compassBuf, sizeof(compassBuf), "COMPASS,%.1f,%d,%d,%d", compassHeading, compassX, compassY, compassZ);
      Serial1.println(compassBuf);
    }
  }

  // ===== ULTRASONIC SENSOR UPDATE =====
  // Read sensors (staggered, one per call) and send data every 250ms
  ultrasonicUpdate();
  if (now - lastSonarSend >= 250) {
    lastSonarSend = now;
    ultrasonicSendToESP32();
  }

  // ===== SAFETY STATUS UPDATE =====
  // Send safety system status to ESP32 (throttled to 2Hz internally)
  safetySendStatus();

  // ===== DRAIN MODBUS RESPONSES =====
  while (Serial3.available()) {
    Serial3.read();
  }
}
