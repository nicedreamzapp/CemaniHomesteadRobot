// ===== FLASHERX OTA UPDATE =====
// Embedded FlasherX for wireless firmware updates
// Original by Niels A. Moseley, Jon Zeeff, Deb Hollenback
// Paul Stoffregen's T4.x flash routines from Teensy4 core
// This code is released into the public domain.
// =====================================================

#include "flasher.h"
#include "modbus.h"

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

// ===== MAIN OTA ENTRY POINT =====
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
