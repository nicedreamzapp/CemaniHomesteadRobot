// ===== DRIVER TELEMETRY =====
// Read and send motor driver telemetry
// =====================================================

#ifndef TELEMETRY_H
#define TELEMETRY_H

#include <Arduino.h>

// Telemetry state variables
extern uint16_t telemetry_busVoltage;
extern uint16_t telemetry_motorTemp;
extern uint16_t telemetry_driverTemp1;
extern uint16_t telemetry_driverTemp2;
extern int16_t telemetry_velocityL;
extern int16_t telemetry_velocityR;
extern int16_t telemetry_torqueL;
extern int16_t telemetry_torqueR;
extern int32_t telemetry_positionL;
extern int32_t telemetry_positionR;

// Read one telemetry register per call (rotating)
void readDriverTelemetry();

// Send telemetry to ESP32
void sendTelemetryToESP32();

// Utility
float celsiusToFahrenheit(float celsius);

#endif // TELEMETRY_H
