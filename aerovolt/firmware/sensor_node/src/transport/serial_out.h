// $AV serial output: connects avcore's line writer (av_line.h) to the board's Serial port
// (USB on Teensy / Nano / ESP32 dev boards, see node_config.h for the baud rate).
#pragma once

#include <stdint.h>

#include "av_line.h"

/// Character sink that writes straight into the Arduino `Serial` port - no line buffer.
class SerialSink final : public av::CharSink {
public:
    void put(char c) override;
};

/// Open the serial port.
void serial_out_begin(uint32_t baud);
