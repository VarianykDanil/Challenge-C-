// CAN output: a minimal transmit-only interface over the board's CAN controller.
//
//   Teensy 4.x : FlexCAN_T4 (ships with Teensyduino), CAN1 on pins 22 (TX) / 23 (RX).
//   ESP32      : the built-in TWAI controller ("Two-Wire Automotive Interface" = CAN 2.0)
//                through the ESP-IDF driver/twai.h, pins from node_config.h.
// Both need an external 3.3 V transceiver (e.g. SN65HVD230) between the controller pins
// and the CANH/CANL bus wires, and 120 ohm termination at the two ends of the bus.
//
// Only compiled when AV_USE_CAN is 1 (platformio.ini). Frames are classic CAN 2.0A:
// 11-bit identifier, 8 data bytes (SPEC 7.3).
#pragma once

#include <stdint.h>

/// Bring the controller up at `bitrate` (1 000 000 for AeroVolt). True on success.
bool can_bus_begin(uint32_t bitrate);

/// Queue one 8-byte data frame. False if the transmit queue is full or the bus is off.
bool can_bus_send(uint32_t id, const uint8_t data[8]);

/// Housekeeping, call every loop: e.g. recover from "bus off" (after too many errors the
/// controller disconnects itself from the bus; it must be restarted explicitly on ESP32).
void can_bus_poll(uint32_t now_ms);
