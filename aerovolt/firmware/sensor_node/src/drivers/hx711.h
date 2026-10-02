// Driver for the Avia HX711 24-bit load-cell ADC (two-wire, bit-banged).
//
// Protocol (HX711 datasheet): DOUT goes LOW when a conversion is ready. The controller then
// gives 25 clock pulses on PD_SCK: on each of the first 24 the next data bit (MSB first,
// two's complement) appears on DOUT; the 25th selects channel A with gain 128 for the next
// conversion (26 / 27 pulses would select other gains/channels). PD_SCK must not stay HIGH
// for more than 60 us, or the chip powers down - so interrupts are blocked during the ~50 us
// read. With the RATE pin high the HX711 converts at 80 samples/s, otherwise at 10.
#pragma once

#include <stdint.h>

class Hx711 {
public:
    /// Configure the pins (DOUT with pull-up: a missing board then never looks "ready").
    void begin(uint8_t dout_pin, uint8_t sck_pin);

    /// True when a new conversion can be read (DOUT low).
    bool ready() const;

    /// Clock out one conversion (call only when ready()); signed 24-bit counts.
    int32_t read_counts();

private:
    uint8_t dout_ = 0;
    uint8_t sck_ = 0;
};
