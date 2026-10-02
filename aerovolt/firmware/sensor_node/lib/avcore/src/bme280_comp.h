// avcore - Bosch BME280 compensation (ambient temperature, pressure, humidity).
//
// The BME280 does not output finished numbers: it outputs raw ADC values (20 bit for T and
// p, 16 bit for RH) plus a set of factory-trimmed calibration constants, and the host must
// run the compensation formulas from the Bosch datasheet (BST-BME280-DS002, section 4.2.3
// "Compensation formulas", 32/64-bit integer versions). They are implemented here exactly,
// with no library: temperature first, because its intermediate `t_fine` (fine-resolution
// temperature) feeds the pressure and humidity formulas - both sensing elements are
// temperature dependent.
//
// Register map used by the driver (datasheet section 5.3):
//   0x88..0xA1  calibration T1..T3, P1..P9, H1   (26 bytes, little-endian words)
//   0xE1..0xE7  calibration H2..H6                 (7 bytes, H4/H5 are 12-bit packed)
//   0xD0 chip id (0x60 BME280, 0x58 BMP280 = no humidity)   0xE0 reset (write 0xB6)
//   0xF2 ctrl_hum  0xF4 ctrl_meas  0xF5 config  0xF7..0xFE data (p, T, RH; 8 bytes)
#pragma once

#include <stdint.h>

namespace av {

constexpr uint8_t kBme280ChipId = 0x60;
constexpr uint8_t kBmp280ChipId = 0x58;  // same pressure/temperature part, no humidity
constexpr uint8_t kBme280CalibTpBytes = 26;  // 0x88..0xA1
constexpr uint8_t kBme280CalibHBytes = 7;    // 0xE1..0xE7
constexpr uint8_t kBme280DataBytes = 8;      // 0xF7..0xFE

/// Factory calibration constants ("trimming parameters", datasheet table 16).
struct Bme280Calib {
    uint16_t T1 = 0;
    int16_t T2 = 0, T3 = 0;
    uint16_t P1 = 0;
    int16_t P2 = 0, P3 = 0, P4 = 0, P5 = 0, P6 = 0, P7 = 0, P8 = 0, P9 = 0;
    uint8_t H1 = 0;
    int16_t H2 = 0;
    uint8_t H3 = 0;
    int16_t H4 = 0, H5 = 0;
    int8_t H6 = 0;
};

/// Raw ADC values of one measurement.
struct Bme280Raw {
    int32_t adc_T = 0;  // 20 bit; 0x80000 = temperature measurement skipped
    int32_t adc_P = 0;  // 20 bit; 0x80000 = pressure measurement skipped
    int32_t adc_H = 0;  // 16 bit; 0x8000 = humidity measurement skipped (or BMP280)
};

/// Compensated reading in SI-ish units; NaN for a skipped measurement.
struct Bme280Reading {
    float temperature_c;
    float pressure_pa;
    float humidity_pct;
};

/// Decode the calibration registers: `tp` = 26 bytes from 0x88, `h` = 7 bytes from 0xE1
/// (pass nullptr for a BMP280, which has no humidity calibration).
void bme280_parse_calib(const uint8_t tp[kBme280CalibTpBytes], const uint8_t* h, Bme280Calib& out);

/// Decode the 8 data bytes read from 0xF7 (press msb/lsb/xlsb, temp msb/lsb/xlsb, hum msb/lsb).
Bme280Raw bme280_parse_data(const uint8_t d[kBme280DataBytes]);

/// Temperature in 0.01 degC (5123 = 51.23 degC); also returns t_fine for the other two.
int32_t bme280_temperature_centi(const Bme280Calib& c, int32_t adc_T, int32_t& t_fine);

/// Pressure in Pa as unsigned Q24.8 (24674867 = 96386.2 Pa); 0 on a divide-by-zero guard.
uint32_t bme280_pressure_q24_8(const Bme280Calib& c, int32_t adc_P, int32_t t_fine);

/// Relative humidity in %RH as unsigned Q22.10 (47445 = 46.333 %RH).
uint32_t bme280_humidity_q22_10(const Bme280Calib& c, int32_t adc_H, int32_t t_fine);

/// All three, converted to float: degC, Pa (absolute), %RH.
Bme280Reading bme280_compensate(const Bme280Calib& c, const Bme280Raw& raw);

}  // namespace av
