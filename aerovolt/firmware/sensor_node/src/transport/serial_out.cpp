// $AV serial output. See serial_out.h.
#include "serial_out.h"

#include <Arduino.h>

void SerialSink::put(char c) { Serial.write(static_cast<uint8_t>(c)); }

void serial_out_begin(uint32_t baud) {
    // On boards with native USB (Teensy, many ESP32-S2/S3) the baud rate is ignored and the
    // port works as soon as the computer opens it; we never wait for it, so a node without
    // a computer attached runs (and sends CAN) exactly the same.
    Serial.begin(baud);
}
