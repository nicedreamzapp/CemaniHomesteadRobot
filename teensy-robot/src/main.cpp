// ===== CEMANI HOMESTEAD ROBOT - MAIN =====
// Teensy 4.1 + 2x ZLAC8015D Motor Drivers
// V3.6 - Modular refactor
// =====================================================

#include <Arduino.h>
#include "config.h"
#include "modbus.h"
#include "flasher.h"
#include "telemetry.h"
#include "movement.h"
#include "ultrasonic.h"

// ===== GLOBAL STATE =====
bool emergencyStop = false;
bool motorsEnabled = false;
int16_t lastLeftSpeed = 0;
int16_t lastRightSpeed = 0;
int16_t rightTriggerValue = 0;  // Right trigger for turbo mode (0-1023)

static uint32_t lastMotorUpdate = 0;
static uint32_t lastComm = 0;
static uint32_t lastTelemetryUpdate = 0;
static uint32_t lastSonarSend = 0;
static bool watchdogTriggered = false;  // Tracks if watchdog stopped motors

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

  // Send version to ESP32
  Serial1.printf("TEENSY_VERSION,%s\n", TEENSY_VERSION);

  Serial.println(">>> READY TO DRIVE <<<\n");
}

// ===== MAIN LOOP =====
void loop() {
  static char buf[128];
  static int n = 0;
  uint32_t now = millis();

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
        Serial1.println("STOPPED");
      }
      // Resume command
      else if (strcmp(buf, "RESUME") == 0) {
        Serial.println("[CMD] RESUME received");
        emergencyStop = false;
        Serial1.println("RESUMED");
      }
      // Keepalive from ESP32 - just resets the watchdog timer (lastComm already updated)
      else if (strcmp(buf, "KEEPALIVE") == 0) {
        // Keepalive received - watchdog timer reset by lastComm = now above
        // Don't print anything to avoid spamming serial output
      }
    } else {
      buf[n++] = c;
    }
  }

  // ===== DISCRETE MOVEMENT UPDATE =====
  if (discreteMoveActive && !emergencyStop && motorsEnabled) {
    updateDiscreteMove();
  }
  // ===== JOYSTICK MOTOR CONTROL =====
  else if (controllerConnected && !emergencyStop && motorsEnabled && !discreteMoveActive) {
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

  // ===== ULTRASONIC SENSOR UPDATE =====
  // Read sensors (staggered, one per call) and send data every 250ms
  ultrasonicUpdate();
  if (now - lastSonarSend >= 250) {
    lastSonarSend = now;
    ultrasonicSendToESP32();
  }

  // ===== DRAIN MODBUS RESPONSES =====
  while (Serial3.available()) {
    Serial3.read();
  }
}
