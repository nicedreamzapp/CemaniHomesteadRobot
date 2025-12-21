// ===== ULTRASONIC SENSOR MODULE =====
// JSN-SR04T waterproof ultrasonic sensors (4x)
// =====================================

#include "ultrasonic.h"

// Global distance readings (cm)
float distFL = 0;
float distFR = 0;
float distRL = 0;
float distRR = 0;

// Timing for staggered readings
static uint32_t lastReadTime[4] = {0, 0, 0, 0};
static int currentSensor = 0;

// Previous values for change detection
static float prevFL = 0, prevFR = 0, prevRL = 0, prevRR = 0;

void ultrasonicInit() {
  // Front-Left
  pinMode(US_FL_TRIG, OUTPUT);
  pinMode(US_FL_ECHO, INPUT);
  digitalWrite(US_FL_TRIG, LOW);

  // Front-Right
  pinMode(US_FR_TRIG, OUTPUT);
  pinMode(US_FR_ECHO, INPUT);
  digitalWrite(US_FR_TRIG, LOW);

  // Rear-Left
  pinMode(US_RL_TRIG, OUTPUT);
  pinMode(US_RL_ECHO, INPUT);
  digitalWrite(US_RL_TRIG, LOW);

  // Rear-Right
  pinMode(US_RR_TRIG, OUTPUT);
  pinMode(US_RR_ECHO, INPUT);
  digitalWrite(US_RR_TRIG, LOW);

  Serial.println("[SONAR] 4x JSN-SR04T ultrasonic sensors initialized");
  Serial.println("  FL: Trig=8, Echo=7");
  Serial.println("  FR: Trig=2, Echo=3");
  Serial.println("  RL: Trig=4, Echo=5");
  Serial.println("  RR: Trig=6, Echo=9");
}

// Read a single sensor (returns distance in cm, 0 if out of range)
static float readSensor(int trigPin, int echoPin) {
  // Trigger pulse
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  // Measure echo pulse duration
  unsigned long duration = pulseIn(echoPin, HIGH, US_TIMEOUT_US);

  if (duration == 0) {
    return 0;  // No echo (out of range or error)
  }

  // Calculate distance: speed of sound = 343m/s = 0.0343 cm/µs
  // Distance = (duration * 0.0343) / 2 (round trip)
  float distance = (duration * 0.0343f) / 2.0f;

  // Validate range
  if (distance < US_MIN_RANGE_CM || distance > US_MAX_RANGE_CM) {
    return 0;
  }

  return distance;
}

bool ultrasonicUpdate() {
  uint32_t now = millis();

  // Read one sensor per call to avoid blocking (staggered readings)
  // This prevents interference between sensors
  if (now - lastReadTime[currentSensor] >= US_MIN_INTERVAL_MS) {
    lastReadTime[currentSensor] = now;

    switch (currentSensor) {
      case 0:
        distFL = readSensor(US_FL_TRIG, US_FL_ECHO);
        break;
      case 1:
        distFR = readSensor(US_FR_TRIG, US_FR_ECHO);
        break;
      case 2:
        distRL = readSensor(US_RL_TRIG, US_RL_ECHO);
        break;
      case 3:
        distRR = readSensor(US_RR_TRIG, US_RR_ECHO);
        break;
    }

    currentSensor = (currentSensor + 1) % 4;
  }

  // Check if any reading changed significantly (> 5cm)
  bool changed = false;
  if (abs(distFL - prevFL) > 5) { prevFL = distFL; changed = true; }
  if (abs(distFR - prevFR) > 5) { prevFR = distFR; changed = true; }
  if (abs(distRL - prevRL) > 5) { prevRL = distRL; changed = true; }
  if (abs(distRR - prevRR) > 5) { prevRR = distRR; changed = true; }

  return changed;
}

void ultrasonicSendToESP32() {
  // Format: SONAR,FL,FR,RL,RR (distances in cm)
  Serial1.printf("SONAR,%.0f,%.0f,%.0f,%.0f\n", distFL, distFR, distRL, distRR);
  // Debug to USB Serial
  Serial.printf("[SONAR] FL:%.0f FR:%.0f RL:%.0f RR:%.0f cm\n", distFL, distFR, distRL, distRR);
}

float cmToFeet(float cm) {
  if (cm <= 0) return 0;
  return cm / 30.48f;
}
