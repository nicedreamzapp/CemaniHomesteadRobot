// ===== CEMANI HOMESTEAD ROBOT - STANDALONE BUILD =====
// This file contains ALL code needed for wireless OTA updates
// FlasherX library is embedded - no external dependencies
// Upload via Command Center (robot.marijuanaunion.com)
//
// V3.5 - Safety: Auto-stop discrete moves if no comms for 5 seconds
// =====================================================

#include <Arduino.h>

// ===========================================================
// FLASHERX EMBEDDED CODE - START
// ===========================================================
// FlashTxx.h - Flash write/erase functions for Teensy 4.1
// WARNING: you can destroy your MCU with flash erase or write!
// Original by Niels A. Moseley, 2015.
// Modifications for OTA by Jon Zeeff, Deb Hollenback
// Paul Stoffregen's T4.x flash routines from Teensy4 core
// This code is released into the public domain.

#define FLASH_ID        "fw_teensy41"
#define FLASH_SIZE      (0x800000)        // 8MB
#define FLASH_SECTOR_SIZE   (0x1000)      // 4KB sector size
#define FLASH_WRITE_SIZE    (4)           // 4-byte/32-bit writes
#define FLASH_RESERVE       (4*FLASH_SECTOR_SIZE)
#define FLASH_BASE_ADDR (0x60000000)

#define RAM_BUFFER_SIZE (0 * 1024)
#define IN_FLASH(a) ((a) >= FLASH_BASE_ADDR && (a) < FLASH_BASE_ADDR+FLASH_SIZE)

#define CPU_RESTART_ADDR    ((uint32_t *)0xE000ED0C)
#define CPU_RESTART_VAL     (0x5FA0004)
#define REBOOT          (*CPU_RESTART_ADDR = CPU_RESTART_VAL)

#define NO_BUFFER_TYPE      (0)
#define FLASH_BUFFER_TYPE   (1)
#define RAM_BUFFER_TYPE     (2)

#define RAMFUNC __attribute__ ((section(".fastrun"), noinline, noclone, optimize("Os") ))

// hex_info_t struct for hex record and hex file info (forward declaration)
typedef struct {
  char *data;
  unsigned int addr;
  unsigned int code;
  unsigned int num;
  uint32_t base;
  uint32_t min;
  uint32_t max;
  int eof;
  int lines;
} hex_info_t;

// Flash function declarations
RAMFUNC int flash_sector_not_erased(uint32_t address);
RAMFUNC void flash_move(uint32_t dst, uint32_t src, uint32_t size);
int flash_write_block(uint32_t addr, char *data, uint32_t count);
int flash_erase_block(uint32_t address, uint32_t size);
int check_flash_id(uint32_t buffer, uint32_t size);
int firmware_buffer_init(uint32_t *buffer_addr, uint32_t *buffer_size);
void firmware_buffer_free(uint32_t buffer_addr, uint32_t buffer_size);

// Hex parsing functions
void read_ascii_line(Stream *serial, char *line, int maxbytes);
int process_hex_record(hex_info_t *hex);
int parse_hex_line(const char *theline, char *bytes, unsigned int *addr, unsigned int *num, unsigned int *code);
void update_firmware(Stream *in, Stream *out, uint32_t buffer_addr, uint32_t buffer_size);

// External flash functions from Teensy4 core (eeprom.c)
extern "C" {
  void eepromemu_flash_write(void *addr, const void *data, uint32_t len);
  void eepromemu_flash_erase_sector(void *addr);
  void eepromemu_flash_erase_32K_block(void *addr);
  void eepromemu_flash_erase_64K_block(void *addr);
}

static int leave_interrupts_disabled = 0;

// firmware_buffer_init - compute addr/size for firmware buffer
int firmware_buffer_init(uint32_t *buffer_addr, uint32_t *buffer_size) {
  *buffer_addr = FLASH_BASE_ADDR + FLASH_SIZE - FLASH_RESERVE - 4;
  while (*buffer_addr > 0 && *((uint32_t *)*buffer_addr) == 0xFFFFFFFF)
    *buffer_addr -= 4;
  *buffer_addr += 4;

  if ((*buffer_addr % FLASH_SECTOR_SIZE) > 0)
    *buffer_addr += FLASH_SECTOR_SIZE - (*buffer_addr % FLASH_SECTOR_SIZE);
  *buffer_size = FLASH_BASE_ADDR - *buffer_addr + FLASH_SIZE - FLASH_RESERVE;

  return(FLASH_BUFFER_TYPE);
}

void firmware_buffer_free(uint32_t buffer_addr, uint32_t buffer_size) {
  if (IN_FLASH(buffer_addr))
    flash_erase_block(buffer_addr, buffer_size);
  else
    free((void*)buffer_addr);
}

int check_flash_id(uint32_t buffer, uint32_t size) {
  for (uint32_t i = buffer; i < buffer + size - strlen(FLASH_ID); ++i) {
    if (strncmp((char *)i, FLASH_ID, strlen(FLASH_ID)) == 0)
      return 1;
  }
  return 0;
}

RAMFUNC int flash_sector_not_erased(uint32_t address) {
  uint32_t *sector = (uint32_t*)(address & ~(FLASH_SECTOR_SIZE - 1));
  for (int i = 0; i < FLASH_SECTOR_SIZE/4; i++) {
    if (*sector++ != 0xFFFFFFFF)
      return 1;
  }
  return 0;
}

RAMFUNC void flash_move(uint32_t dst, uint32_t src, uint32_t size) {
  uint32_t offset = 0, error = 0, addr;
  leave_interrupts_disabled = 1;

  while (offset < size && error == 0) {
    addr = dst + offset;
    if ((addr & (FLASH_SECTOR_SIZE - 1)) == 0) {
      if (flash_sector_not_erased(addr)) {
        eepromemu_flash_erase_sector((void *)addr);
      }
    }
    uint32_t value = *(uint32_t *)(src + offset);
    eepromemu_flash_write((void*)addr, &value, 4);
    offset += FLASH_WRITE_SIZE;
  }

  if (IN_FLASH(src)) {
    while (offset < (FLASH_SIZE - FLASH_RESERVE) && error == 0) {
      addr = dst + offset;
      if ((addr & (FLASH_SECTOR_SIZE - 1)) == 0) {
        if (flash_sector_not_erased(addr)) {
          eepromemu_flash_erase_sector((void*)addr);
        }
      }
      offset += FLASH_WRITE_SIZE;
    }
  }
  REBOOT;
  for (;;) {}
}

int flash_erase_block(uint32_t start, uint32_t size) {
  int error = 0;
  uint32_t address = start;
  while (address < (start + size) && error == 0) {
    if ((address & (FLASH_SECTOR_SIZE - 1)) == 0) {
      if (flash_sector_not_erased(address)) {
        eepromemu_flash_erase_sector((void*)address);
      }
    }
    address += FLASH_SECTOR_SIZE;
  }
  return(error);
}

int flash_write_block(uint32_t addr, char *data, uint32_t count) {
  static uint32_t buf __attribute__ ((aligned (4)));
  static uint32_t buf_count = 0;
  static uint32_t next_addr = 0;

  int ret = 0;
  uint32_t data_i = 0;

  if ((addr % 4) != 0 || (count % 4) != 0) {
    return 1;
  }

  if (buf_count > 0 && addr != next_addr) {
    return 2;
  }
  next_addr = addr + count;
  addr -= buf_count;

  while (data_i < count) {
    ((char*)&buf)[buf_count++] = data[data_i++];
    if (buf_count < FLASH_WRITE_SIZE) {
      continue;
    }
    eepromemu_flash_write((void*)addr, (void*)&buf, 4);
    if (ret != 0) {
      return 3;
    }
    buf_count = 0;
    addr += FLASH_WRITE_SIZE;
  }
  return 0;
}

void read_ascii_line(Stream *serial, char *line, int maxbytes) {
  int c = 0, nchar = 0;
  unsigned long timeout = millis() + 30000;  // 30 second timeout per line

  // Wait for first non-newline character (with timeout)
  while (millis() < timeout) {
    if (serial->available()) {
      c = serial->read();
      if (c == '\n' || c == '\r')
        continue;  // Skip leading newlines
      else {
        line[nchar++] = c;
        break;
      }
    }
  }

  // Read rest of line until newline (with timeout)
  while (nchar < maxbytes && !(c == '\n' || c == '\r') && millis() < timeout) {
    if (serial->available()) {
      c = serial->read();
      line[nchar++] = c;
    }
  }

  // Null terminate (handle edge cases)
  if (nchar > 0)
    line[nchar-1] = 0;
  else
    line[0] = 0;
}

int process_hex_record(hex_info_t *hex) {
  if (hex->code == 0) {
    if (hex->base + hex->addr + hex->num > hex->max)
      hex->max = hex->base + hex->addr + hex->num;
    if (hex->base + hex->addr < hex->min)
      hex->min = hex->base + hex->addr;
  }
  else if (hex->code == 1) {
    hex->eof = 1;
  }
  else if (hex->code == 2) {
    hex->base = ((hex->data[0] << 8) | hex->data[1]) << 4;
  }
  else if (hex->code == 3) {
    return 1;
  }
  else if (hex->code == 4) {
    hex->base = ((hex->data[0] << 8) | hex->data[1]) << 16;
  }
  else if (hex->code == 5) {
    hex->base = (hex->data[0] << 24) | (hex->data[1] << 16)
              | (hex->data[2] <<  8) | (hex->data[3] <<  0);
  }
  else {
    return 1;
  }
  return 0;
}

int parse_hex_line(const char *theline, char *bytes,
        unsigned int *addr, unsigned int *num, unsigned int *code) {
  unsigned sum, len, cksum;
  const char *ptr;
  int temp;

  *num = 0;
  if (theline[0] != ':')
    return 0;
  if (strlen(theline) < 11)
    return 0;
  ptr = theline + 1;
  if (!sscanf(ptr, "%02x", &len))
    return 0;
  ptr += 2;
  if (strlen(theline) < (11 + (len * 2)))
    return 0;
  if (!sscanf(ptr, "%04x", (unsigned int *)addr))
    return 0;
  ptr += 4;
  if (!sscanf(ptr, "%02x", code))
    return 0;
  ptr += 2;
  sum = (len & 255) + ((*addr >> 8) & 255) + (*addr & 255) + (*code & 255);
  while (*num != len) {
    if (!sscanf(ptr, "%02x", &temp))
      return 0;
    bytes[*num] = temp;
    ptr += 2;
    sum += bytes[*num] & 255;
    (*num)++;
    if (*num >= 256)
      return 0;
  }
  if (!sscanf(ptr, "%02x", &cksum))
    return 0;

  if (((sum & 255) + (cksum & 255)) & 255)
    return 0;
  return 1;
}

// MODIFIED update_firmware - AUTO-CONFIRMS instead of asking user
// This is essential for wireless OTA where we can't have user input
void update_firmware(Stream *in, Stream *out,
                uint32_t buffer_addr, uint32_t buffer_size) {
  static char line[96];
  static char data[32] __attribute__ ((aligned (8)));
  hex_info_t hex = {
    data, 0, 0, 0,
    0, 0xFFFFFFFF, 0,
    0, 0
  };

  out->printf("reading hex lines...\n");

  while (!hex.eof) {
    read_ascii_line(in, line, sizeof(line));

    if (parse_hex_line((const char*)line, hex.data, &hex.addr, &hex.num, &hex.code) == 0) {
      out->printf("abort - bad hex line %s\n", line);
      return;
    }
    else if (process_hex_record(&hex) != 0) {
      out->printf("abort - invalid hex code %d\n", hex.code);
      return;
    }
    else if (hex.code == 0) {
      uint32_t addr = buffer_addr + hex.base + hex.addr - FLASH_BASE_ADDR;
      if (hex.max > (FLASH_BASE_ADDR + buffer_size)) {
        out->printf("abort - max address %08lX too large\n", hex.max);
        return;
      }
      else if (!IN_FLASH(buffer_addr)) {
        memcpy((void*)addr, (void*)hex.data, hex.num);
      }
      else if (IN_FLASH(buffer_addr)) {
        int error = flash_write_block(addr, hex.data, hex.num);
        if (error) {
          out->printf("abort - error %02X in flash_write_block()\n", error);
          return;
        }
      }
    }
    hex.lines++;
  }

  out->printf("\nhex file: %1d lines %1lu bytes (%08lX - %08lX)\n",
            hex.lines, hex.max-hex.min, hex.min, hex.max);

  // Check FLASH_ID in new code
  if (check_flash_id(buffer_addr, hex.max - hex.min)) {
    out->printf("new code contains correct target ID %s\n", FLASH_ID);
  }
  else {
    out->printf("abort - new code missing string %s\n", FLASH_ID);
    return;
  }

  // AUTO-CONFIRM: No user input needed for wireless OTA!
  out->printf("AUTO-CONFIRM: flashing %d lines\n", hex.lines);
  out->printf("calling flash_move() to load new firmware...\n");
  out->flush();

  flash_move(FLASH_BASE_ADDR, buffer_addr, hex.max - hex.min);
  REBOOT;
}

// ===========================================================
// FLASHERX EMBEDDED CODE - END
// ===========================================================

// ===== ROBOT CONFIGURATION =====
#define INVERT_DRIVER_1 true
#define INVERT_DRIVER_2 false

// SAFETY: Max speeds - keep LOW to prevent crashes!
#define MAX_SPEED_RPM 75         // REDUCED: Half speed for forward/backward (was 150)
#define MAX_TURN_RPM 5           // Match web UI turn speed - super smooth (KEEP SLOW)

// Software acceleration (RPM change per update cycle)
#define ACCEL_RATE_NORMAL 3      // REDUCED: Slower ramp up (was 10)
#define ACCEL_RATE_TURN 1        // Keep slow turn ramp

// Hardware acceleration (ms to reach target - higher = slower)
#define DRIVER_ACCEL_NORMAL 500  // SLOWER: More gradual (was 300)
#define DRIVER_ACCEL_TURN 1500   // Keep slow for turns

#define TORQUE_NORMAL 1000       // Original value
#define TORQUE_TURN 150          // Keep low for turns

#define JOYSTICK_DEADZONE 0.15f  // LARGER: More deadzone to prevent accidental moves (was 0.1)
#define MOTOR_UPDATE_INTERVAL 50

// Input noise filtering - DISABLED (was too aggressive)
#define INPUT_FILTER_SAMPLES 1   // Accept immediately (was 3)
#define INPUT_CHANGE_THRESHOLD 5 // Much smaller threshold (was 50)

// ===== REGISTER DEFINITIONS =====
#define REG_CONTROL_MODE    0x200D
#define REG_CONTROL_WORD    0x200E
#define REG_SYNC_MODE       0x200F
#define REG_ACCEL_LEFT      0x2080
#define REG_ACCEL_RIGHT     0x2081
#define REG_DECEL_LEFT      0x2082
#define REG_DECEL_RIGHT     0x2083
#define REG_VEL_LEFT        0x2088
#define REG_VEL_RIGHT       0x2089
#define REG_BRAKE_LEFT      0x201A
#define REG_BRAKE_RIGHT     0x201B
#define REG_TORQUE_LEFT     0x20A1
#define REG_TORQUE_RIGHT    0x20A3

// ===== STATE VARIABLES =====
static long currentLX = 0, currentLY = 0;
static long filteredLX = 0, filteredLY = 0;  // Filtered joystick values
static long pendingLX = 0, pendingLY = 0;    // Pending values for noise filter
static int lxFilterCount = 0, lyFilterCount = 0;  // Consistent reading counter
static int16_t lastLeftSpeed = 0, lastRightSpeed = 0;
static int16_t targetLeftSpeed = 0, targetRightSpeed = 0;
static uint32_t lastMotorUpdate = 0;
static uint32_t lastComm = 0;
static bool controllerConnected = false;
static bool emergencyStop = false;
static bool motorsEnabled = false;
static bool isTurning = false;
static bool lastTurnState = false;

// ===== INPUT NOISE FILTER =====
// Simplified - just accept all valid input (previous filter was too aggressive)
bool filterInput(long newVal, long& currentVal, long& pendingVal, int& filterCount) {
  // Simply accept the new value
  currentVal = newVal;
  return true;
}

// ===== DISCRETE MOVEMENT STATE =====
static bool discreteMoveActive = false;
static int discreteTurnDegrees = 0;
static int discreteDistanceCm = 0;
static uint32_t discreteMoveStartTime = 0;
static int discreteMovePhase = 0;  // 0=idle, 1=turning, 2=moving
static bool discreteMoveBackward = false;  // true if moving backward after turn

// Robot's current facing direction (0=N, 90=E, 180=S, 270=W)
static int robotFacingAngle = 0;

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
  delay(5);
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
  delay(5);
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
  if (driverID == 1 && INVERT_DRIVER_1) {
    speed = -speed;
  }
  if (driverID == 2 && INVERT_DRIVER_2) {
    speed = -speed;
  }

  if (speed > MAX_SPEED_RPM) speed = MAX_SPEED_RPM;
  if (speed < -MAX_SPEED_RPM) speed = -MAX_SPEED_RPM;

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
  discreteMoveActive = false;
  discreteMovePhase = 0;
}

// ===== DISCRETE MOVEMENT EXECUTION =====
// Executes direction-based movement commands from web UI
// Robot calculates optimal way to reach target direction:
// - Go forward if target is same as facing
// - Go backward if target is opposite to facing
// - Turn 90° then forward/backward for perpendicular directions

// Timing constants (calibrate these!)
// Timing constants - calibrated for smooth movement
// At 15 RPM with ~30cm wheel, speed is ~7.5cm/sec, so ~133ms per cm
// At 5 RPM turn, ~100ms per degree
#define TURN_MS_PER_DEGREE 100     // ms per degree of rotation
#define MOVE_MS_PER_CM     140     // ms per cm
#define DISCRETE_TURN_RPM  5       // RPM for turning - slow and smooth
#define DISCRETE_MOVE_RPM  15      // RPM for forward/backward - gentle speed

// Handle relative direction commands (F/B/L/R)
// F = Forward, B = Backward, L = Turn Left 90°, R = Turn Right 90°
void startRelativeMove(char direction, int distanceCm) {
  // Auto-recover from emergency stop when new move command received from web UI
  if (emergencyStop || !motorsEnabled) {
    Serial.println("[MOVE] Auto-recovering from emergency stop...");
    sendModbusWrite(1, REG_CONTROL_WORD, 0x08);
    sendModbusWrite(2, REG_CONTROL_WORD, 0x08);
    delay(50);
    motorsEnabled = true;
    emergencyStop = false;
    Serial.println("[MOVE] Motors re-enabled, ready to move");
  }

  // Set slow acceleration for smooth discrete moves (1000ms ramp)
  setAccelTimes(1000, 500);

  discreteMoveStartTime = millis();
  discreteMoveActive = true;

  if (direction == 'F') {
    // Forward
    discreteTurnDegrees = 0;
    discreteDistanceCm = distanceCm;
    discreteMoveBackward = false;
    discreteMovePhase = 2;  // Moving
    setDriverSpeed(1, DISCRETE_MOVE_RPM);
    setDriverSpeed(2, DISCRETE_MOVE_RPM);
    Serial.printf("[MOVE] Forward %d cm\n", distanceCm);
    Serial1.printf("MOVE_STATUS,FORWARD,%d\n", distanceCm);
  }
  else if (direction == 'B') {
    // Backward
    discreteTurnDegrees = 0;
    discreteDistanceCm = distanceCm;
    discreteMoveBackward = true;
    discreteMovePhase = 2;  // Moving
    setDriverSpeed(1, -DISCRETE_MOVE_RPM);
    setDriverSpeed(2, -DISCRETE_MOVE_RPM);
    Serial.printf("[MOVE] Backward %d cm\n", distanceCm);
    Serial1.printf("MOVE_STATUS,BACKWARD,%d\n", distanceCm);
  }
  else if (direction == 'L') {
    // Turn left 90°
    discreteTurnDegrees = -90;
    discreteDistanceCm = 0;
    discreteMoveBackward = false;
    discreteMovePhase = 1;  // Turning
    setDriverSpeed(1, -DISCRETE_TURN_RPM);
    setDriverSpeed(2, DISCRETE_TURN_RPM);
    Serial.println("[MOVE] Turn LEFT 90°");
    Serial1.println("MOVE_STATUS,TURN_LEFT,90");
  }
  else if (direction == 'R') {
    // Turn right 90°
    discreteTurnDegrees = 90;
    discreteDistanceCm = 0;
    discreteMoveBackward = false;
    discreteMovePhase = 1;  // Turning
    setDriverSpeed(1, DISCRETE_TURN_RPM);
    setDriverSpeed(2, -DISCRETE_TURN_RPM);
    Serial.println("[MOVE] Turn RIGHT 90°");
    Serial1.println("MOVE_STATUS,TURN_RIGHT,90");
  }
  else {
    // Unknown direction
    Serial.printf("[MOVE] Unknown direction: %c\n", direction);
    discreteMoveActive = false;
    discreteMovePhase = 0;
  }
}

// Legacy compass direction support (N/E/S/W) - converts to relative
void startDiscreteMoveDirection(char direction, int distanceCm) {
  // For backwards compatibility, map N/E/S/W to F/B/L/R
  // Assumes robot is always "facing north" in the UI's mental model
  char relativeDir = 'F';
  if (direction == 'N') relativeDir = 'F';
  else if (direction == 'S') relativeDir = 'B';
  else if (direction == 'E') relativeDir = 'R';  // Turn right then forward would be complex, just turn
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

  // SAFETY: Auto-stop if no communication for 5 seconds during discrete move
  // This prevents runaway if ESP32 disconnects mid-move
  if (now - lastComm > 5000) {
    Serial.println("[SAFETY] No communication during move - AUTO STOPPING!");
    setDriverSpeed(1, 0);
    setDriverSpeed(2, 0);
    discreteMoveActive = false;
    discreteMovePhase = 0;
    Serial1.println("MOVE_TIMEOUT");
    return;
  }

  if (discreteMovePhase == 1) {
    // Turning phase
    uint32_t turnDuration = abs(discreteTurnDegrees) * TURN_MS_PER_DEGREE;
    if (elapsed >= turnDuration) {
      // Turn complete - update robot facing angle
      robotFacingAngle += discreteTurnDegrees;
      // Normalize to 0-359
      while (robotFacingAngle < 0) robotFacingAngle += 360;
      while (robotFacingAngle >= 360) robotFacingAngle -= 360;

      Serial.printf("[MOVE] Turn complete (%lu ms), now facing %d°\n", elapsed, robotFacingAngle);

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
        // All done
        setDriverSpeed(1, 0);
        setDriverSpeed(2, 0);
        discreteMoveActive = false;
        discreteMovePhase = 0;
        Serial.println("[MOVE] Complete!");
        Serial1.println("MOVE_COMPLETE");
      }
    }
  }
  else if (discreteMovePhase == 2) {
    // Moving phase
    uint32_t moveDuration = abs(discreteDistanceCm) * MOVE_MS_PER_CM;
    if (elapsed >= moveDuration) {
      // Move complete - stop motors
      setDriverSpeed(1, 0);
      setDriverSpeed(2, 0);
      discreteMoveActive = false;
      discreteMovePhase = 0;
      Serial.printf("[MOVE] Move complete (%lu ms)\n", elapsed);
      Serial1.println("MOVE_COMPLETE");
    }
  }
}

// Apply exponential curve to joystick input for finer control at low values
// input: -1.0 to 1.0, returns -1.0 to 1.0 with curve applied
float applyJoystickCurve(float input) {
  // Quadratic curve: output = sign(input) * input^2
  // This means half-stick gives 25% power, not 50%
  float sign = (input >= 0) ? 1.0f : -1.0f;
  return sign * input * input;
}

void calculateTankSpeeds(long lx, long ly, int16_t& leftSpeed, int16_t& rightSpeed) {
  // SAFETY: Hard clamp inputs first
  lx = constrain(lx, -511, 511);
  ly = constrain(ly, -511, 511);

  float x = -lx / 511.0f;
  float y = -ly / 511.0f;

  // Larger deadzone to filter noise
  if (abs(x) < JOYSTICK_DEADZONE) x = 0.0f;
  if (abs(y) < JOYSTICK_DEADZONE) y = 0.0f;

  // Apply exponential curve for finer control at low speeds
  // Half-stick now gives ~25% speed instead of 50%
  x = applyJoystickCurve(x);
  y = applyJoystickCurve(y);

  // Detect turning (mostly side-to-side input)
  float turnRatio = (abs(y) < 0.1f) ? 1.0f : abs(x) / (abs(y) + 0.01f);
  isTurning = (abs(x) > 0.2f && turnRatio > 0.8f);

  float leftPower = y + x;
  float rightPower = y - x;

  // Normalize power to -1 to 1
  float maxPower = max(abs(leftPower), abs(rightPower));
  if (maxPower > 1.0f) {
    leftPower /= maxPower;
    rightPower /= maxPower;
  }

  int16_t maxRpm = isTurning ? MAX_TURN_RPM : MAX_SPEED_RPM;

  leftSpeed = (int16_t)(leftPower * maxRpm);
  rightSpeed = (int16_t)(rightPower * maxRpm);

  // SAFETY: Final hard clamp - NEVER exceed these values
  leftSpeed = constrain(leftSpeed, -MAX_SPEED_RPM, MAX_SPEED_RPM);
  rightSpeed = constrain(rightSpeed, -MAX_SPEED_RPM, MAX_SPEED_RPM);
}

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

// ===== FLASHERX OTA UPDATE HANDLER =====
void startOtaUpdate() {
  uint32_t buffer_addr, buffer_size;

  emergencyStopMotors();
  Serial.println("\n[OTA] === FLASH MODE ACTIVATED ===");
  Serial.println("[OTA] Initializing flash buffer...");

  if (firmware_buffer_init(&buffer_addr, &buffer_size) == 0) {
    Serial.println("[OTA] ERROR: Unable to create flash buffer!");
    Serial1.println("FLASH_ERROR_BUFFER");
    return;
  }

  Serial.printf("[OTA] Buffer: %luK at 0x%08lX\n", buffer_size/1024, buffer_addr);
  Serial.println("[OTA] Ready - send Intel HEX data now...");
  Serial1.println("FLASH_READY");

  update_firmware(&Serial1, &Serial, buffer_addr, buffer_size);

  Serial.println("[OTA] Update failed or aborted, cleaning up...");
  firmware_buffer_free(buffer_addr, buffer_size);
  Serial1.println("FLASH_FAILED");

  Serial.println("[OTA] Rebooting...");
  delay(100);
  REBOOT;
}

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
  Serial3.begin(115200);

  delay(2000);

  Serial.println("\n========================================");
  Serial.println("  CEMANI HOMESTEAD ROBOT - TANK DRIVE");
  Serial.println("  V3.5 - Safety auto-stop on disconnect");
  Serial.println("========================================");
  Serial.println("Hardware: Teensy 4.1 + 2x ZLAC8015D");
  Serial.println("Motors: 4 hub motors (2 per driver)");
  Serial.println("----------------------------------------");
  Serial.println("Turn detection: slow accel (no torque)");
  Serial.printf("  Normal: %d RPM, %dms accel\n", MAX_SPEED_RPM, DRIVER_ACCEL_NORMAL);
  Serial.printf("  Turn:   %d RPM, %dms accel\n", MAX_TURN_RPM, DRIVER_ACCEL_TURN);
  Serial.println("----------------------------------------");
  Serial.println("Controls:");
  Serial.println("  Left Stick  = Tank drive (Y=fwd, X=turn)");
  Serial.println("  START       = Emergency Stop");
  Serial.println("  BACK        = Resume/Clear E-Stop");
  Serial.println("  A Button    = Reset drivers");
  Serial.println("----------------------------------------");
  Serial.println("OTA: Embedded FlasherX - wireless updates");
  Serial.println("========================================\n");

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

      if (strcmp(buf, "FLASH_MODE") == 0) {
        startOtaUpdate();
        continue;
      }

      if (strncmp(buf, "STATE,CONNECTED", 15) == 0) {
        controllerConnected = true;
        // Auto-enable motors when Xbox controller connects
        if (!motorsEnabled) {
          Serial.println("[CTRL] Xbox connected - enabling motors");
          fullReset();
        } else {
          Serial.println("[CTRL] Xbox connected");
        }
      }
      else if (strncmp(buf, "STATE,DISCONNECTED", 18) == 0) {
        // Xbox disconnected - zero joystick but DON'T stop motors
        // This allows web commands to keep working
        controllerConnected = false;
        currentLX = 0;
        currentLY = 0;
        Serial.println("[CTRL] Xbox disconnected - joystick zeroed");
      }
      else if (strncmp(buf, "AX,", 3) == 0) {
        char name[3];
        long val;
        unsigned long ms;
        if (sscanf(buf, "AX,%2[^,],%ld,%lu", name, &val, &ms) == 3) {
          // Validate input range
          if (val < -600 || val > 600) continue;

          // Auto-recover from E-STOP when joystick moves significantly
          // This lets you "wake up" the robot by moving the stick
          bool significantInput = (abs(val) > 100);
          if (significantInput && (emergencyStop || !motorsEnabled)) {
            Serial.println("[CTRL] Joystick input - auto-recovering from E-STOP");
            emergencyStop = false;
            fullReset();
          }
          controllerConnected = true;

          // Direct assignment - no filtering
          if (strcmp(name, "LX") == 0) {
            currentLX = val;
          }
          else if (strcmp(name, "LY") == 0) {
            currentLY = val;
          }
        }
      }
      else if (strncmp(buf, "BTN,", 4) == 0) {
        long id, state;
        unsigned long ms;
        if (sscanf(buf, "BTN,%ld,%ld,%lu", &id, &state, &ms) == 3) {
          if (state == 1) {
            // ONLY A button (id 0) triggers E-STOP - same as web STOP button
            if (id == 0) {
              Serial.println("[BTN] A pressed - EMERGENCY STOP!");
              emergencyStopMotors();
            }
          }
        }
      }
      // ===== DISCRETE MOVEMENT COMMANDS FROM WEB UI =====
      // Format: MOVEDIR,direction,distanceCm (e.g., MOVEDIR,F,50 or MOVEDIR,L,0)
      // Directions: F=Forward, B=Backward, L=TurnLeft, R=TurnRight
      else if (strncmp(buf, "MOVEDIR,", 8) == 0) {
        char dir;
        int distCm;
        if (sscanf(buf, "MOVEDIR,%c,%d", &dir, &distCm) == 2) {
          Serial.printf("[CMD] MOVEDIR dir=%c dist=%dcm\n", dir, distCm);
          // Cancel joystick control, start discrete move
          currentLX = 0;
          currentLY = 0;
          // Use relative move for F/B/L/R, legacy for N/E/S/W
          if (dir == 'F' || dir == 'B' || dir == 'L' || dir == 'R') {
            startRelativeMove(dir, distCm);
          } else {
            startDiscreteMoveDirection(dir, distCm);
          }
        }
      }
      // Legacy format: MOVE,turnDeg,distCm (for backward compatibility)
      else if (strncmp(buf, "MOVE,", 5) == 0) {
        int turnDeg, distCm;
        if (sscanf(buf, "MOVE,%d,%d", &turnDeg, &distCm) == 2) {
          Serial.printf("[CMD] MOVE turn=%d° dist=%dcm\n", turnDeg, distCm);
          // Cancel joystick control, start discrete move
          currentLX = 0;
          currentLY = 0;
          startDiscreteMove(turnDeg, distCm);
        }
      }
      else if (strcmp(buf, "STOP") == 0) {
        Serial.println("[CMD] STOP received");
        emergencyStopMotors();
        Serial1.println("STOPPED");
      }
      else if (strcmp(buf, "RESUME") == 0) {
        Serial.println("[CMD] RESUME received - clearing emergency stop");
        emergencyStop = false;
        Serial1.println("RESUMED");
      }
    } else {
      buf[n++] = c;
    }
  }

  // ===== DISCRETE MOVEMENT UPDATE =====
  // Process timed discrete moves from web UI (takes priority over joystick)
  if (discreteMoveActive && !emergencyStop && motorsEnabled) {
    updateDiscreteMove();
  }
  // ===== JOYSTICK MOTOR CONTROL UPDATE =====
  // Only run joystick control when no discrete move is active
  else if (controllerConnected && !emergencyStop && motorsEnabled && !discreteMoveActive) {
    if (now - lastMotorUpdate >= MOTOR_UPDATE_INTERVAL) {
      lastMotorUpdate = now;

      calculateTankSpeeds(currentLX, currentLY, targetLeftSpeed, targetRightSpeed);

      if (isTurning != lastTurnState) {
        if (isTurning) {
          Serial.println("[TURN MODE] Slow speed + slow accel");
          setAccelTimes(DRIVER_ACCEL_TURN, DRIVER_ACCEL_TURN);
        } else {
          Serial.println("[NORMAL MODE] Full speed + fast accel");
          setAccelTimes(DRIVER_ACCEL_NORMAL, DRIVER_ACCEL_NORMAL / 2);
        }
        lastTurnState = isTurning;
      }

      int16_t newLeft = rampSpeed(lastLeftSpeed, targetLeftSpeed);
      int16_t newRight = rampSpeed(lastRightSpeed, targetRightSpeed);

      if (abs(newLeft - lastLeftSpeed) > 2 || abs(newRight - lastRightSpeed) > 2) {
        setDriverSpeed(1, newLeft);
        setDriverSpeed(2, newRight);

        lastLeftSpeed = newLeft;
        lastRightSpeed = newRight;

        if (abs(newLeft) > 5 || abs(newRight) > 5) {
          Serial.printf("L:%+4d  R:%+4d RPM  %s\n", newLeft, newRight, isTurning ? "[TURN]" : "");
        }
      }
    }
  }

  // ===== SAFETY: Controller timeout =====
  // Timeout just zeros joystick - doesn't stop motors
  // This allows web commands to keep working even if Xbox times out
  if (now - lastComm > 10000 && controllerConnected) {
    controllerConnected = false;
    currentLX = 0;
    currentLY = 0;
    Serial.println("[TIMEOUT] No Xbox data - joystick zeroed (motors still enabled)");
  }

  // ===== ECHO DRIVER RESPONSES =====
  while (Serial3.available()) {
    uint8_t b = Serial3.read();
  }
}
