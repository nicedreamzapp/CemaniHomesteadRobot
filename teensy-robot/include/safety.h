// ===== SAFETY MODULE =====
// Obstacle avoidance + tilt detection
// =============================

#ifndef SAFETY_H
#define SAFETY_H

#include <Arduino.h>

// Safety thresholds - more cautious to prevent crashes
#define OBSTACLE_STOP_CM 50       // Stop if obstacle closer than 50cm (~20 inches)
#define OBSTACLE_SLOW_CM 80       // Slow down if obstacle closer than 80cm (~32 inches)
#define OBSTACLE_WARN_CM 100      // Warn if obstacle closer than 100cm (~40 inches)

// Tilt detection thresholds (torque in 0.1A units)
#define TILT_TORQUE_MIN 5         // Minimum torque to consider wheel on ground
#define TILT_TORQUE_IMBALANCE 50  // Max torque difference before tilt warning

// Collision detection thresholds (torque in 0.1A units)
#define COLLISION_TORQUE_THRESHOLD 120  // Torque spike = hitting something (12A)
#define COLLISION_RECOVERY_MS 600       // How long to reverse after collision

// Safety states
enum SafetyState {
  SAFETY_OK = 0,
  SAFETY_OBSTACLE_FRONT,
  SAFETY_OBSTACLE_REAR,
  SAFETY_TILT_LEFT,
  SAFETY_TILT_RIGHT,
  SAFETY_COLLISION,       // Hit something - torque spike detected
  SAFETY_COLLISION_RECOVERY,  // Reversing after collision
  SAFETY_ESTOP
};

// Current safety state
extern SafetyState currentSafetyState;
extern bool safetyOverride;  // True if safety system stopped motors

// Initialize safety system
void safetyInit();

// Check all safety conditions - call every loop iteration
// Returns true if robot should stop
bool safetyCheck(int16_t targetSpeedL, int16_t targetSpeedR);

// Get speed limit based on obstacles (1.0 = full speed, 0.0 = stop)
float safetyGetSpeedLimit(bool movingForward);

// Check for tilt using motor torque
bool safetyCheckTilt(int16_t torqueL, int16_t torqueR);

// Check for collision (torque spike on both motors)
// Returns recovery speed: 0 = no collision, negative = reverse, positive = forward
int16_t safetyCheckCollision(int16_t torqueL, int16_t torqueR, int16_t currentSpeedL, int16_t currentSpeedR);

// Send safety status to ESP32
void safetySendStatus();

// Reset safety state (after user acknowledges)
void safetyReset();

#endif // SAFETY_H
