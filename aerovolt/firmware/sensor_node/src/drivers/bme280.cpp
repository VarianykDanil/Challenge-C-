// Driver for the Bosch BME280. See bme280.h.
#include "bme280.h"

#include <Arduino.h>

#include "i2c.h"

namespace {
constexpr uint8_t REG_CALIB_TP = 0x88;
constexpr uint8_t REG_CHIP_ID = 0xD0;
constexpr uint8_t REG_RESET = 0xE0;
constexpr uint8_t REG_CALIB_H = 0xE1;
constexpr uint8_t REG_CTRL_HUM = 0xF2;
constexpr uint8_t REG_STATUS = 0xF3;
constexpr uint8_t REG_CTRL_MEAS = 0xF4;
constexpr uint8_t REG_CONFIG = 0xF5;
constexpr uint8_t REG_DATA = 0xF7;
constexpr uint8_t RESET_WORD = 0xB6;
constexpr uint8_t STATUS_IM_UPDATE = 0x01;  // NVM calibration still being copied

// ctrl_hum: osrs_h = 001 (x1). Only takes effect after the next ctrl_meas write.
constexpr uint8_t CTRL_HUM = 0x01;
// config: t_sb = 100 (500 ms standby), filter = 010 (coefficient 4), spi3w_en = 0.
constexpr uint8_t CONFIG = (0x4 << 5) | (0x2 << 2);
// ctrl_meas: osrs_t = 001 (x1), osrs_p = 011 (x4), mode = 11 (normal).
constexpr uint8_t CTRL_MEAS = (0x1 << 5) | (0x3 << 2) | 0x3;
}  // namespace

bool Bme280::begin() {
    chip_id_ = 0;
    uint8_t id = 0;
    if (!i2c::read_registers(address_, REG_CHIP_ID, &id, 1)) return false;
    if (id != av::kBme280ChipId && id != av::kBmp280ChipId) return false;
    if (!i2c::write_register(address_, REG_RESET, RESET_WORD)) return false;
    delay(3);  // start-up time after reset: 2 ms
    for (uint8_t tries = 0; tries < 10; ++tries) {  // wait until the NVM copy has finished
        uint8_t status = 0;
        if (i2c::read_registers(address_, REG_STATUS, &status, 1) && !(status & STATUS_IM_UPDATE)) break;
        delay(1);
    }
    uint8_t tp[av::kBme280CalibTpBytes];
    uint8_t h[av::kBme280CalibHBytes];
    if (!i2c::read_registers(address_, REG_CALIB_TP, tp, sizeof tp)) return false;
    const bool humidity = id == av::kBme280ChipId;
    if (humidity && !i2c::read_registers(address_, REG_CALIB_H, h, sizeof h)) return false;
    av::bme280_parse_calib(tp, humidity ? h : nullptr, calib_);
    if (humidity && !i2c::write_register(address_, REG_CTRL_HUM, CTRL_HUM)) return false;
    if (!i2c::write_register(address_, REG_CONFIG, CONFIG)) return false;
    if (!i2c::write_register(address_, REG_CTRL_MEAS, CTRL_MEAS)) return false;
    chip_id_ = id;
    return true;
}

bool Bme280::read(av::Bme280Reading& out) {
    if (chip_id_ == 0) return false;
    uint8_t d[av::kBme280DataBytes];
    // One burst read of all data registers: T, p and RH come from the same conversion.
    if (!i2c::read_registers(address_, REG_DATA, d, sizeof d)) return false;
    av::Bme280Raw raw = av::bme280_parse_data(d);
    if (!has_humidity()) raw.adc_H = 0x8000;  // BMP280: the "humidity" bytes do not exist
    out = av::bme280_compensate(calib_, raw);
    return true;
}
