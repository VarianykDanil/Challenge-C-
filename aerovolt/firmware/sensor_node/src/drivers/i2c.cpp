// Small helpers on top of the Arduino Wire library. See i2c.h.
#include "i2c.h"

#include <Wire.h>

namespace i2c {

bool probe(uint8_t address) {
    Wire.beginTransmission(address);
    return Wire.endTransmission() == 0;
}

bool write_command16(uint8_t address, uint16_t command) {
    Wire.beginTransmission(address);
    Wire.write(static_cast<uint8_t>(command >> 8));
    Wire.write(static_cast<uint8_t>(command & 0xFF));
    return Wire.endTransmission() == 0;
}

bool write_register(uint8_t address, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

bool read_registers(uint8_t address, uint8_t reg, uint8_t* out, uint8_t n) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    return read_bytes(address, out, n);
}

bool read_bytes(uint8_t address, uint8_t* out, uint8_t n) {
    // The casts pick the same requestFrom() overload on every Arduino core.
    const uint8_t got = static_cast<uint8_t>(Wire.requestFrom(static_cast<uint8_t>(address), static_cast<uint8_t>(n)));
    if (got != n) {
        while (Wire.available()) Wire.read();  // discard a partial answer
        return false;
    }
    for (uint8_t i = 0; i < n; ++i) out[i] = static_cast<uint8_t>(Wire.read());
    return true;
}

}  // namespace i2c
