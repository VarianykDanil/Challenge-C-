// Driver for the Bosch BME280 (temperature, pressure, humidity) - own implementation.
//
// Set-up used here (datasheet section 3.5 "weather monitoring" with more pressure
// oversampling): normal mode, oversampling T x1, p x4, RH x1, IIR filter x4, standby 500 ms
// - a fresh, smoothed reading about twice a second for the 1 Hz ambient channels.
// The compensation formulas are in lib/avcore/src/bme280_comp.h (unit tested).
// A BMP280 (same footprint, chip id 0x58) is accepted too: no humidity (amb_rh = NaN).
#pragma once

#include <stdint.h>

#include "bme280_comp.h"

class Bme280 {
public:
    explicit Bme280(uint8_t address = 0x76) : address_(address) {}

    /// Check the chip id, soft-reset, read the calibration, configure normal mode.
    bool begin();

    /// Burst-read the data registers and compensate. False if the sensor did not answer.
    bool read(av::Bme280Reading& out);

    bool has_humidity() const { return chip_id_ == av::kBme280ChipId; }
    uint8_t chip_id() const { return chip_id_; }

private:
    uint8_t address_;
    uint8_t chip_id_ = 0;
    av::Bme280Calib calib_{};
};
