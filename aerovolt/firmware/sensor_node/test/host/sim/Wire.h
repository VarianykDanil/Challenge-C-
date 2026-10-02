// Host stand-in for the Arduino Wire (I2C) library, connected to the emulated I2C bus of
// sim_world.h. Same return conventions as the real library: endTransmission() returns 0
// on ACK and 2 when the address is not acknowledged; requestFrom() returns the number of
// bytes received (0 on NACK).
#pragma once

#include <stddef.h>
#include <stdint.h>

class TwoWire {
public:
    void begin();
    void setClock(uint32_t hz);
    void beginTransmission(uint8_t address);
    size_t write(uint8_t byte);
    uint8_t endTransmission(bool send_stop = true);
    uint8_t requestFrom(uint8_t address, uint8_t quantity);
    int available();
    int read();

private:
    uint8_t address_ = 0;
    uint8_t tx_[32] = {};
    uint8_t tx_len_ = 0;
    uint8_t rx_[32] = {};
    uint8_t rx_len_ = 0;
    uint8_t rx_pos_ = 0;
};

extern TwoWire Wire;
