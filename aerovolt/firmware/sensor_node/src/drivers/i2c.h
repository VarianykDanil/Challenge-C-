// Small helpers on top of the Arduino Wire library, shared by the I2C drivers.
//
// I2C in one paragraph: the controller (our microcontroller) starts every transfer with
// the 7-bit address of a target device; the device answers with an ACK bit if it is there.
// A write sends bytes (e.g. a 16-bit command, MSB first); a read clocks bytes out of the
// device. "Repeated start" (endTransmission(false)) keeps the bus between writing a
// register address and reading it back, so no other controller can interfere.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace i2c {

/// True if a device ACKs `address` (an empty write - what an "I2C scanner" does).
bool probe(uint8_t address);

/// Write a 16-bit command, MSB first (Sensirion style). True on ACK.
bool write_command16(uint8_t address, uint16_t command);

/// Write one register (`reg` then `value`). True on ACK.
bool write_register(uint8_t address, uint8_t reg, uint8_t value);

/// Write the register address, repeated start, read `n` bytes. True if all arrived.
bool read_registers(uint8_t address, uint8_t reg, uint8_t* out, uint8_t n);

/// Read `n` bytes (no register address). True if all arrived (false = NACK).
bool read_bytes(uint8_t address, uint8_t* out, uint8_t n);

}  // namespace i2c
