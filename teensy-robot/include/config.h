// ===== CEMANI HOMESTEAD ROBOT - CONFIGURATION =====
// All configuration constants in one place
// =====================================================

#ifndef CONFIG_H
#define CONFIG_H

#define TEENSY_VERSION "3.8"

// ===== ROBOT CONFIGURATION =====
#define INVERT_DRIVER_1 true
#define INVERT_DRIVER_2 false

// ===== ODOMETRY CONFIGURATION =====
// 8-inch hub motor wheels
#define WHEEL_DIAMETER_MM     203.2f   // 8 inches = 203.2mm
#define WHEEL_CIRCUMFERENCE_MM (WHEEL_DIAMETER_MM * 3.14159f)  // ~638.4mm
#define WHEEL_BASE_MM         550.0f   // Distance between wheels (adjust for your robot)
#define ENCODER_COUNTS_PER_REV 4096    // 1024 lines * 4 (quadrature)

// SAFETY: Max speeds - keep LOW to prevent crashes!
#define MAX_SPEED_RPM 75         // Half speed for forward/backward
#define MAX_TURN_RPM 5           // Match web UI turn speed - super smooth

// Software acceleration (RPM change per update cycle)
#define ACCEL_RATE_NORMAL 3      // Slower ramp up
#define ACCEL_RATE_TURN 1        // Keep slow turn ramp

// Hardware acceleration (ms to reach target - higher = slower)
#define DRIVER_ACCEL_NORMAL 500  // More gradual
#define DRIVER_ACCEL_TURN 1500   // Keep slow for turns

#define TORQUE_NORMAL 1000       // Original value
#define TORQUE_TURN 150          // Keep low for turns

#define JOYSTICK_DEADZONE 0.15f  // Larger deadzone to prevent accidental moves
#define MOTOR_UPDATE_INTERVAL 50

// Input noise filtering
#define INPUT_FILTER_SAMPLES 1   // Accept immediately
#define INPUT_CHANGE_THRESHOLD 5 // Much smaller threshold

// ===== MODBUS REGISTER DEFINITIONS =====
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

// ===== TELEMETRY REGISTER DEFINITIONS =====
#define REG_BUS_VOLTAGE     0x20A1  // Bus voltage (0.01V units) - BATTERY!
#define REG_STATUS_WORD     0x20A2  // Status word
#define REG_MOTOR_TEMP      0x20A4  // Motor temps (high=L, low=R, 1C)
#define REG_ERROR_L         0x20A5  // Error code left
#define REG_ERROR_R         0x20A6  // Error code right
#define REG_POS_L_HIGH      0x20A7  // Position L high word
#define REG_POS_L_LOW       0x20A8  // Position L low word
#define REG_POS_R_HIGH      0x20A9  // Position R high word
#define REG_POS_R_LOW       0x20AA  // Position R low word
#define REG_VEL_ACT_L       0x20AB  // Actual velocity L (0.1 RPM)
#define REG_VEL_ACT_R       0x20AC  // Actual velocity R (0.1 RPM)
#define REG_TORQUE_ACT_L    0x20AD  // Actual torque L (0.1A)
#define REG_TORQUE_ACT_R    0x20AE  // Actual torque R (0.1A)
#define REG_DRIVER_TEMP     0x20B0  // Driver temperature (0.1C)

// Telemetry update interval
#define TELEMETRY_INTERVAL  1000   // Read telemetry every 1 second

// ===== DISCRETE MOVEMENT CONSTANTS =====
#define TURN_MS_PER_DEGREE 100     // ms per degree of rotation
#define MOVE_MS_PER_CM     140     // ms per cm
#define DISCRETE_TURN_RPM  5       // RPM for turning
#define DISCRETE_MOVE_RPM  15      // RPM for forward/backward

// ===== FLASHERX CONSTANTS =====
#define FLASH_ID            "fw_teensy41"
#define FLASH_SIZE          (0x800000)        // 8MB
#define FLASH_SECTOR_SIZE   (0x1000)          // 4KB sector size
#define FLASH_WRITE_SIZE    (4)               // 4-byte/32-bit writes
#define FLASH_RESERVE       (4*FLASH_SECTOR_SIZE)
#define FLASH_BASE_ADDR     (0x60000000)
#define RAM_BUFFER_SIZE     (0 * 1024)

#define IN_FLASH(a) ((a) >= FLASH_BASE_ADDR && (a) < FLASH_BASE_ADDR+FLASH_SIZE)

#define CPU_RESTART_ADDR    ((uint32_t *)0xE000ED0C)
#define CPU_RESTART_VAL     (0x5FA0004)
#define REBOOT              (*CPU_RESTART_ADDR = CPU_RESTART_VAL)

#define NO_BUFFER_TYPE      (0)
#define FLASH_BUFFER_TYPE   (1)
#define RAM_BUFFER_TYPE     (2)

#define RAMFUNC __attribute__ ((section(".fastrun"), noinline, noclone, optimize("Os") ))

#endif // CONFIG_H
