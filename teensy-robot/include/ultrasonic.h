// ===== ULTRASONIC SENSOR MODULE =====
// JSN-SR04T waterproof ultrasonic sensors (4x)
// Range: 25cm - 450cm (~0.8ft - 15ft)
// =====================================

#ifndef ULTRASONIC_H
#define ULTRASONIC_H

#include <Arduino.h>

// Pin definitions for 4 corner-mounted sensors
// Front-Left: Trig→Pin 8, Echo→Pin 7
#define US_FL_TRIG 8
#define US_FL_ECHO 7

// Front-Right: Trig→Pin 2, Echo→Pin 3
#define US_FR_TRIG 2
#define US_FR_ECHO 3

// Rear-Left: Trig→Pin 4, Echo→Pin 5
#define US_RL_TRIG 4
#define US_RL_ECHO 5

// Rear-Right: Trig→Pin 6, Echo→Pin 9
#define US_RR_TRIG 6
#define US_RR_ECHO 9

// Timing constants
#define US_TIMEOUT_US 15000    // 15ms timeout (~2.5m range) - reduced from 40ms to prevent blocking Xbox
#define US_MIN_INTERVAL_MS 150 // Minimum time between readings per sensor (increased to reduce blocking)

// Distance thresholds (in cm) - JSN-SR04T-V3.0: 21-600cm range
#define US_MIN_RANGE_CM 30     // Minimum reliable range (raised from 21 to filter noise)
#define US_MAX_RANGE_CM 600    // Maximum reliable range

// Distance readings (in cm, 0 = no reading/out of range)
extern float distFL;  // Front-Left
extern float distFR;  // Front-Right
extern float distRL;  // Rear-Left
extern float distRR;  // Rear-Right

// Initialize ultrasonic sensor pins
void ultrasonicInit();

// Read all sensors (call periodically from main loop)
// Returns true if any reading changed significantly
bool ultrasonicUpdate();

// Send distance data to ESP32 via Serial1
void ultrasonicSendToESP32();

// Get distance in feet for display
float cmToFeet(float cm);

#endif // ULTRASONIC_H
