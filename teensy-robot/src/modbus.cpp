// ===== MODBUS COMMUNICATION =====
// CRC, register read/write functions for ZLAC8015D drivers
// =====================================================

#include "modbus.h"
#include "config.h"

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

// ===== MODBUS READ REGISTERS =====
int32_t readModbusRegister(uint8_t id, uint16_t reg) {
  // Build read request: ID, FC03, RegHi, RegLo, NumRegsHi, NumRegsLo, CRC
  uint8_t frame[8];
  frame[0] = id;
  frame[1] = 0x03;  // Function code: Read Holding Registers
  frame[2] = reg >> 8;
  frame[3] = reg & 0xFF;
  frame[4] = 0x00;  // Number of registers (high)
  frame[5] = 0x01;  // Number of registers (low) = 1
  uint16_t crc = modbusCRC(frame, 6);
  frame[6] = crc & 0xFF;
  frame[7] = crc >> 8;

  // Clear any pending data
  while (Serial3.available()) Serial3.read();

  // Send request
  Serial3.write(frame, 8);
  Serial3.flush();

  // Wait for response (timeout 50ms)
  uint32_t start = millis();
  while (Serial3.available() < 7 && millis() - start < 50) {
    delayMicroseconds(100);
  }

  if (Serial3.available() < 7) {
    return -1;  // Timeout
  }

  // Read response: ID, FC, ByteCount, DataHi, DataLo, CRC
  uint8_t resp[16];
  int len = 0;
  while (Serial3.available() && len < 16) {
    resp[len++] = Serial3.read();
  }

  // Validate response
  if (len < 7 || resp[0] != id || resp[1] != 0x03 || resp[2] != 2) {
    return -1;  // Invalid response
  }

  // Check CRC
  uint16_t respCrc = modbusCRC(resp, len - 2);
  uint16_t recvCrc = resp[len-2] | (resp[len-1] << 8);
  if (respCrc != recvCrc) {
    return -1;  // CRC error
  }

  // Return data value
  return (resp[3] << 8) | resp[4];
}

// ===== MODBUS WRITE SINGLE REGISTER =====
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
  delay(8);  // Balanced: was 15ms (too slow) then 3ms (too fast for drivers)
  // Drain any response bytes
  while (Serial3.available()) Serial3.read();
  return true;
}

// ===== MODBUS SYNC VELOCITY WRITE =====
bool sendModbusSyncVelocity(uint8_t id, int16_t leftVel, int16_t rightVel) {
  uint8_t frame[13];
  frame[0] = id;
  frame[1] = 0x10;
  frame[2] = 0x20;
  frame[3] = 0x88;
  frame[4] = 0x00;
  frame[5] = 0x02;
  frame[6] = 0x04;
  frame[7] = (uint16_t)leftVel >> 8;
  frame[8] = (uint16_t)leftVel & 0xFF;
  frame[9] = (uint16_t)rightVel >> 8;
  frame[10] = (uint16_t)rightVel & 0xFF;

  uint16_t crc = modbusCRC(frame, 11);
  frame[11] = crc & 0xFF;
  frame[12] = crc >> 8;

  Serial3.write(frame, 13);
  Serial3.flush();
  delay(8);  // Balanced: was 15ms (too slow) then 3ms (too fast for drivers)
  // Drain any response bytes
  while (Serial3.available()) Serial3.read();
  return true;
}

void setAccelTimes(uint16_t accelMs, uint16_t decelMs) {
  sendModbusWrite(1, REG_ACCEL_LEFT, accelMs);
  sendModbusWrite(1, REG_ACCEL_RIGHT, accelMs);
  sendModbusWrite(1, REG_DECEL_LEFT, decelMs);
  sendModbusWrite(1, REG_DECEL_RIGHT, decelMs);
  sendModbusWrite(2, REG_ACCEL_LEFT, accelMs);
  sendModbusWrite(2, REG_ACCEL_RIGHT, accelMs);
  sendModbusWrite(2, REG_DECEL_LEFT, decelMs);
  sendModbusWrite(2, REG_DECEL_RIGHT, decelMs);
}

void setTorqueLimits(uint16_t torqueLimit) {
  sendModbusWrite(1, REG_TORQUE_LEFT, torqueLimit);
  sendModbusWrite(1, REG_TORQUE_RIGHT, torqueLimit);
  sendModbusWrite(2, REG_TORQUE_LEFT, torqueLimit);
  sendModbusWrite(2, REG_TORQUE_RIGHT, torqueLimit);
  Serial.printf("[TORQUE] Set to %d%%\n", torqueLimit / 10);
}

void fullReset() {
  Serial.println("=== FULL DRIVER RESET ===");

  Serial.println("1. Stopping motors...");
  sendModbusSyncVelocity(1, 0, 0);
  sendModbusSyncVelocity(2, 0, 0);
  delay(100);

  Serial.println("2. Clearing faults...");
  sendModbusWrite(1, REG_CONTROL_WORD, 0x06);
  sendModbusWrite(2, REG_CONTROL_WORD, 0x06);
  delay(100);

  Serial.println("3. Setting synchronous mode...");
  sendModbusWrite(1, REG_SYNC_MODE, 0x00);
  sendModbusWrite(2, REG_SYNC_MODE, 0x00);
  delay(50);

  Serial.println("4. Setting velocity mode...");
  sendModbusWrite(1, REG_CONTROL_MODE, 3);
  sendModbusWrite(2, REG_CONTROL_MODE, 3);
  delay(50);

  Serial.println("5. Setting accel/decel times...");
  sendModbusWrite(1, REG_ACCEL_LEFT, 300);
  sendModbusWrite(1, REG_ACCEL_RIGHT, 300);
  sendModbusWrite(1, REG_DECEL_LEFT, 200);
  sendModbusWrite(1, REG_DECEL_RIGHT, 200);
  sendModbusWrite(2, REG_ACCEL_LEFT, 300);
  sendModbusWrite(2, REG_ACCEL_RIGHT, 300);
  sendModbusWrite(2, REG_DECEL_LEFT, 200);
  sendModbusWrite(2, REG_DECEL_RIGHT, 200);
  delay(50);

  Serial.println("6. Releasing brakes...");
  sendModbusWrite(1, REG_BRAKE_LEFT, 0);
  sendModbusWrite(1, REG_BRAKE_RIGHT, 0);
  sendModbusWrite(2, REG_BRAKE_LEFT, 0);
  sendModbusWrite(2, REG_BRAKE_RIGHT, 0);
  delay(100);

  Serial.println("7. Enabling drivers...");
  sendModbusWrite(1, REG_CONTROL_WORD, 0x08);
  sendModbusWrite(2, REG_CONTROL_WORD, 0x08);
  delay(100);

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

void setDriverSpeed(uint8_t driverID, int16_t speed) {
  int16_t originalSpeed = speed;

  if (driverID == 1 && INVERT_DRIVER_1) {
    speed = -speed;
  }
  if (driverID == 2 && INVERT_DRIVER_2) {
    speed = -speed;
  }

  // Use TURBO_SPEED_RPM as absolute max - turbo speeds are already clamped in main.cpp
  if (speed > TURBO_SPEED_RPM) speed = TURBO_SPEED_RPM;
  if (speed < -TURBO_SPEED_RPM) speed = -TURBO_SPEED_RPM;

  Serial.printf("[DRIVER%d] Setting speed: %d RPM (orig: %d)\n", driverID, speed, originalSpeed);
  sendModbusSyncVelocity(driverID, speed, speed);
}

void emergencyStopMotors() {
  Serial.println("[E-STOP] Stopping all motors!");
  sendModbusWrite(1, REG_CONTROL_WORD, 0x05);
  sendModbusWrite(2, REG_CONTROL_WORD, 0x05);
  sendModbusSyncVelocity(1, 0, 0);
  sendModbusSyncVelocity(2, 0, 0);
  emergencyStop = true;
  motorsEnabled = false;
  lastLeftSpeed = 0;
  lastRightSpeed = 0;
}
