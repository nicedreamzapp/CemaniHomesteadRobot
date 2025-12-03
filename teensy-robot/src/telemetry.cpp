// ===== DRIVER TELEMETRY =====
// Read and send motor driver telemetry
// =====================================================

#include "telemetry.h"
#include "modbus.h"
#include "config.h"

// Telemetry state variables
uint16_t telemetry_busVoltage = 0;
uint16_t telemetry_motorTemp1 = 0;  // Motor temp from driver 1 (RIGHT side)
uint16_t telemetry_motorTemp2 = 0;  // Motor temp from driver 2 (LEFT side)
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

// Position reading temp storage (need to combine high/low words)
static int16_t posL_high = 0, posL_low = 0;
static int16_t posR_high = 0, posR_low = 0;

float celsiusToFahrenheit(float celsius) {
  return celsius * 9.0f / 5.0f + 32.0f;
}

void readDriverTelemetry() {
  int32_t val;

  // Read one register per cycle to minimize interference with motor commands
  // Now includes position registers (8 total reads in cycle)
  switch (telemReadIndex) {
    case 0:
      // Bus voltage from driver 1 (register 0x20A1) - battery voltage
      val = readModbusRegister(1, 0x20A1);
      if (val >= 0) telemetry_busVoltage = (uint16_t)val;
      break;
    case 1:
      // Motor temperature from driver 1 (RIGHT side) (register 0x20A4)
      val = readModbusRegister(1, 0x20A4);
      if (val >= 0) telemetry_motorTemp1 = (uint16_t)val;
      // Also read motor temp from driver 2 (LEFT side)
      val = readModbusRegister(2, 0x20A4);
      if (val >= 0) telemetry_motorTemp2 = (uint16_t)val;
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
      // Actual velocity from Driver 2 (LEFT side)
      val = readModbusRegister(2, 0x20AB);
      if (val >= 0) {
        telemetry_velocityL = (int16_t)val;
      }
      break;
    case 5:
      // Actual velocity from Driver 1 (RIGHT side)
      val = readModbusRegister(1, 0x20AB);
      if (val >= 0) {
        telemetry_velocityR = (int16_t)val;
        if (INVERT_DRIVER_1) {
          telemetry_velocityR = -telemetry_velocityR;
        }
      }
      break;
    case 6:
      // Position LEFT high word (Driver 2) - register 0x20A7
      val = readModbusRegister(2, REG_POS_L_HIGH);
      if (val >= 0) posL_high = (int16_t)val;
      // Position LEFT low word - register 0x20A8
      val = readModbusRegister(2, REG_POS_L_LOW);
      if (val >= 0) {
        posL_low = (int16_t)val;
        // Combine into 32-bit position
        telemetry_positionL = ((int32_t)posL_high << 16) | (uint16_t)posL_low;
      }
      break;
    case 7:
      // Position RIGHT high word (Driver 1) - register 0x20A7
      val = readModbusRegister(1, REG_POS_L_HIGH);  // Each driver reads its own "left" motor
      if (val >= 0) posR_high = (int16_t)val;
      // Position RIGHT low word - register 0x20A8
      val = readModbusRegister(1, REG_POS_L_LOW);
      if (val >= 0) {
        posR_low = (int16_t)val;
        // Combine into 32-bit position
        telemetry_positionR = ((int32_t)posR_high << 16) | (uint16_t)posR_low;
        // Invert if driver is inverted
        if (INVERT_DRIVER_1) {
          telemetry_positionR = -telemetry_positionR;
        }
      }
      break;
  }

  telemReadIndex = (telemReadIndex + 1) % 8;
}

// LiFePO4 voltage to percentage lookup table (8S pack)
// Corrected based on actual LiFePO4 discharge curve
// Full: 3.65V/cell (29.2V), Empty: 2.5V/cell (20V)
// Nominal/flat region: 3.2-3.3V/cell (25.6-26.4V) = ~20-80%
int lifepo4Percent(float voltage) {
  // 8S LiFePO4 voltage points
  if (voltage >= 28.8) return 100;  // 3.60V/cell - Fully charged
  if (voltage >= 28.0) return 98;   // 3.50V/cell - Just off charger
  if (voltage >= 27.2) return 95;   // 3.40V/cell - Very full
  if (voltage >= 26.8) return 92;   // 3.35V/cell
  if (voltage >= 26.4) return 88;   // 3.30V/cell - Top of flat region
  if (voltage >= 26.0) return 80;   // 3.25V/cell - Upper flat region
  if (voltage >= 25.6) return 65;   // 3.20V/cell - Middle flat region
  if (voltage >= 25.2) return 45;   // 3.15V/cell - Lower flat region
  if (voltage >= 24.8) return 25;   // 3.10V/cell - Getting low
  if (voltage >= 24.0) return 15;   // 3.00V/cell - Low
  if (voltage >= 22.4) return 5;    // 2.80V/cell - Critical
  return 0;  // Below 22.4V - Empty/damaged
}

void sendTelemetryToESP32() {
  // Convert values and send as CSV format
  float batteryV = telemetry_busVoltage * 0.01f;
  // Use LiFePO4 lookup table instead of linear calculation
  int batteryPercent = lifepo4Percent(batteryV);

  // Motor temps from each driver (1C per unit)
  // Register 0x20A4: high byte = motor A (front), low byte = motor B (rear)
  // Driver 1 = RIGHT side, Driver 2 = LEFT side
  int motorTempRF_C = (telemetry_motorTemp1 >> 8) & 0xFF;   // Right Front (Driver 1, motor A)
  int motorTempRR_C = telemetry_motorTemp1 & 0xFF;          // Right Rear (Driver 1, motor B)
  int motorTempLF_C = (telemetry_motorTemp2 >> 8) & 0xFF;   // Left Front (Driver 2, motor A)
  int motorTempLR_C = telemetry_motorTemp2 & 0xFF;          // Left Rear (Driver 2, motor B)

  int motorTempLF_F = (int)celsiusToFahrenheit(motorTempLF_C);
  int motorTempLR_F = (int)celsiusToFahrenheit(motorTempLR_C);
  int motorTempRF_F = (int)celsiusToFahrenheit(motorTempRF_C);
  int motorTempRR_F = (int)celsiusToFahrenheit(motorTempRR_C);

  // For backward compatibility, also compute L/R averages
  int motorTempL_F = (motorTempLF_F + motorTempLR_F) / 2;
  int motorTempR_F = (motorTempRF_F + motorTempRR_F) / 2;

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
  // Format: TELEM,battV,battPct,tempLF,tempLR,tempRF,tempRR,drvTemp1,drvTemp2,velL,velR,torqueL,torqueR,posL,posR
  Serial1.printf("TELEM,%.2f,%d,%d,%d,%d,%d,%d,%d,%.1f,%.1f,%.1f,%.1f,%ld,%ld\n",
    batteryV, batteryPercent,
    motorTempLF_F, motorTempLR_F, motorTempRF_F, motorTempRR_F,
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
  Serial.printf("Motor Temp LF:%d LR:%d RF:%d RR:%d °F\n", motorTempLF_F, motorTempLR_F, motorTempRF_F, motorTempRR_F);
  Serial.printf("Driver Temp 1: %d°F  2: %d°F\n", driverTemp1_F, driverTemp2_F);
  Serial.printf("Velocity L: %.1f RPM  R: %.1f RPM\n", velL, velR);
  Serial.printf("Torque L: %.1fA  R: %.1fA\n", torqueL, torqueR);
  Serial.printf("Position L: %ld  R: %ld\n", telemetry_positionL, telemetry_positionR);
  Serial.println("============================\n");
}
