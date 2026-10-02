// Host stand-in for the Arduino core API - only what the AeroVolt firmware uses.
//
// It lets the REAL firmware sources (src/) compile and run on a PC: time is virtual
// (advanced by the simulation and by delay()), pins and the serial port are connected to
// the emulated hardware in sim_world.h. Used only by test/host (firmware_sim_*).
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2

// Flash strings: on a PC they are ordinary strings.
class __FlashStringHelper;
#define F(s) (reinterpret_cast<const __FlashStringHelper*>(s))
#define pgm_read_byte(p) (*reinterpret_cast<const uint8_t*>(p))

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t level);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void noInterrupts();
void interrupts();

/// The board's serial port: bytes go into the simulation's capture buffer.
class SimSerial {
public:
    void begin(uint32_t baud);
    size_t write(uint8_t byte);
};

extern SimSerial Serial;
