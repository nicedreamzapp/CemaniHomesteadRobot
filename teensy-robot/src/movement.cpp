// ===== MOVEMENT CONTROL =====
// Tank steering, joystick, and discrete move commands
// =====================================================

#include "movement.h"
#include "modbus.h"
#include "config.h"

// Movement state variables
bool discreteMoveActive = false;
int discreteTurnDegrees = 0;
int discreteDistanceCm = 0;
uint32_t discreteMoveStartTime = 0;
int discreteMovePhase = 0;  // 0=idle, 1=turning, 2=moving
bool discreteMoveBackward = false;
bool firstMoveAfterStartup = true;
int robotFacingAngle = 0;
bool isTurning = false;
bool controllerConnected = false;
long currentLX = 0, currentLY = 0;
int16_t targetLeftSpeed = 0, targetRightSpeed = 0;

// ===== AEROSPACE-GRADE INPUT FILTERING STATE =====
// Moving average buffers for joystick inputs
static long lxBuffer[INPUT_FILTER_SAMPLES] = {0};
static long lyBuffer[INPUT_FILTER_SAMPLES] = {0};
static int filterIndex = 0;
static long filteredLX = 0, filteredLY = 0;

// Zero-state lockout (prevents oscillation around neutral)
static bool inZeroStateX = true;
static bool inZeroStateY = true;

// Previous filtered values for slew rate limiting
static long prevFilteredLX = 0, prevFilteredLY = 0;

// ===== AEROSPACE-GRADE INPUT FILTER =====
// Combines: moving average, slew rate limiting, zero-state hysteresis
void filterJoystickInput(long rawLX, long rawLY, long& outLX, long& outLY) {
  // 1. Add to moving average buffer
  lxBuffer[filterIndex] = rawLX;
  lyBuffer[filterIndex] = rawLY;
  filterIndex = (filterIndex + 1) % INPUT_FILTER_SAMPLES;

  // 2. Calculate moving average
  long avgLX = 0, avgLY = 0;
  for (int i = 0; i < INPUT_FILTER_SAMPLES; i++) {
    avgLX += lxBuffer[i];
    avgLY += lyBuffer[i];
  }
  avgLX /= INPUT_FILTER_SAMPLES;
  avgLY /= INPUT_FILTER_SAMPLES;

  // 3. Slew rate limiting (prevents noise spikes from causing sudden jumps)
  long deltaX = avgLX - prevFilteredLX;
  long deltaY = avgLY - prevFilteredLY;

  if (deltaX > MAX_INPUT_CHANGE_PER_CYCLE) deltaX = MAX_INPUT_CHANGE_PER_CYCLE;
  if (deltaX < -MAX_INPUT_CHANGE_PER_CYCLE) deltaX = -MAX_INPUT_CHANGE_PER_CYCLE;
  if (deltaY > MAX_INPUT_CHANGE_PER_CYCLE) deltaY = MAX_INPUT_CHANGE_PER_CYCLE;
  if (deltaY < -MAX_INPUT_CHANGE_PER_CYCLE) deltaY = -MAX_INPUT_CHANGE_PER_CYCLE;

  filteredLX = prevFilteredLX + deltaX;
  filteredLY = prevFilteredLY + deltaY;

  // 4. Zero-state hysteresis (prevents oscillation around neutral)
  // Once in zero state, must exceed lockout threshold to leave
  // Once outside zero, must drop below return threshold to go back to zero
  float normX = abs(filteredLX) / 511.0f;
  float normY = abs(filteredLY) / 511.0f;

  if (inZeroStateX) {
    if (normX > ZERO_LOCKOUT_THRESHOLD) {
      inZeroStateX = false;  // Leaving zero state
    } else {
      filteredLX = 0;  // Stay locked at zero
    }
  } else {
    if (normX < ZERO_RETURN_THRESHOLD) {
      inZeroStateX = true;  // Return to zero state
      filteredLX = 0;
    }
  }

  if (inZeroStateY) {
    if (normY > ZERO_LOCKOUT_THRESHOLD) {
      inZeroStateY = false;
    } else {
      filteredLY = 0;
    }
  } else {
    if (normY < ZERO_RETURN_THRESHOLD) {
      inZeroStateY = true;
      filteredLY = 0;
    }
  }

  // 5. Store for next cycle
  prevFilteredLX = filteredLX;
  prevFilteredLY = filteredLY;

  outLX = filteredLX;
  outLY = filteredLY;
}

// Aircraft-grade full stop - sends multiple zero commands to ensure complete stop
void fullStopMotors() {
  Serial.println("[STOP] Aircraft-grade motor stop - triple zero command");

  // Send stop commands 3 times with delays to ensure they are received
  for (int i = 0; i < 3; i++) {
    setDriverSpeed(1, 0);
    delay(20);
    setDriverSpeed(2, 0);
    delay(20);
  }

  // Reset all movement state
  targetLeftSpeed = 0;
  targetRightSpeed = 0;
  discreteMoveActive = false;
  discreteMovePhase = 0;

  Serial.println("[STOP] Motors confirmed stopped");
}

// Apply strong exponential curve - stays slow until ~75% joystick
// Uses cubic curve (x³) for very gradual low-end, fast high-end
float applyJoystickCurve(float input) {
  float sign = (input >= 0) ? 1.0f : -1.0f;
  float absInput = abs(input);
  // Cubic curve: 50% joystick = only 12.5% output, 75% = 42% output
  return sign * absInput * absInput * absInput;
}

void calculateTankSpeeds(long lx, long ly, int16_t& leftSpeed, int16_t& rightSpeed, bool turboActive) {
  // SAFETY: Hard clamp inputs first
  lx = constrain(lx, -511, 511);
  ly = constrain(ly, -511, 511);

  float x = -lx / 511.0f;
  float y = -ly / 511.0f;

  // Larger deadzone to filter noise
  if (abs(x) < JOYSTICK_DEADZONE) x = 0.0f;
  if (abs(y) < JOYSTICK_DEADZONE) y = 0.0f;

  // Apply exponential curve for finer control at low speeds
  x = applyJoystickCurve(x);
  y = applyJoystickCurve(y);

  // Detect turning (mostly side-to-side input)
  float turnRatio = (abs(y) < 0.1f) ? 1.0f : abs(x) / (abs(y) + 0.01f);
  isTurning = (abs(x) > 0.2f && turnRatio > 0.8f);

  float leftPower, rightPower;

  if (isTurning && abs(y) < 0.15f) {
    // PIVOT TURN: For in-place turning, one wheel drives forward,
    // the other stays stopped (0%). Robot pivots around the stopped wheel.
    // This eliminates wheel scrub - only one wheel moves, no fighting.
    float outerSpeed = abs(x);
    float innerSpeed = 0.0f;  // Inner wheel stopped - pure pivot

    if (x > 0) {
      // Turning right: left wheel forward, right wheel slow backward
      leftPower = outerSpeed;
      rightPower = innerSpeed;
    } else {
      // Turning left: right wheel forward, left wheel slow backward
      leftPower = innerSpeed;
      rightPower = outerSpeed;
    }
  } else {
    // NORMAL DRIVING: Standard tank mixing for driving with steering
    // When reversing, invert steering so left stick = left turn (intuitive driving)
    float steer = (y < 0) ? -x : x;

    leftPower = y + steer;
    rightPower = y - steer;

    // Normalize power to -1 to 1
    float maxPower = max(abs(leftPower), abs(rightPower));
    if (maxPower > 1.0f) {
      leftPower /= maxPower;
      rightPower /= maxPower;
    }
  }

  // Turbo only works for forward/backward, not turning
  int16_t forwardBackMax = (turboActive && !isTurning) ? TURBO_SPEED_RPM : MAX_SPEED_RPM;
  int16_t maxRpm = isTurning ? MAX_TURN_RPM : forwardBackMax;

  leftSpeed = (int16_t)(leftPower * maxRpm);
  rightSpeed = (int16_t)(rightPower * maxRpm);

  // SAFETY: Final hard clamp (use turbo max if turbo active, otherwise normal max)
  int16_t clampMax = turboActive ? TURBO_SPEED_RPM : MAX_SPEED_RPM;
  leftSpeed = constrain(leftSpeed, -clampMax, clampMax);
  rightSpeed = constrain(rightSpeed, -clampMax, clampMax);
}

int16_t rampSpeed(int16_t current, int16_t target, bool turboActive) {
  // Use faster ramp rate when turbo is active for quicker acceleration
  int16_t rate;
  if (turboActive && !isTurning) {
    rate = ACCEL_RATE_TURBO;  // Fast ramp for turbo
  } else if (isTurning) {
    rate = ACCEL_RATE_TURN;
  } else {
    rate = ACCEL_RATE_NORMAL;
  }

  if (current < target) {
    current += rate;
    if (current > target) current = target;
  } else if (current > target) {
    current -= rate;
    if (current < target) current = target;
  }

  // SAFETY: Hard clamp to max allowed speed based on turbo state
  // This ensures speed immediately drops when turbo is released
  int16_t maxAllowed = turboActive ? TURBO_SPEED_RPM : MAX_SPEED_RPM;
  current = constrain(current, -maxAllowed, maxAllowed);

  return current;
}

// Handle relative direction commands (F/B/L/R)
void startRelativeMove(char direction, int distanceCm) {
  // Auto-recover from emergency stop OR first move after startup
  if (emergencyStop || !motorsEnabled || firstMoveAfterStartup) {
    Serial.println("[MOVE] Initializing drivers for first move or recovery...");
    fullReset();
    delay(300);
    firstMoveAfterStartup = false;
    Serial.println("[MOVE] Drivers ready!");
  }

  // Set slow acceleration for smooth discrete moves (1000ms ramp)
  setAccelTimes(1000, 500);

  discreteMoveStartTime = millis();
  discreteMoveActive = true;

  if (direction == 'F') {
    discreteTurnDegrees = 0;
    discreteDistanceCm = distanceCm;
    discreteMoveBackward = false;
    discreteMovePhase = 2;
    Serial.printf("[MOVE] Forward %d cm\n", distanceCm);
    setDriverSpeed(1, DISCRETE_MOVE_RPM);
    delay(20);  // Give Modbus bus time between commands
    setDriverSpeed(2, DISCRETE_MOVE_RPM);
    Serial1.printf("MOVE_STATUS,FORWARD,%d\n", distanceCm);
  }
  else if (direction == 'B') {
    discreteTurnDegrees = 0;
    discreteDistanceCm = distanceCm;
    discreteMoveBackward = true;
    discreteMovePhase = 2;
    Serial.printf("[MOVE] Backward %d cm\n", distanceCm);
    setDriverSpeed(1, -DISCRETE_MOVE_RPM);
    delay(20);  // Give Modbus bus time between commands
    setDriverSpeed(2, -DISCRETE_MOVE_RPM);
    Serial1.printf("MOVE_STATUS,BACKWARD,%d\n", distanceCm);
  }
  else if (direction == 'L') {
    discreteTurnDegrees = -90;
    discreteDistanceCm = 0;
    discreteMoveBackward = false;
    discreteMovePhase = 1;
    Serial.println("[MOVE] Turn LEFT 90");
    setDriverSpeed(1, DISCRETE_TURN_RPM);
    delay(20);  // Give Modbus bus time between commands
    setDriverSpeed(2, -DISCRETE_TURN_RPM);
    Serial1.println("MOVE_STATUS,TURN_LEFT,90");
  }
  else if (direction == 'R') {
    discreteTurnDegrees = 90;
    discreteDistanceCm = 0;
    discreteMoveBackward = false;
    discreteMovePhase = 1;
    Serial.println("[MOVE] Turn RIGHT 90");
    setDriverSpeed(1, -DISCRETE_TURN_RPM);
    delay(20);  // Give Modbus bus time between commands
    setDriverSpeed(2, DISCRETE_TURN_RPM);
    Serial1.println("MOVE_STATUS,TURN_RIGHT,90");
  }
  else {
    Serial.printf("[MOVE] Unknown direction: %c\n", direction);
    discreteMoveActive = false;
    discreteMovePhase = 0;
  }
}

// Legacy compass direction support (N/E/S/W)
void startDiscreteMoveDirection(char direction, int distanceCm) {
  char relativeDir = 'F';
  if (direction == 'N') relativeDir = 'F';
  else if (direction == 'S') relativeDir = 'B';
  else if (direction == 'E') relativeDir = 'R';
  else if (direction == 'W') relativeDir = 'L';

  startRelativeMove(relativeDir, distanceCm);
}

// Legacy function for backward compatibility
void startDiscreteMove(int turnDegrees, int distanceCm) {
  if (!motorsEnabled || emergencyStop) {
    Serial.println("[MOVE] Cannot start - motors not enabled or E-stop active");
    Serial1.println("MOVE_ERROR,MOTORS_DISABLED");
    return;
  }

  discreteTurnDegrees = turnDegrees;
  discreteDistanceCm = distanceCm;
  discreteMoveBackward = false;
  discreteMoveStartTime = millis();
  discreteMoveActive = true;

  if (turnDegrees != 0) {
    discreteMovePhase = 1;
    int turnSpeed = (turnDegrees > 0) ? DISCRETE_TURN_RPM : -DISCRETE_TURN_RPM;
    setDriverSpeed(1, turnSpeed);
    setDriverSpeed(2, -turnSpeed);
    Serial.printf("[MOVE] Turning %d degrees...\n", turnDegrees);
    Serial1.printf("MOVE_STATUS,TURNING,%d\n", turnDegrees);
  } else if (distanceCm != 0) {
    discreteMovePhase = 2;
    int moveSpeed = DISCRETE_MOVE_RPM;
    setDriverSpeed(1, moveSpeed);
    setDriverSpeed(2, moveSpeed);
    Serial.printf("[MOVE] Moving %d cm...\n", distanceCm);
    Serial1.printf("MOVE_STATUS,MOVING,%d\n", distanceCm);
  } else {
    discreteMoveActive = false;
    discreteMovePhase = 0;
    Serial1.println("MOVE_COMPLETE");
  }
}

void updateDiscreteMove() {
  if (!discreteMoveActive) return;

  uint32_t now = millis();
  uint32_t elapsed = now - discreteMoveStartTime;

  if (discreteMovePhase == 1) {
    // Turning phase
    uint32_t turnDuration = abs(discreteTurnDegrees) * TURN_MS_PER_DEGREE;
    if (elapsed >= turnDuration) {
      // Turn complete - update robot facing angle
      robotFacingAngle += discreteTurnDegrees;
      while (robotFacingAngle < 0) robotFacingAngle += 360;
      while (robotFacingAngle >= 360) robotFacingAngle -= 360;

      Serial.printf("[MOVE] Turn complete (%lu ms), now facing %d\n", elapsed, robotFacingAngle);

      if (discreteDistanceCm != 0) {
        // Start move phase
        discreteMovePhase = 2;
        discreteMoveStartTime = millis();
        int moveSpeed = discreteMoveBackward ? -DISCRETE_MOVE_RPM : DISCRETE_MOVE_RPM;
        setDriverSpeed(1, moveSpeed);
        setDriverSpeed(2, moveSpeed);
        Serial.printf("[MOVE] Now moving %d cm %s...\n", discreteDistanceCm,
                      discreteMoveBackward ? "backward" : "forward");
        Serial1.printf("MOVE_STATUS,MOVING,%d\n", discreteDistanceCm);
      } else {
        // All done - use aircraft-grade full stop
        fullStopMotors();
        Serial.println("[MOVE] Complete!");
        Serial1.println("MOVE_COMPLETE");
      }
    }
  }
  else if (discreteMovePhase == 2) {
    // Moving phase
    uint32_t moveDuration = abs(discreteDistanceCm) * MOVE_MS_PER_CM;
    if (elapsed >= moveDuration) {
      // Move complete - use aircraft-grade full stop
      fullStopMotors();
      Serial.printf("[MOVE] Move complete (%lu ms)\n", elapsed);
      Serial1.println("MOVE_COMPLETE");
    }
  }
}
