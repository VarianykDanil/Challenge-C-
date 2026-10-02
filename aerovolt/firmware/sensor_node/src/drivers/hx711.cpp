// Driver for the Avia HX711 load-cell ADC. See hx711.h.
#include "hx711.h"

#include <Arduino.h>

#include "calibration.h"

void Hx711::begin(uint8_t dout_pin, uint8_t sck_pin) {
    dout_ = dout_pin;
    sck_ = sck_pin;
    pinMode(sck_, OUTPUT);
    digitalWrite(sck_, LOW);  // SCK low = chip powered up
    pinMode(dout_, INPUT_PULLUP);
}

bool Hx711::ready() const { return digitalRead(dout_) == LOW; }

int32_t Hx711::read_counts() {
    uint32_t raw = 0;
    noInterrupts();
    for (uint8_t i = 0; i < 24; ++i) {
        digitalWrite(sck_, HIGH);
        delayMicroseconds(1);  // t_PD_SCK high >= 0.2 us; data valid 0.1 us after the rising edge
        raw = (raw << 1) | (digitalRead(dout_) == HIGH ? 1u : 0u);
        digitalWrite(sck_, LOW);
        delayMicroseconds(1);
    }
    digitalWrite(sck_, HIGH);  // 25th pulse: channel A, gain 128 for the next conversion
    delayMicroseconds(1);
    digitalWrite(sck_, LOW);
    interrupts();
    return av::hx711_sign_extend(raw);
}
