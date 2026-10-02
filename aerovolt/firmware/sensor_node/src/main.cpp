// AeroVolt sensor node firmware - Arduino entry points.
//
// Build and upload with PlatformIO (see platformio.ini and docs/HARDWARE.md):
//     pio run -e nano_serial -t upload      Phase-2 bench node (one SDP + BME280, USB)
//     pio run -e teensy41 -t upload         front aero node, CAN + USB serial
//     pio run -e esp32dev -t upload         same on an ESP32 (TWAI CAN)
// What is connected where: include/node_config.h.
#include <Arduino.h>

#include "node.h"

void setup() { node_begin(); }

void loop() { node_poll(millis()); }
