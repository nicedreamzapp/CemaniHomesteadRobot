// ===== SYNCHRONIZED DUAL-AXIS TANK DRIVE =====
// ZLAC8015D V4.0 - Proper synchronous velocity control
// Each driver controls 2 motors (Left/Right on same driver)
// Driver 1 = Left side (2 wheels), Driver 2 = Right side (2 wheels)

#include <Arduino.h>

// ===== CONFIGURATION =====
#define INVERT_DRIVER_1 true   // Based on your wheel test results
#define INVERT_DRIVER_2 false  // Adjust if needed

// Speed limits
#define MAX_SPEED_RPM 150       // Max speed for forward/back
#define MAX_TURN_RPM 50         // Max speed during pivot turns (much slower)

// Acceleration rates (software ramping per 50ms update)
#define ACCEL_RATE_NORMAL 10    // Normal acceleration
#define ACCEL_RATE_TURN 4       // Slower acceleration for turns

// Driver acceleration times (hardware S-curve)
#define DRIVER_ACCEL_NORMAL 300  // ms for normal driving
#define DRIVER_ACCEL_TURN 800    // ms for turns (much slower ramp)

#define JOYSTICK_DEADZONE 0.1f
#define MOTOR_UPDATE_INTERVAL 50

// ===== REGISTER DEFINITIONS (from ZLAC8015D RS485 docs) =====
#define REG_CONTROL_MODE    0x200D  // 3 = velocity mode
#define REG_CONTROL_WORD    0x200E  // 0x08 = enable, 0x05 = e-stop, 0x07 = stop
#define REG_SYNC_MODE       0x200F  // 0 = synchronous, 1 = asynchronous
#define REG_ACCEL_LEFT      0x2080  // Acceleration time (ms)
#define REG_ACCEL_RIGHT     0x2081
#define REG_DECEL_LEFT      0x2082  // Deceleration time (ms)
#define REG_DECEL_RIGHT     0x2083
#define REG_VEL_LEFT        0x2088  // Target velocity Left motor
#define REG_VEL_RIGHT       0x2089  // Target velocity Right motor
#define REG_BRAKE_LEFT      0x201A  // Brake B0: 0=open, 1=close
#define REG_BRAKE_RIGHT     0x201B  // Brake B1: 0=open, 1=close

// ===== STATE VARIABLES =====
static long currentLX = 0, currentLY = 0;
static int16_t lastLeftSpeed = 0, lastRightSpeed = 0;
static int16_t targetLeftSpeed = 0, targetRightSpeed = 0;
static uint32_t lastMotorUpdate = 0;
static uint32_t lastComm = 0;
static bool controllerConnected = false;
static bool emergencyStop = false;
static bool motorsEnabled = false;
static bool isTurning = false;         // Are we in a turn?
static bool lastTurnState = false;     // Previous turn state (to detect changes)

// ===== MODBUS CRC-16 =====
uint16_t modbusCRC(const uint8_t* buf, int len) {
  uint16_t crc = 0xFFFF;
  for (int pos = 0; pos < len; pos++) {
    crc ^= (uint16_t)buf[pos];
    for (int i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// ===== MODBUS WRITE SINGLE REGISTER (0x06) =====
bool sendModbusWrite(uint8_t id, uint16_t reg, int16_t value) {
  uint8_t frame[8];
  frame[0] = id;
  frame[1] = 0x06;
  frame[2] = reg >> 8;
  frame[3] = reg & 0xFF;
  frame[4] = (uint16_t)value >> 8;
  frame[5] = (uint16_t)value & 0xFF;
  uint16_t crc = modbusCRC(frame, 6);
  frame[6] = crc & 0xFF;
  frame[7] = crc >> 8;

  Serial3.write(frame, 8);
  Serial3.flush();
  delay(5);
  return true;
}

// ===== MODBUS WRITE MULTIPLE REGISTERS (0x10) - SYNCHRONOUS WRITE =====
// This writes BOTH velocity registers (0x2088 and 0x2089) in ONE atomic command
// Ensuring both motors on a driver start at exactly the same time
bool sendModbusSyncVelocity(uint8_t id, int16_t leftVel, int16_t rightVel) {
  // Frame: [ID][0x10][RegH][RegL][NumRegH][NumRegL][ByteCount][Data0H][Data0L][Data1H][Data1L][CRCH][CRCL]
  uint8_t frame[13];
  frame[0] = id;
  frame[1] = 0x10;              // Function code: Write Multiple Registers
  frame[2] = 0x20;              // Start register high byte (0x2088)
  frame[3] = 0x88;              // Start register low byte
  frame[4] = 0x00;              // Number of registers high byte
  frame[5] = 0x02;              // Number of registers low byte (2 registers)
  frame[6] = 0x04;              // Byte count (2 registers * 2 bytes = 4)
  frame[7] = (uint16_t)leftVel >> 8;    // Left velocity high byte
  frame[8] = (uint16_t)leftVel & 0xFF;  // Left velocity low byte
  frame[9] = (uint16_t)rightVel >> 8;   // Right velocity high byte
  frame[10] = (uint16_t)rightVel & 0xFF; // Right velocity low byte

  uint16_t crc = modbusCRC(frame, 11);
  frame[11] = crc & 0xFF;
  frame[12] = crc >> 8;

  Serial3.write(frame, 13);
  Serial3.flush();
  delay(5);
  return true;
}

// ===== SET DRIVER ACCELERATION TIMES =====
// Call this when switching between normal and turn mode
void setAccelTimes(uint16_t accelMs, uint16_t decelMs) {
  // Driver 1
  sendModbusWrite(1, REG_ACCEL_LEFT, accelMs);
  sendModbusWrite(1, REG_ACCEL_RIGHT, accelMs);
  sendModbusWrite(1, REG_DECEL_LEFT, decelMs);
  sendModbusWrite(1, REG_DECEL_RIGHT, decelMs);
  // Driver 2
  sendModbusWrite(2, REG_ACCEL_LEFT, accelMs);
  sendModbusWrite(2, REG_ACCEL_RIGHT, accelMs);
  sendModbusWrite(2, REG_DECEL_LEFT, decelMs);
  sendModbusWrite(2, REG_DECEL_RIGHT, decelMs);
}

// ===== FULL DRIVER RESET AND INITIALIZATION =====
void fullReset() {
  Serial.println("=== FULL DRIVER RESET ===");

  // Step 1: Stop all motors immediately
  Serial.println("1. Stopping motors...");
  sendModbusSyncVelocity(1, 0, 0);
  sendModbusSyncVelocity(2, 0, 0);
  delay(100);

  // Step 2: Clear any faults
  Serial.println("2. Clearing faults...");
  sendModbusWrite(1, REG_CONTROL_WORD, 0x06);  // Clear fault
  sendModbusWrite(2, REG_CONTROL_WORD, 0x06);
  delay(100);

  // Step 3: Set synchronous control mode (both motors move together)
  Serial.println("3. Setting synchronous mode...");
  sendModbusWrite(1, REG_SYNC_MODE, 0x00);  // 0 = synchronous
  sendModbusWrite(2, REG_SYNC_MODE, 0x00);
  delay(50);

  // Step 4: Set velocity control mode
  Serial.println("4. Setting velocity mode...");
  sendModbusWrite(1, REG_CONTROL_MODE, 3);  // 3 = velocity mode
  sendModbusWrite(2, REG_CONTROL_MODE, 3);
  delay(50);

  // Step 5: Set acceleration/deceleration times (BOTH axes on each driver)
  Serial.println("5. Setting accel/decel times...");
  // Driver 1
  sendModbusWrite(1, REG_ACCEL_LEFT, 300);   // 300ms accel
  sendModbusWrite(1, REG_ACCEL_RIGHT, 300);  // Both motors same accel
  sendModbusWrite(1, REG_DECEL_LEFT, 200);   // 200ms decel
  sendModbusWrite(1, REG_DECEL_RIGHT, 200);
  // Driver 2
  sendModbusWrite(2, REG_ACCEL_LEFT, 300);
  sendModbusWrite(2, REG_ACCEL_RIGHT, 300);
  sendModbusWrite(2, REG_DECEL_LEFT, 200);
  sendModbusWrite(2, REG_DECEL_RIGHT, 200);
  delay(50);

  // Step 6: Open brakes (0 = open/released)
  Serial.println("6. Releasing brakes...");
  sendModbusWrite(1, REG_BRAKE_LEFT, 0);
  sendModbusWrite(1, REG_BRAKE_RIGHT, 0);
  sendModbusWrite(2, REG_BRAKE_LEFT, 0);
  sendModbusWrite(2, REG_BRAKE_RIGHT, 0);
  delay(100);

  // Step 7: Enable drivers
  Serial.println("7. Enabling drivers...");
  sendModbusWrite(1, REG_CONTROL_WORD, 0x08);  // Enable
  sendModbusWrite(2, REG_CONTROL_WORD, 0x08);
  delay(100);

  // Step 8: Zero velocities
  Serial.println("8. Zeroing velocities...");
  sendModbusSyncVelocity(1, 0, 0);
  sendModbusSyncVelocity(2, 0, 0);
  delay(50);

  motorsEnabled = true;
  emergencyStop = false;
  lastLeftSpeed = 0;
  lastRightSpeed = 0;

  Serial.println("=== RESET COMPLETE ===\n");
}

// ===== SET DRIVER SPEED (SYNCHRONIZED BOTH AXES) =====
// Each driver controls 2 motors - we send the SAME speed to BOTH
// so they spin at identical RPM
void setDriverSpeed(uint8_t driverID, int16_t speed) {
  // Apply inversion based on wheel test results
  if (driverID == 1 && INVERT_DRIVER_1) {
    speed = -speed;
  }
  if (driverID == 2 && INVERT_DRIVER_2) {
    speed = -speed;
  }

  // Clamp speed
  if (speed > MAX_SPEED_RPM) speed = MAX_SPEED_RPM;
  if (speed < -MAX_SPEED_RPM) speed = -MAX_SPEED_RPM;

  // Send SAME speed to BOTH motors on this driver using sync write
  // This ensures both wheels on same side spin at exactly the same speed
  sendModbusSyncVelocity(driverID, speed, speed);
}

// ===== EMERGENCY STOP =====
void emergencyStopMotors() {
  Serial.println("[E-STOP] Stopping all motors!");

  // Send stop command
  sendModbusWrite(1, REG_CONTROL_WORD, 0x05);  // Emergency stop
  sendModbusWrite(2, REG_CONTROL_WORD, 0x05);

  // Zero velocities
  sendModbusSyncVelocity(1, 0, 0);
  sendModbusSyncVelocity(2, 0, 0);

  emergencyStop = true;
  motorsEnabled = false;
  lastLeftSpeed = 0;
  lastRightSpeed = 0;
}

// ===== TANK DRIVE CALCULATION =====
// Single joystick tank steering: Y = forward/back, X = turn
// Detects pivot turns and applies lower speed limit
void calculateTankSpeeds(long lx, long ly, int16_t& leftSpeed, int16_t& rightSpeed) {
  // Normalize joystick values to -1.0 to 1.0
  float x = -constrain(lx, -511, 511) / 511.0f;  // Invert X for correct steering
  float y = -constrain(ly, -511, 511) / 511.0f;  // Invert Y (forward = positive)

  // Apply deadzone
  if (abs(x) < JOYSTICK_DEADZONE) x = 0.0f;
  if (abs(y) < JOYSTICK_DEADZONE) y = 0.0f;

  // Detect pivot turn: significant X input with little/no Y input
  // This is when the bounce happens - wheels fighting each other
  float turnRatio = (abs(y) < 0.1f) ? 1.0f : abs(x) / (abs(y) + 0.01f);
  isTurning = (abs(x) > 0.2f && turnRatio > 0.8f);

  // Tank mixing: left = Y + X, right = Y - X
  float leftPower = y + x;
  float rightPower = y - x;

  // Normalize if over 1.0
  float maxPower = max(abs(leftPower), abs(rightPower));
  if (maxPower > 1.0f) {
    leftPower /= maxPower;
    rightPower /= maxPower;
  }

  // Apply different speed limits based on turn detection
  int16_t maxRpm = isTurning ? MAX_TURN_RPM : MAX_SPEED_RPM;

  // Convert to RPM
  leftSpeed = (int16_t)(leftPower * maxRpm);
  rightSpeed = (int16_t)(rightPower * maxRpm);
}

// ===== SMOOTH SPEED RAMPING =====
// Uses slower rate during turns to reduce bounce
int16_t rampSpeed(int16_t current, int16_t target) {
  int16_t rate = isTurning ? ACCEL_RATE_TURN : ACCEL_RATE_NORMAL;

  if (current < target) {
    current += rate;
    if (current > target) current = target;
  } else if (current > target) {
    current -= rate;
    if (current < target) current = target;
  }
  return current;
}

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);  // ESP32 controller bridge
  Serial3.begin(115200);  // ZLAC8015D motor drivers

  delay(2000);

  Serial.println("\n========================================");
  Serial.println("  CEMANI HOMESTEAD ROBOT - TANK DRIVE");
  Serial.println("  V2.1 - Smooth Turn Mode");
  Serial.println("========================================");
  Serial.println("Hardware: Teensy 4.1 + 2x ZLAC8015D");
  Serial.println("Motors: 4 hub motors (2 per driver)");
  Serial.println("----------------------------------------");
  Serial.println("Turn detection: slower speed + accel");
  Serial.printf("  Normal: %d RPM, %dms accel\n", MAX_SPEED_RPM, DRIVER_ACCEL_NORMAL);
  Serial.printf("  Turn:   %d RPM, %dms accel\n", MAX_TURN_RPM, DRIVER_ACCEL_TURN);
  Serial.println("----------------------------------------");
  Serial.println("Controls:");
  Serial.println("  Left Stick  = Tank drive (Y=fwd, X=turn)");
  Serial.println("  START       = Emergency Stop");
  Serial.println("  BACK        = Resume/Clear E-Stop");
  Serial.println("  A Button    = Reset drivers");
  Serial.println("========================================\n");

  // Initialize motor drivers
  fullReset();

  Serial.println(">>> READY TO DRIVE <<<\n");
}

// ===== MAIN LOOP =====
void loop() {
  static char buf[128];
  static int n = 0;
  uint32_t now = millis();

  // ===== PARSE CONTROLLER INPUT FROM ESP32 =====
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\r') continue;

    if (c == '\n' || n >= 127) {
      buf[n] = 0;
      n = 0;
      lastComm = now;

      // Controller connection state
      if (strncmp(buf, "STATE,CONNECTED", 15) == 0) {
        controllerConnected = true;
        emergencyStop = false;
        Serial.println("[CTRL] Controller connected");
      }
      else if (strncmp(buf, "STATE,DISCONNECTED", 18) == 0) {
        controllerConnected = false;
        emergencyStopMotors();
        Serial.println("[CTRL] Controller disconnected - STOPPING");
      }
      // Axis data: AX,LX,value,timestamp
      else if (strncmp(buf, "AX,", 3) == 0) {
        char name[3];
        long val;
        unsigned long ms;
        if (sscanf(buf, "AX,%2[^,],%ld,%lu", name, &val, &ms) == 3) {
          controllerConnected = true;
          if (strcmp(name, "LX") == 0) currentLX = val;
          else if (strcmp(name, "LY") == 0) currentLY = val;
        }
      }
      // Button data: BTN,id,state,timestamp
      else if (strncmp(buf, "BTN,", 4) == 0) {
        long id, state;
        unsigned long ms;
        if (sscanf(buf, "BTN,%ld,%ld,%lu", &id, &state, &ms) == 3) {
          if (state == 1) {  // Button pressed
            if (id == 7) {  // START = Emergency Stop
              emergencyStopMotors();
              Serial.println("[BTN] START pressed - E-STOP ACTIVATED");
            }
            else if (id == 6) {  // BACK = Resume
              Serial.println("[BTN] BACK pressed - Resuming...");
              fullReset();
            }
            else if (id == 0) {  // A = Reset drivers
              Serial.println("[BTN] A pressed - Resetting drivers...");
              fullReset();
            }
          }
        }
      }
    } else {
      buf[n++] = c;
    }
  }

  // ===== MOTOR CONTROL UPDATE =====
  if (controllerConnected && !emergencyStop && motorsEnabled) {
    if (now - lastMotorUpdate >= MOTOR_UPDATE_INTERVAL) {
      lastMotorUpdate = now;

      // Calculate target speeds from joystick (also sets isTurning flag)
      calculateTankSpeeds(currentLX, currentLY, targetLeftSpeed, targetRightSpeed);

      // Detect turn mode change - update driver acceleration times
      if (isTurning != lastTurnState) {
        if (isTurning) {
          Serial.println("[TURN MODE] Slow accel");
          setAccelTimes(DRIVER_ACCEL_TURN, DRIVER_ACCEL_TURN);
        } else {
          Serial.println("[NORMAL MODE] Fast accel");
          setAccelTimes(DRIVER_ACCEL_NORMAL, DRIVER_ACCEL_NORMAL / 2);
        }
        lastTurnState = isTurning;
      }

      // Apply ramping for smooth acceleration
      int16_t newLeft = rampSpeed(lastLeftSpeed, targetLeftSpeed);
      int16_t newRight = rampSpeed(lastRightSpeed, targetRightSpeed);

      // Only send if speed changed significantly (reduces bus traffic)
      if (abs(newLeft - lastLeftSpeed) > 2 || abs(newRight - lastRightSpeed) > 2) {
        // Send to both drivers
        setDriverSpeed(1, newLeft);   // Driver 1 = Left side (2 wheels)
        setDriverSpeed(2, newRight);  // Driver 2 = Right side (2 wheels)

        lastLeftSpeed = newLeft;
        lastRightSpeed = newRight;

        // Debug output (only when moving)
        if (abs(newLeft) > 5 || abs(newRight) > 5) {
          Serial.printf("L:%+4d  R:%+4d RPM  %s\n", newLeft, newRight, isTurning ? "[TURN]" : "");
        }
      }
    }
  }

  // ===== SAFETY: Controller timeout =====
  if (now - lastComm > 5000 && controllerConnected) {
    controllerConnected = false;
    emergencyStopMotors();
    Serial.println("[TIMEOUT] No controller data - E-STOP");
  }

  // ===== ECHO DRIVER RESPONSES (for debugging) =====
  while (Serial3.available()) {
    uint8_t b = Serial3.read();
    // Uncomment to see raw responses:
    // Serial.printf("%02X ", b);
  }
}
