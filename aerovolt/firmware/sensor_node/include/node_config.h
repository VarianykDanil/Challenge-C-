// =========================================================================================
// AeroVolt sensor node - WHAT IS CONNECTED WHERE.  (This is the file you edit.)
// =========================================================================================
// Every physical sensor is listed here with the AeroVolt channel id it feeds (the ids of
// config/sensors.yaml and the signal names of can/aerovolt.dbc). The firmware reads this
// table at start-up: it announces the channels in its $AVH hello, puts each value into
// the right CAN frame (see include/aerovolt_can.h), and fills the signals it does not own
// with SNA ("signal not available").
//
// 1. Pick a PROFILE (platformio.ini sets it per environment with -D NODE_PROFILE=...):
//      NODE_PROFILE_AERO_FRONT   - the front aero node of the car: 8 front-wing taps (SDP
//                                  sensors behind a TCA9548A I2C mux), the pitot, the
//                                  BME280 ambient sensor, plus (optional, see below) the
//                                  front-wing mount load cell and the two front dampers.
//      NODE_PROFILE_BENCH_ONE_TAP - the Phase-2 bench demo: ONE SDP sensor feeding front-wing
//                                  tap 3 (fw_p03) + a BME280, over USB serial. Runs on an
//                                  Arduino Nano. Blow into the tube and watch the tap light
//                                  up on the 3D car (docs/HARDWARE.md, "Phase-2 bench demo").
// 2. Outputs (also set in platformio.ini): AV_USE_SERIAL ($AV lines on USB/UART) and
//    AV_USE_CAN (frames on the car's CAN bus; Teensy 4.x and ESP32 only).
// 3. Edit the tables of your profile below: channel ids, mux channels, I2C addresses, pins
//    and calibration constants. Rates are the catalogue rates (sensors.yaml rate_hz).
//
// Rules: a channel id may appear only once; it must exist in config/sensors.yaml; pressure
// channels are raw sensor Pa - zero offsets are removed on the computer by
// config/calibration.yaml (tools/calibrate_taps.py), not here.
// =========================================================================================
#pragma once

#include <stdint.h>

#include "calibration.h"  // avcore: av::LinearPotCal, av::Hx711Cal

// ---- Profile and outputs ------------------------------------------------------------------
#define NODE_PROFILE_AERO_FRONT 1
#define NODE_PROFILE_BENCH_ONE_TAP 2

#ifndef NODE_PROFILE
#define NODE_PROFILE NODE_PROFILE_BENCH_ONE_TAP
#endif
#ifndef AV_USE_SERIAL
#define AV_USE_SERIAL 1
#endif
#ifndef AV_USE_CAN
#define AV_USE_CAN 0
#endif

namespace node_config {

// ---- Common settings ------------------------------------------------------------------
constexpr char FW_VERSION[] = "1.0.0";
constexpr uint32_t SERIAL_BAUD = 115200;      // must match 'baud' of the serial source
constexpr uint32_t I2C_CLOCK_HZ = 400000;     // fast mode; drop to 100000 for long cables
constexpr uint32_t HELLO_PERIOD_MS = 5000;    // $AVH hello (and a reminder of failing sensors)
constexpr uint32_t SENSOR_RETRY_MS = 1000;    // how often a failed sensor is re-initialised
constexpr uint8_t SENSOR_FAILS_BEFORE_ERROR = 3;  // consecutive bad reads before "error"
constexpr uint32_t CAN_BITRATE = 1000000;     // classic CAN, 1 Mbit/s (SPEC 7.3)

constexpr int8_t NO_MUX = -1;                 // sensor sits directly on the I2C bus
constexpr uint8_t SDP_AUTO_ADDRESS = 0;       // probe 0x25, 0x21, 0x26, 0x22, 0x23
constexpr uint8_t TCA9548A_ADDRESS = 0x70;    // A0..A2 tied low

/// A Sensirion SDP3x/SDP8xx differential-pressure sensor.
struct PressureSensorConfig {
    const char* channel;   // e.g. "fw_p03" (tap) or "pitot_dp"
    int8_t mux_channel;    // TCA9548A channel 0..7, or NO_MUX
    uint8_t i2c_address;   // 0x25 SDP810/SDP800, 0x21 SDP31/SDP32, or SDP_AUTO_ADDRESS
};

/// The BME280 ambient sensor (feeds amb_temp, amb_press, amb_rh).
struct AmbientConfig {
    bool fitted;
    uint8_t i2c_address;   // 0x76 (SDO to GND) or 0x77 (SDO to VDD)
    int8_t mux_channel;
};

/// A linear potentiometer on an analog pin (damper position).
struct PotConfig {
    const char* channel;   // e.g. "damper_fl" (mm, + = bump, 0 = static ride height)
    uint8_t pin;
    av::LinearPotCal cal;  // {zero_counts, mm_per_count, valid_min, valid_max}
};

/// An HX711 load-cell amplifier (wing-mount load).
struct LoadCellConfig {
    const char* channel;   // e.g. "fw_load" (N, vertical, + = down)
    uint8_t dout_pin;
    uint8_t sck_pin;
    av::Hx711Cal cal;      // {tare_counts, newtons_per_count}
};

// ---- Board-specific pins and ADC ------------------------------------------------------
#if defined(ESP32)
constexpr uint8_t ADC_BITS = 12;              // ESP32: use ADC1 pins (GPIO 32-39); ADC2 stops with Wi-Fi
constexpr uint8_t PIN_DAMPER_FL = 36;         // GPIO36 (VP)
constexpr uint8_t PIN_DAMPER_FR = 39;         // GPIO39 (VN)
constexpr uint8_t PIN_HX711_DOUT = 16;
constexpr uint8_t PIN_HX711_SCK = 17;
constexpr uint8_t PIN_CAN_TX = 5;             // to SN65HVD230 D (TXD)
constexpr uint8_t PIN_CAN_RX = 4;             // from SN65HVD230 R (RXD)
#elif defined(__IMXRT1062__)
constexpr uint8_t ADC_BITS = 12;              // Teensy 4.x (analogReadResolution(12))
constexpr uint8_t PIN_DAMPER_FL = 14;         // A0
constexpr uint8_t PIN_DAMPER_FR = 15;         // A1
constexpr uint8_t PIN_HX711_DOUT = 2;
constexpr uint8_t PIN_HX711_SCK = 3;          // CAN1 uses pins 22 (CTX1) and 23 (CRX1)
#else
constexpr uint8_t ADC_BITS = 10;              // ATmega328P (Arduino Nano / Uno)
constexpr uint8_t PIN_DAMPER_FL = 14;         // A0
constexpr uint8_t PIN_DAMPER_FR = 15;         // A1
constexpr uint8_t PIN_HX711_DOUT = 2;
constexpr uint8_t PIN_HX711_SCK = 3;
#endif
constexpr uint16_t ADC_MAX = (1u << ADC_BITS) - 1u;

/// Linear pot of `stroke_mm` over the whole ADC range, zero at mid-travel, with the
/// outer 2 % of the range treated as a wiring fault. Replace with a measured two-point
/// calibration (av::linear_pot_two_point) once the pot is installed.
constexpr av::LinearPotCal pot_nominal(float stroke_mm) {
    return av::LinearPotCal{ADC_MAX / 2.0f, stroke_mm / ADC_MAX, static_cast<uint16_t>(ADC_MAX / 50),
                            static_cast<uint16_t>(ADC_MAX - ADC_MAX / 50)};
}

// =========================================================================================
#if NODE_PROFILE == NODE_PROFILE_AERO_FRONT
// =========================================================================================
constexpr char NODE_NAME[] = "AERO_FRONT";
constexpr uint32_t PRESSURE_PERIOD_MS = 20;   // 50 Hz, catalogue rate of taps and pitot
constexpr uint32_t AMBIENT_PERIOD_MS = 1000;  // 1 Hz
constexpr uint32_t POT_PERIOD_MS = 2;         // 500 Hz oversampling, averaged 5 -> 100 Hz
constexpr uint32_t SERIAL_PERIOD_MS = 50;     // 20 Hz $AV lines (CAN carries the full 50 Hz)

// Optional sensors of the front node; set to 0 if not fitted (their channels then stay SNA).
#ifndef AERO_FRONT_WITH_WING_LOAD
#define AERO_FRONT_WITH_WING_LOAD 1
#endif
#ifndef AERO_FRONT_WITH_DAMPERS
#define AERO_FRONT_WITH_DAMPERS 1
#endif

// Eight SDP810-500Pa (all at 0x25) on mux channels 0..7 = front-wing taps 1..8: station L
// (y = +0.55 m) taps 1-6 and station R taps 7-8 (sensors.yaml). The pitot uses an SDP31
// (0x21) directly on the bus. NOTE: +-500 Pa sensors saturate on the leading-edge suction
// peaks above ~16 m/s (Cp -3 x q 167 Pa = -500 Pa) and the pitot above ~29 m/s (q = 500 Pa);
// docs/HARDWARE.md section 4 lists higher-range parts per location.
constexpr PressureSensorConfig PRESSURE_SENSORS[] = {
    {"fw_p01", 0, 0x25},
    {"fw_p02", 1, 0x25},
    {"fw_p03", 2, 0x25},
    {"fw_p04", 3, 0x25},
    {"fw_p05", 4, 0x25},
    {"fw_p06", 5, 0x25},
    {"fw_p07", 6, 0x25},
    {"fw_p08", 7, 0x25},
    {"pitot_dp", NO_MUX, 0x21},
};

constexpr AmbientConfig AMBIENT = {true, 0x76, NO_MUX};

#if AERO_FRONT_WITH_DAMPERS
constexpr PotConfig POT_TABLE[] = {
    {"damper_fl", PIN_DAMPER_FL, pot_nominal(75.0f)},   // 75 mm linear pot
    {"damper_fr", PIN_DAMPER_FR, pot_nominal(75.0f)},
};
constexpr const PotConfig* POTS = POT_TABLE;
constexpr uint8_t POT_COUNT = sizeof(POT_TABLE) / sizeof(POT_TABLE[0]);
#else
constexpr const PotConfig* POTS = nullptr;
constexpr uint8_t POT_COUNT = 0;
#endif

#if AERO_FRONT_WITH_WING_LOAD
// 50 kg S-beam cell (2 mV/V), HX711 channel A, gain 128, RATE pin high (80 samples/s).
// Nominal scale: full load 490 N gives 2 mV/V x 4.3 V excitation = 8.6 mV; the HX711 spans
// +-20 mV (gain 128) with +-2^23 counts, so 8.6 mV = 3.61e6 counts -> 1.36e-4 N/count.
// Measure the real tare and scale with a known mass: av::hx711_scale_from_reference().
constexpr LoadCellConfig LOAD_CELL_TABLE[] = {
    {"fw_load", PIN_HX711_DOUT, PIN_HX711_SCK, av::Hx711Cal{0, 1.36e-4f}},
};
constexpr const LoadCellConfig* LOAD_CELLS = LOAD_CELL_TABLE;
constexpr uint8_t LOAD_CELL_COUNT = 1;
#else
constexpr const LoadCellConfig* LOAD_CELLS = nullptr;
constexpr uint8_t LOAD_CELL_COUNT = 0;
#endif

// =========================================================================================
#elif NODE_PROFILE == NODE_PROFILE_BENCH_ONE_TAP
// =========================================================================================
constexpr char NODE_NAME[] = "BENCH";
constexpr uint32_t PRESSURE_PERIOD_MS = 20;   // 50 Hz
constexpr uint32_t AMBIENT_PERIOD_MS = 1000;  // 1 Hz
constexpr uint32_t POT_PERIOD_MS = 0;         // no pots
constexpr uint32_t SERIAL_PERIOD_MS = 20;     // every sample goes out on USB serial

// One SDP sensor, found automatically at any of its usual addresses, no mux.
constexpr PressureSensorConfig PRESSURE_SENSORS[] = {
    {"fw_p03", NO_MUX, SDP_AUTO_ADDRESS},
};

constexpr AmbientConfig AMBIENT = {true, 0x76, NO_MUX};

constexpr const PotConfig* POTS = nullptr;
constexpr uint8_t POT_COUNT = 0;
constexpr const LoadCellConfig* LOAD_CELLS = nullptr;
constexpr uint8_t LOAD_CELL_COUNT = 0;

#else
#error "Unknown NODE_PROFILE: use NODE_PROFILE_AERO_FRONT or NODE_PROFILE_BENCH_ONE_TAP"
#endif

constexpr uint8_t PRESSURE_COUNT = sizeof(PRESSURE_SENSORS) / sizeof(PRESSURE_SENSORS[0]);

/// Does any pressure sensor sit behind the I2C multiplexer?
constexpr bool uses_mux() {
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) {
        if (PRESSURE_SENSORS[i].mux_channel != NO_MUX) return true;
    }
    return AMBIENT.fitted && AMBIENT.mux_channel != NO_MUX;
}

/// Number of channels the node produces.
constexpr uint8_t CHANNEL_COUNT = PRESSURE_COUNT + (AMBIENT.fitted ? 3 : 0) + POT_COUNT + LOAD_CELL_COUNT;

static_assert(CHANNEL_COUNT >= 1 && CHANNEL_COUNT <= 32, "a node has 1..32 channels");

}  // namespace node_config
