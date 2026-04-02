// ===== ULTRASONIC SENSOR MODULE =====
// JSN-SR04T waterproof ultrasonic sensors (4x)
// Moving average filter for noise reduction
// =====================================

#include "ultrasonic.h"

// Global distance readings (cm) - smoothed
float distFL = 0;
float distFR = 0;
float distRL = 0;
float distRR = 0;

// Timing for staggered readings
static uint32_t lastReadTime[4] = {0, 0, 0, 0};
static int currentSensor = 0;

// Previous values for change detection
static float prevFL = 0, prevFR = 0, prevRL = 0, prevRR = 0;

// === MOVING AVERAGE FILTER ===
#define US_FILTER_SIZE 5  // Average last 5 readings (reduces noise significantly)
static float filterFL[US_FILTER_SIZE] = {0};
static float filterFR[US_FILTER_SIZE] = {0};
static float filterRL[US_FILTER_SIZE] = {0};
static float filterRR[US_FILTER_SIZE] = {0};
static int filterIdx[4] = {0, 0, 0, 0};  // Current index for each sensor

// Compute moving average (ignores zero values = out of range readings)
static float movingAverage(float* buffer, float newVal, int sensorIdx) {
  // If valid reading, add to buffer
  if (newVal > 0) {
    buffer[filterIdx[sensorIdx]] = newVal;
    filterIdx[sensorIdx] = (filterIdx[sensorIdx] + 1) % US_FILTER_SIZE;
  }

  // Calculate average of non-zero values
  float sum = 0;
  int count = 0;
  for (int i = 0; i < US_FILTER_SIZE; i++) {
    if (buffer[i] > 0) {
      sum += buffer[i];
      count++;
    }
  }

  return (count > 0) ? (sum / count) : 0;
}

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

    float rawReading;
    switch (currentSensor) {
      case 0:
        rawReading = readSensor(US_FL_TRIG, US_FL_ECHO);
        distFL = movingAverage(filterFL, rawReading, 0);
        break;
      case 1:
        rawReading = readSensor(US_FR_TRIG, US_FR_ECHO);
        distFR = movingAverage(filterFR, rawReading, 1);
        break;
      case 2:
        rawReading = readSensor(US_RL_TRIG, US_RL_ECHO);
        distRL = movingAverage(filterRL, rawReading, 2);
        break;
      case 3:
        rawReading = readSensor(US_RR_TRIG, US_RR_ECHO);
        distRR = movingAverage(filterRR, rawReading, 3);
        break;
    }

    currentSensor = (currentSensor + 1) % 4;
  }

  // Check if any reading changed significantly (> 5cm)
  // The filter smooths readings so changes are more reliable
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
