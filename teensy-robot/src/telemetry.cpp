// ===== DRIVER TELEMETRY =====
// Read and send motor driver telemetry
// =====================================================

#include "telemetry.h"
#include "modbus.h"
#include "config.h"

// Telemetry state variables
uint16_t telemetry_busVoltage = 0;
uint16_t telemetry_motorTemp = 0;
uint16_t telemetry_driverTemp1 = 0;
uint16_t telemetry_driverTemp2 = 0;
int16_t telemetry_velocityL = 0;
int16_t telemetry_velocityR = 0;
int16_t telemetry_torqueL = 0;
int16_t telemetry_torqueR = 0;
int32_t telemetry_positionL = 0;
int32_t telemetry_positionR = 0;

// Read telemetry from driver - ONE register per call to minimize interference
static uint8_t telemReadIndex = 0;

float celsiusToFahrenheit(float celsius) {
  return celsius * 9.0f / 5.0f + 32.0f;
}

void readDriverTelemetry() {
  int32_t val;

  // Read one register per cycle to minimize interference with motor commands
  switch (telemReadIndex) {
    case 0:
      // Bus voltage from driver 1 (register 0x20A1) - battery voltage
      val = readModbusRegister(1, 0x20A1);
      if (val >= 0) telemetry_busVoltage = (uint16_t)val;
      break;
    case 1:
      // Motor temperature from driver 1 (register 0x20A4)
      val = readModbusRegister(1, 0x20A4);
      if (val >= 0) telemetry_motorTemp = (uint16_t)val;
      break;
    case 2:
      // Driver 1 temperature (register 0x20B0)
      val = readModbusRegister(1, 0x20B0);
      if (val >= 0) telemetry_driverTemp1 = (uint16_t)val;
      break;
    case 3:
      // Driver 2 temperature
      val = readModbusRegister(2, 0x20B0);
      if (val >= 0) telemetry_driverTemp2 = (uint16_t)val;
      break;
    case 4:
      // Actual velocity from Driver 2 (LEFT side) - read left motor
      val = readModbusRegister(2, 0x20AB);
      if (val >= 0) {
        telemetry_velocityL = (int16_t)val;
        // Driver 2 is not inverted, so velocity sign is correct
      }
      break;
    case 5:
      // Actual velocity from Driver 1 (RIGHT side) - read left motor (both motors same speed)
      val = readModbusRegister(1, 0x20AB);
      if (val >= 0) {
        telemetry_velocityR = (int16_t)val;
        // Driver 1 IS inverted in config, so negate to show true direction
        if (INVERT_DRIVER_1) {
          telemetry_velocityR = -telemetry_velocityR;
        }
      }
      break;
  }

  telemReadIndex = (telemReadIndex + 1) % 6;
}

void sendTelemetryToESP32() {
  // Convert values and send as CSV format
  float batteryV = telemetry_busVoltage * 0.01f;
  // 24V LiFePO4 8S: 20V=0%, 29.2V=100% (9.2V range)
  int batteryPercent = constrain((int)((batteryV - 20.0f) / 9.2f * 100.0f), 0, 100);

  // Motor temps (1C per unit, high byte = L, low byte = R)
  int motorTempL_C = (telemetry_motorTemp >> 8) & 0xFF;
  int motorTempR_C = telemetry_motorTemp & 0xFF;
  int motorTempL_F = (int)celsiusToFahrenheit(motorTempL_C);
  int motorTempR_F = (int)celsiusToFahrenheit(motorTempR_C);

  // Driver temps (0.1C per unit)
  float driverTemp1_C = telemetry_driverTemp1 * 0.1f;
  float driverTemp2_C = telemetry_driverTemp2 * 0.1f;
  int driverTemp1_F = (int)celsiusToFahrenheit(driverTemp1_C);
  int driverTemp2_F = (int)celsiusToFahrenheit(driverTemp2_C);

  // Velocities (0.1 RPM per unit)
  float velL = telemetry_velocityL * 0.1f;
  float velR = telemetry_velocityR * 0.1f;

  // Torque (0.1A per unit)
  float torqueL = telemetry_torqueL * 0.1f;
  float torqueR = telemetry_torqueR * 0.1f;

  // Send to ESP32 via Serial1
  Serial1.printf("TELEM,%.2f,%d,%d,%d,%d,%d,%.1f,%.1f,%.1f,%.1f,%ld,%ld\n",
    batteryV, batteryPercent,
    motorTempL_F, motorTempR_F,
    driverTemp1_F, driverTemp2_F,
    velL, velR,
    torqueL, torqueR,
    telemetry_positionL, telemetry_positionR
  );

  // Send version every 10 telemetry cycles (~10 seconds)
  static uint8_t versionCounter = 0;
  if (++versionCounter >= 10) {
    versionCounter = 0;
    Serial1.printf("TEENSY_VERSION,%s\n", TEENSY_VERSION);
  }

  // Also print to USB Serial for debugging
  Serial.println("===== DRIVER TELEMETRY =====");
  Serial.printf("Battery: %.2fV (%d%%)\n", batteryV, batteryPercent);
  Serial.printf("Motor Temp L: %d°F  R: %d°F\n", motorTempL_F, motorTempR_F);
  Serial.printf("Driver Temp 1: %d°F  2: %d°F\n", driverTemp1_F, driverTemp2_F);
  Serial.printf("Velocity L: %.1f RPM  R: %.1f RPM\n", velL, velR);
  Serial.printf("Torque L: %.1fA  R: %.1fA\n", torqueL, torqueR);
  Serial.printf("Position L: %ld  R: %ld\n", telemetry_positionL, telemetry_positionR);
  Serial.println("============================\n");
}
