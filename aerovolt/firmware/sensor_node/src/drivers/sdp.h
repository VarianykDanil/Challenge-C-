// Driver for Sensirion SDP3x / SDP8xx differential-pressure sensors (own implementation).
//
// Life of a sensor:
//   begin()  -> find it (fixed address or probe the usual ones), stop any running
//               measurement, read its product identifier (proves it is an SDP and gives
//               the model family), start continuous differential-pressure measurement
//               with "average till read" (command 0x3615).
//   read()   -> 9 bytes: dp, temperature, scale factor, each with a CRC (avcore decodes).
//
// The caller selects the right TCA9548A mux channel before calling begin()/read().
// The conversions and CRC live in lib/avcore/src/sensirion.h (unit tested on the host).
#pragma once

#include <stdint.h>

#include "sensirion.h"

class SdpSensor {
public:
    enum class Result : uint8_t {
        kOk,         // fresh measurement in the output
        kWarmingUp,  // started less than kWarmUpMs ago, no data yet (not an error)
        kNoAnswer,   // NACK: sensor missing, unpowered, wrong address or wrong mux channel
        kCrcError,   // corrupted transfer (noise, long wires, missing pull-ups)
        kBadData,    // CRC fine but scale factor 0: not an SDP sensor
    };

    /// Time the sensor needs after the start command before the first result, ms
    /// (datasheets: 8 ms SDP3x, 20 ms SDP8xx; with margin).
    static constexpr uint32_t kWarmUpMs = 25;

    /// `address`: fixed I2C address, or 0 to probe the usual SDP addresses.
    explicit SdpSensor(uint8_t address = 0) : configured_address_(address) {}

    /// Detect, identify and start continuous measurement. Blocks ~2 ms. True on success.
    bool begin(uint32_t now_ms);

    /// Read the latest averaged measurement.
    Result read(uint32_t now_ms, av::SdpMeasurement& out);

    /// Stop continuous measurement (lower power; required before reading the product id).
    bool stop();

    uint8_t address() const { return address_; }
    uint32_t product_number() const { return product_.product_number; }
    const char* family() const { return av::sdp_family(product_.product_number); }

    /// Soft-reset every SDP on the currently enabled bus segment(s): I2C general call 0x06.
    static void general_call_reset();

private:
    bool find_address();
    bool read_product_id();

    uint8_t configured_address_;
    uint8_t address_ = 0;
    av::SdpProductId product_{};
    uint32_t started_ms_ = 0;
};
