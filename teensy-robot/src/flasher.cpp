// ===== FLASHERX OTA UPDATE =====
// Embedded FlasherX for wireless firmware updates
// Original by Niels A. Moseley, Jon Zeeff, Deb Hollenback
// Paul Stoffregen's T4.x flash routines from Teensy4 core
// This code is released into the public domain.
// =====================================================

#include "flasher.h"
#include "modbus.h"
#include <stdarg.h>

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

// Helper to print to both Serial (USB) and Serial1 (ESP32) for wireless visibility
void dualPrintf(const char* format, ...) {
  static char buf[128];
  va_list args;
  va_start(args, format);
  vsnprintf(buf, sizeof(buf), format, args);
  va_end(args);
  Serial.print(buf);
  Serial1.print(buf);
}

// AUTO-CONFIRMS instead of asking user - essential for wireless OTA
void update_firmware(Stream *in, Stream *out,
                uint32_t buffer_addr, uint32_t buffer_size) {
  static char line[96];
  static char data[32] __attribute__ ((aligned (8)));
  hex_info_t hex = {
    data, 0, 0, 0,
    0, 0xFFFFFFFF, 0,
    0, 0
  };

  dualPrintf("FLASH_PROGRESS,reading hex lines...\n");

  while (!hex.eof) {
    read_ascii_line(in, line, sizeof(line));

    if (parse_hex_line((const char*)line, hex.data, &hex.addr, &hex.num, &hex.code) == 0) {
      dualPrintf("FLASH_ERROR,bad hex line: %s\n", line);
      return;
    }
    else if (process_hex_record(&hex) != 0) {
      dualPrintf("FLASH_ERROR,invalid hex code %d\n", hex.code);
      return;
    }
    else if (hex.code == 0) {
      uint32_t addr = buffer_addr + hex.base + hex.addr - FLASH_BASE_ADDR;
      if (hex.max > (FLASH_BASE_ADDR + buffer_size)) {
        dualPrintf("FLASH_ERROR,max address %08lX too large\n", hex.max);
        return;
      }
      else if (!IN_FLASH(buffer_addr)) {
        memcpy((void*)addr, (void*)hex.data, hex.num);
      }
      else if (IN_FLASH(buffer_addr)) {
        int error = flash_write_block(addr, hex.data, hex.num);
        if (error) {
          dualPrintf("FLASH_ERROR,error %02X in flash_write_block()\n", error);
          return;
        }
      }
    }
    hex.lines++;

    // Progress update every 500 lines
    if (hex.lines % 500 == 0) {
      dualPrintf("FLASH_PROGRESS,%d lines written\n", hex.lines);
    }
  }

  dualPrintf("FLASH_PROGRESS,hex file: %d lines %lu bytes (%08lX - %08lX)\n",
            hex.lines, hex.max-hex.min, hex.min, hex.max);

  // Check FLASH_ID in new code
  if (check_flash_id(buffer_addr, hex.max - hex.min)) {
    dualPrintf("FLASH_PROGRESS,verified target ID %s\n", FLASH_ID);
  }
  else {
    dualPrintf("FLASH_ERROR,new code missing string %s\n", FLASH_ID);
    return;
  }

  // AUTO-CONFIRM: No user input needed for wireless OTA!
  dualPrintf("FLASH_PROGRESS,AUTO-CONFIRM: flashing %d lines\n", hex.lines);
  dualPrintf("FLASH_PROGRESS,calling flash_move() to load new firmware...\n");
  Serial.flush();
  Serial1.flush();

  flash_move(FLASH_BASE_ADDR, buffer_addr, hex.max - hex.min);
  REBOOT;
}

// ===== MAIN OTA ENTRY POINT =====
void startOtaUpdate() {
  uint32_t buffer_addr, buffer_size;

  emergencyStopMotors();
  dualPrintf("\n[OTA] === FLASH MODE ACTIVATED ===\n");
  dualPrintf("[OTA] Initializing flash buffer...\n");

  if (firmware_buffer_init(&buffer_addr, &buffer_size) == 0) {
    dualPrintf("FLASH_ERROR,Unable to create flash buffer!\n");
    return;
  }

  dualPrintf("[OTA] Buffer: %luK at 0x%08lX\n", buffer_size/1024, buffer_addr);
  dualPrintf("FLASH_READY\n");

  update_firmware(&Serial1, &Serial, buffer_addr, buffer_size);

  dualPrintf("FLASH_ERROR,Update failed or aborted, cleaning up...\n");
  firmware_buffer_free(buffer_addr, buffer_size);

  dualPrintf("[OTA] Rebooting...\n");
  delay(100);
  REBOOT;
}
