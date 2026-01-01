// ===== SAFETY MODULE =====
// Obstacle avoidance + tilt detection
// =============================

#include "safety.h"
#include "ultrasonic.h"
#include "telemetry.h"

// Current safety state
SafetyState currentSafetyState = SAFETY_OK;
bool safetyOverride = false;

// Last status send time
static uint32_t lastStatusSend = 0;

// Smoothed obstacle distances (to reduce noise)
static float smoothFL = 0, smoothFR = 0, smoothRL = 0, smoothRR = 0;
static const float SMOOTH_FACTOR = 0.3f;  // Lower = more smoothing

void safetyInit() {
  currentSafetyState = SAFETY_OK;
  safetyOverride = false;
  Serial.println("[SAFETY] Obstacle avoidance + tilt detection initialized");
  Serial.printf("[SAFETY] Stop distance: %dcm, Slow distance: %dcm\n",
    OBSTACLE_STOP_CM, OBSTACLE_SLOW_CM);
}

// Smooth a distance reading (0 values = no reading, keep previous)
static float smoothDistance(float newVal, float prevSmooth) {
  if (newVal <= 0) return prevSmooth;  // Keep previous if no reading
  if (prevSmooth <= 0) return newVal;  // First valid reading
  return prevSmooth + SMOOTH_FACTOR * (newVal - prevSmooth);
}

bool safetyCheck(int16_t targetSpeedL, int16_t targetSpeedR) {
  // Update smoothed distances (0 = no reading, filtered by min range)
  smoothFL = smoothDistance(distFL, smoothFL);
  smoothFR = smoothDistance(distFR, smoothFR);
  smoothRL = smoothDistance(distRL, smoothRL);
  smoothRR = smoothDistance(distRR, smoothRR);

  // Determine if moving forward or backward
  bool movingForward = (targetSpeedL > 5 || targetSpeedR > 5);
  bool movingBackward = (targetSpeedL < -5 || targetSpeedR < -5);

  // Check front obstacles when moving forward
  if (movingForward) {
    float minFront = 9999;
    if (smoothFL > 0) minFront = min(minFront, smoothFL);
    if (smoothFR > 0) minFront = min(minFront, smoothFR);

    if (minFront < OBSTACLE_STOP_CM && minFront > 0) {
      if (currentSafetyState != SAFETY_OBSTACLE_FRONT) {
        currentSafetyState = SAFETY_OBSTACLE_FRONT;
        safetyOverride = true;
        Serial.printf("[SAFETY] STOP! Front obstacle at %.0fcm\n", minFront);
        Serial1.printf("SAFETY,OBSTACLE_FRONT,%.0f\n", minFront);
      }
      return true;  // Stop!
    }
  }

  // Check rear obstacles when moving backward
  if (movingBackward) {
    float minRear = 9999;
    if (smoothRL > 0) minRear = min(minRear, smoothRL);
    if (smoothRR > 0) minRear = min(minRear, smoothRR);

    if (minRear < OBSTACLE_STOP_CM && minRear > 0) {
      if (currentSafetyState != SAFETY_OBSTACLE_REAR) {
        currentSafetyState = SAFETY_OBSTACLE_REAR;
        safetyOverride = true;
        Serial.printf("[SAFETY] STOP! Rear obstacle at %.0fcm\n", minRear);
        Serial1.printf("SAFETY,OBSTACLE_REAR,%.0f\n", minRear);
      }
      return true;  // Stop!
    }
  }

  // Check tilt using motor torque (from telemetry)
  extern int16_t telemetry_torqueL;
  extern int16_t telemetry_torqueR;

  if (safetyCheckTilt(telemetry_torqueL, telemetry_torqueR)) {
    safetyOverride = true;
    return true;  // Stop!
  }

  // All clear
  if (currentSafetyState != SAFETY_OK) {
    currentSafetyState = SAFETY_OK;
    safetyOverride = false;
    Serial.println("[SAFETY] Clear - resuming");
    Serial1.println("SAFETY,CLEAR");
  }

  return false;  // OK to move
}

float safetyGetSpeedLimit(bool movingForward) {
  float minDist = 9999;

  if (movingForward) {
    if (smoothFL > 0) minDist = min(minDist, smoothFL);
    if (smoothFR > 0) minDist = min(minDist, smoothFR);
  } else {
    if (smoothRL > 0) minDist = min(minDist, smoothRL);
    if (smoothRR > 0) minDist = min(minDist, smoothRR);
  }

  if (minDist >= 9999 || minDist <= 0) {
    return 1.0f;  // No reading = full speed (rely on LIDAR/other sensors)
  }

  if (minDist < OBSTACLE_STOP_CM) {
    return 0.0f;  // Stop
  } else if (minDist < OBSTACLE_SLOW_CM) {
    // Linear ramp from 0.3 to 1.0 between stop and slow distances
    float ratio = (minDist - OBSTACLE_STOP_CM) / (OBSTACLE_SLOW_CM - OBSTACLE_STOP_CM);
    return 0.3f + 0.7f * ratio;
  } else if (minDist < OBSTACLE_WARN_CM) {
    // Slight slowdown in warning zone
    return 0.8f;
  }

  return 1.0f;  // Full speed
}

bool safetyCheckTilt(int16_t torqueL, int16_t torqueR) {
  // Only check when motors are actively driving (not idle)
  extern int16_t lastLeftSpeed;
  extern int16_t lastRightSpeed;

  bool motorsActive = (abs(lastLeftSpeed) > 10 || abs(lastRightSpeed) > 10);
  if (!motorsActive) return false;

  // Convert to absolute values (torque can be negative)
  int16_t absL = abs(torqueL);
  int16_t absR = abs(torqueR);

  // Check for wheel lift (one wheel near zero torque, other high)
  // Left wheel lifting
  if (absL < TILT_TORQUE_MIN && absR > TILT_TORQUE_IMBALANCE) {
    if (currentSafetyState != SAFETY_TILT_LEFT) {
      currentSafetyState = SAFETY_TILT_LEFT;
      Serial.printf("[SAFETY] TILT WARNING! Left wheel may be lifting (L:%d R:%d)\n", absL, absR);
      Serial1.printf("SAFETY,TILT_LEFT,%d,%d\n", absL, absR);
    }
    return true;
  }

  // Right wheel lifting
  if (absR < TILT_TORQUE_MIN && absL > TILT_TORQUE_IMBALANCE) {
    if (currentSafetyState != SAFETY_TILT_RIGHT) {
      currentSafetyState = SAFETY_TILT_RIGHT;
      Serial.printf("[SAFETY] TILT WARNING! Right wheel may be lifting (L:%d R:%d)\n", absL, absR);
      Serial1.printf("SAFETY,TILT_RIGHT,%d,%d\n", absL, absR);
    }
    return true;
  }

  return false;
}

// Collision detection and auto-recovery
static uint32_t collisionStartTime = 0;
static int16_t collisionRecoveryDirection = 0;  // -1 = was going forward (reverse), +1 = was going back (forward)

int16_t safetyCheckCollision(int16_t torqueL, int16_t torqueR, int16_t currentSpeedL, int16_t currentSpeedR) {
  uint32_t now = millis();

  // If in recovery mode, continue recovering
  if (currentSafetyState == SAFETY_COLLISION_RECOVERY) {
    if (now - collisionStartTime < COLLISION_RECOVERY_MS) {
      // Still recovering - return recovery speed
      return collisionRecoveryDirection * 15;  // Slow recovery speed (15 RPM)
    } else {
      // Recovery complete
      currentSafetyState = SAFETY_OK;
      safetyOverride = false;
      collisionRecoveryDirection = 0;
      Serial.println("[SAFETY] Collision recovery complete");
      Serial1.println("SAFETY,COLLISION_RECOVERY_DONE");
      return 0;
    }
  }

  // Check for new collision (high torque on either motor while moving)
  int16_t absL = abs(torqueL);
  int16_t absR = abs(torqueR);
  bool motorsActive = (abs(currentSpeedL) > 5 || abs(currentSpeedR) > 5);

  if (!motorsActive) return 0;

  // Collision = high torque spike
  if (absL > COLLISION_TORQUE_THRESHOLD || absR > COLLISION_TORQUE_THRESHOLD) {
    currentSafetyState = SAFETY_COLLISION;
    safetyOverride = true;
    collisionStartTime = now;

    // Determine recovery direction (opposite of current travel)
    bool wasGoingForward = (currentSpeedL > 0 || currentSpeedR > 0);
    collisionRecoveryDirection = wasGoingForward ? -1 : 1;

    Serial.printf("[SAFETY] COLLISION! Torque spike L:%d R:%d - reversing %s\n",
                  absL, absR, wasGoingForward ? "backward" : "forward");
    Serial1.printf("SAFETY,COLLISION,%d,%d,%s\n", absL, absR, wasGoingForward ? "REVERSE" : "FORWARD");

    // Immediately transition to recovery
    currentSafetyState = SAFETY_COLLISION_RECOVERY;
    return collisionRecoveryDirection * 15;
  }

  return 0;  // No collision
}

void safetySendStatus() {
  uint32_t now = millis();
  if (now - lastStatusSend < 500) return;  // Max 2Hz
  lastStatusSend = now;

  // Send current safety state
  const char* stateStr;
  switch (currentSafetyState) {
    case SAFETY_OK: stateStr = "OK"; break;
    case SAFETY_OBSTACLE_FRONT: stateStr = "OBSTACLE_FRONT"; break;
    case SAFETY_OBSTACLE_REAR: stateStr = "OBSTACLE_REAR"; break;
    case SAFETY_TILT_LEFT: stateStr = "TILT_LEFT"; break;
    case SAFETY_TILT_RIGHT: stateStr = "TILT_RIGHT"; break;
    case SAFETY_COLLISION: stateStr = "COLLISION"; break;
    case SAFETY_COLLISION_RECOVERY: stateStr = "COLLISION_RECOVERY"; break;
    case SAFETY_ESTOP: stateStr = "ESTOP"; break;
    default: stateStr = "UNKNOWN"; break;
  }

  Serial1.printf("SAFETY_STATUS,%s,%.0f,%.0f,%.0f,%.0f\n",
    stateStr, smoothFL, smoothFR, smoothRL, smoothRR);
}

void safetyReset() {
  currentSafetyState = SAFETY_OK;
  safetyOverride = false;
  Serial.println("[SAFETY] Reset - safety override cleared");
  Serial1.println("SAFETY,RESET");
}
