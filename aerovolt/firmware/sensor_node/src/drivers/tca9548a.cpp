// Driver for the TCA9548A 1-to-8 I2C multiplexer. See tca9548a.h.
#include "tca9548a.h"

#include <Wire.h>

bool Tca9548a::begin() {
    current_mask_ = -1;
    return select_mask(0x00);
}

bool Tca9548a::select(int8_t channel) {
    const uint8_t mask = (channel >= 0 && channel <= 7) ? static_cast<uint8_t>(1u << channel) : 0x00;
    if (current_mask_ == mask) return true;
    return select_mask(mask);
}

bool Tca9548a::select_mask(uint8_t mask) {
    Wire.beginTransmission(address_);
    Wire.write(mask);
    const bool ok = Wire.endTransmission() == 0;
    current_mask_ = ok ? mask : -1;  // on failure: unknown, write again next time
    return ok;
}
