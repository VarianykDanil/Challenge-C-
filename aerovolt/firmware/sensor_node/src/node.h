// The sensor-node application: reads the sensors listed in include/node_config.h and
// publishes their values as $AV serial lines and/or CAN frames.
//
// Everything is cooperative and non-blocking: node_poll() is called from loop() as often
// as possible and uses avcore CycleTimers to decide what is due (sensor reads, CAN
// messages at their DBC cycle time, serial lines, the 5 s hello). Only sensor
// (re-)initialisation blocks briefly (a few ms, at most once per second per failed sensor).
#pragma once

#include <stdint.h>

/// Start the serial port, I2C, the sensors and the CAN controller; print the hello.
void node_begin();

/// Do whatever is due at time `now_ms` (the Arduino millis() counter).
void node_poll(uint32_t now_ms);
