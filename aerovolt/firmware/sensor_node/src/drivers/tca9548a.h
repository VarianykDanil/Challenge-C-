// Driver for the TCA9548A 1-to-8 I2C multiplexer.
//
// Why a mux: every SDP810 has the same fixed address (0x25), so eight of them cannot share
// one bus. The TCA9548A (address 0x70..0x77) connects the main bus to any combination of
// its 8 downstream channels; we enable exactly one before talking to a sensor. Its single
// control register is written with a bit mask: bit n = channel n enabled, 0 = none.
#pragma once

#include <stdint.h>

class Tca9548a {
public:
    explicit Tca9548a(uint8_t address = 0x70) : address_(address) {}

    /// Check the mux answers and disable all channels.
    bool begin();

    /// Enable only `channel` (0..7); -1 disables all channels (talk to the main bus only).
    /// Skips the I2C write if that channel is already selected.
    bool select(int8_t channel);

    /// Enable an arbitrary set of channels (bit mask), e.g. 0xFF for a general-call reset.
    bool select_mask(uint8_t mask);

private:
    uint8_t address_;
    int16_t current_mask_ = -1;  // unknown until the first successful write
};
