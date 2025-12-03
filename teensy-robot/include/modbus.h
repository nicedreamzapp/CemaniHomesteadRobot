// ===== MODBUS COMMUNICATION =====
// CRC, register read/write functions for ZLAC8015D drivers
// =====================================================

#ifndef MODBUS_H
#define MODBUS_H

#include <Arduino.h>

// CRC-16 calculation
uint16_t modbusCRC(const uint8_t* buf, int len);

// Read single register from driver
int32_t readModbusRegister(uint8_t id, uint16_t reg);

// Write single register to driver
bool sendModbusWrite(uint8_t id, uint16_t reg, int16_t value);

// Write sync velocity to driver (both wheels)
bool sendModbusSyncVelocity(uint8_t id, int16_t leftVel, int16_t rightVel);

// Set acceleration/deceleration times
void setAccelTimes(uint16_t accelMs, uint16_t decelMs);

// Set torque limits
void setTorqueLimits(uint16_t torqueLimit);

// Full driver reset sequence
void fullReset();

// Set individual driver speed
void setDriverSpeed(uint8_t driverID, int16_t speed);

// Emergency stop all motors
void emergencyStopMotors();

// External state variables (defined in main.cpp)
extern bool emergencyStop;
extern bool motorsEnabled;
extern int16_t lastLeftSpeed;
extern int16_t lastRightSpeed;

#endif // MODBUS_H
