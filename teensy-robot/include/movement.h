// ===== MOVEMENT CONTROL =====
// Tank steering, joystick, and discrete move commands
// =====================================================

#ifndef MOVEMENT_H
#define MOVEMENT_H

#include <Arduino.h>

// Movement state variables
extern bool discreteMoveActive;
extern int discreteTurnDegrees;
extern int discreteDistanceCm;
extern uint32_t discreteMoveStartTime;
extern int discreteMovePhase;
extern bool discreteMoveBackward;
extern bool firstMoveAfterStartup;
extern int robotFacingAngle;
extern bool isTurning;
extern bool controllerConnected;
extern long currentLX, currentLY;
extern int16_t targetLeftSpeed, targetRightSpeed;

// Joystick control
float applyJoystickCurve(float input);
void calculateTankSpeeds(long lx, long ly, int16_t& leftSpeed, int16_t& rightSpeed, bool turboActive = false);
int16_t rampSpeed(int16_t current, int16_t target);

// Discrete movement commands
void startRelativeMove(char direction, int distanceCm);
void startDiscreteMoveDirection(char direction, int distanceCm);
void startDiscreteMove(int turnDegrees, int distanceCm);
void updateDiscreteMove();

#endif // MOVEMENT_H
