// ===== CEMANI HOMESTEAD ROBOT - STANDALONE BUILD =====
// This file contains ALL code needed for wireless OTA updates
// FlasherX library is embedded - no external dependencies
// Upload via Command Center (robot.marijuanaunion.com)
//
// V2.4 - No Torque Limit + Wireless OTA
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
  while (serial->available()) {
    c = serial->read();
    if (c == '\n' || c == '\r')
      continue;
    else {
      line[nchar++] = c;
      break;
    }
  }
  while (nchar < maxbytes && !(c == '\n' || c == '\r')) {
    if (serial->available()) {
      c = serial->read();
      line[nchar++] = c;
    }
  }
  line[nchar-1] = 0;
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

#define MAX_SPEED_RPM 150
#define MAX_TURN_RPM 35

#define ACCEL_RATE_NORMAL 10
#define ACCEL_RATE_TURN 4

#define DRIVER_ACCEL_NORMAL 300
#define DRIVER_ACCEL_TURN 800

#define TORQUE_NORMAL 1000
#define TORQUE_TURN 200

#define JOYSTICK_DEADZONE 0.1f
#define MOTOR_UPDATE_INTERVAL 50

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
static int16_t lastLeftSpeed = 0, lastRightSpeed = 0;
static int16_t targetLeftSpeed = 0, targetRightSpeed = 0;
static uint32_t lastMotorUpdate = 0;
static uint32_t lastComm = 0;
static bool controllerConnected = false;
static bool emergencyStop = false;
static bool motorsEnabled = false;
static bool isTurning = false;
static bool lastTurnState = false;

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
}

void calculateTankSpeeds(long lx, long ly, int16_t& leftSpeed, int16_t& rightSpeed) {
  float x = -constrain(lx, -511, 511) / 511.0f;
  float y = -constrain(ly, -511, 511) / 511.0f;

  if (abs(x) < JOYSTICK_DEADZONE) x = 0.0f;
  if (abs(y) < JOYSTICK_DEADZONE) y = 0.0f;

  float turnRatio = (abs(y) < 0.1f) ? 1.0f : abs(x) / (abs(y) + 0.01f);
  isTurning = (abs(x) > 0.2f && turnRatio > 0.8f);

  float leftPower = y + x;
  float rightPower = y - x;

  float maxPower = max(abs(leftPower), abs(rightPower));
  if (maxPower > 1.0f) {
    leftPower /= maxPower;
    rightPower /= maxPower;
  }

  int16_t maxRpm = isTurning ? MAX_TURN_RPM : MAX_SPEED_RPM;

  leftSpeed = (int16_t)(leftPower * maxRpm);
  rightSpeed = (int16_t)(rightPower * maxRpm);
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
  Serial.println("  V2.4 - STANDALONE BUILD + OTA");
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
        emergencyStop = false;
        Serial.println("[CTRL] Controller connected");
      }
      else if (strncmp(buf, "STATE,DISCONNECTED", 18) == 0) {
        controllerConnected = false;
        emergencyStopMotors();
        Serial.println("[CTRL] Controller disconnected - STOPPING");
      }
      else if (strncmp(buf, "AX,", 3) == 0) {
        char name[3];
        long val;
        unsigned long ms;
        if (sscanf(buf, "AX,%2[^,],%ld,%lu", name, &val, &ms) == 3) {
          controllerConnected = true;
          if (strcmp(name, "LX") == 0) currentLX = val;
          else if (strcmp(name, "LY") == 0) currentLY = val;
        }
      }
      else if (strncmp(buf, "BTN,", 4) == 0) {
        long id, state;
        unsigned long ms;
        if (sscanf(buf, "BTN,%ld,%ld,%lu", &id, &state, &ms) == 3) {
          if (state == 1) {
            if (id == 7) {
              emergencyStopMotors();
              Serial.println("[BTN] START pressed - E-STOP ACTIVATED");
            }
            else if (id == 6) {
              Serial.println("[BTN] BACK pressed - Resuming...");
              fullReset();
            }
            else if (id == 0) {
              Serial.println("[BTN] A pressed - Resetting drivers...");
              fullReset();
            }
          }
        }
      }
    } else {
      buf[n++] = c;
    }
  }

  // ===== MOTOR CONTROL UPDATE =====
  if (controllerConnected && !emergencyStop && motorsEnabled) {
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
  if (now - lastComm > 5000 && controllerConnected) {
    controllerConnected = false;
    emergencyStopMotors();
    Serial.println("[TIMEOUT] No controller data - E-STOP");
  }

  // ===== ECHO DRIVER RESPONSES =====
  while (Serial3.available()) {
    uint8_t b = Serial3.read();
  }
}
