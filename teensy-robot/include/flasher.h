// ===== FLASHERX OTA UPDATE =====
// Embedded FlasherX for wireless firmware updates
// Original by Niels A. Moseley, Jon Zeeff, Deb Hollenback
// =====================================================

#ifndef FLASHER_H
#define FLASHER_H

#include <Arduino.h>
#include "config.h"

// hex_info_t struct for hex record and hex file info
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

// Main OTA entry point
void startOtaUpdate();

#endif // FLASHER_H
