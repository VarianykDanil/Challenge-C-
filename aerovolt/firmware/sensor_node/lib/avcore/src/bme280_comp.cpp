// avcore - Bosch BME280 compensation formulas (datasheet section 4.2.3, integer versions).
//
// The formulas are reproduced exactly as Bosch publishes them (same shifts, same order of
// operations) because the calibration constants were fitted for exactly this arithmetic.
// Right shifts of negative numbers are arithmetic on every compiler the firmware targets
// (GCC documents it), which the reference code also assumes. Bosch's LEFT shifts of
// possibly negative values are written as multiplications by the same power of two
// (identical result, but well-defined C++).
#include "bme280_comp.h"

#include "av_math.h"

namespace av {

namespace {

uint16_t u16_le(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (static_cast<uint16_t>(p[1]) << 8));
}

int16_t s16_le(const uint8_t* p) { return static_cast<int16_t>(u16_le(p)); }

}  // namespace

void bme280_parse_calib(const uint8_t tp[kBme280CalibTpBytes], const uint8_t* h, Bme280Calib& out) {
    out.T1 = u16_le(tp + 0);   // 0x88
    out.T2 = s16_le(tp + 2);   // 0x8A
    out.T3 = s16_le(tp + 4);   // 0x8C
    out.P1 = u16_le(tp + 6);   // 0x8E
    out.P2 = s16_le(tp + 8);
    out.P3 = s16_le(tp + 10);
    out.P4 = s16_le(tp + 12);
    out.P5 = s16_le(tp + 14);
    out.P6 = s16_le(tp + 16);
    out.P7 = s16_le(tp + 18);
    out.P8 = s16_le(tp + 20);
    out.P9 = s16_le(tp + 22);  // 0x9E
    out.H1 = tp[25];           // 0xA1 (0xA0 is reserved)
    if (h == nullptr) return;
    out.H2 = s16_le(h + 0);    // 0xE1/0xE2
    out.H3 = h[2];             // 0xE3
    // H4 = 0xE4[11:4] | 0xE5[3:0]; H5 = 0xE6[11:4] | 0xE5[7:4]; both signed 12-bit values
    // (the msb register is a signed byte, so the sign is carried by the multiplication).
    out.H4 = static_cast<int16_t>(static_cast<int16_t>(static_cast<int8_t>(h[3])) * 16 | (h[4] & 0x0F));
    out.H5 = static_cast<int16_t>(static_cast<int16_t>(static_cast<int8_t>(h[5])) * 16 | (h[4] >> 4));
    out.H6 = static_cast<int8_t>(h[6]);
}

Bme280Raw bme280_parse_data(const uint8_t d[kBme280DataBytes]) {
    Bme280Raw raw;
    raw.adc_P = (static_cast<int32_t>(d[0]) << 12) | (static_cast<int32_t>(d[1]) << 4) | (d[2] >> 4);
    raw.adc_T = (static_cast<int32_t>(d[3]) << 12) | (static_cast<int32_t>(d[4]) << 4) | (d[5] >> 4);
    raw.adc_H = (static_cast<int32_t>(d[6]) << 8) | d[7];
    return raw;
}

int32_t bme280_temperature_centi(const Bme280Calib& c, int32_t adc_T, int32_t& t_fine) {
    int32_t var1 = ((((adc_T >> 3) - (static_cast<int32_t>(c.T1) << 1))) * static_cast<int32_t>(c.T2)) >> 11;
    int32_t var2 = (((((adc_T >> 4) - static_cast<int32_t>(c.T1)) *
                      ((adc_T >> 4) - static_cast<int32_t>(c.T1))) >> 12) *
                    static_cast<int32_t>(c.T3)) >> 14;
    t_fine = var1 + var2;
    return (t_fine * 5 + 128) >> 8;
}

uint32_t bme280_pressure_q24_8(const Bme280Calib& c, int32_t adc_P, int32_t t_fine) {
    int64_t var1 = static_cast<int64_t>(t_fine) - 128000;
    int64_t var2 = var1 * var1 * static_cast<int64_t>(c.P6);
    var2 = var2 + ((var1 * static_cast<int64_t>(c.P5)) * 131072);       // << 17
    var2 = var2 + (static_cast<int64_t>(c.P4) * 34359738368LL);          // << 35
    var1 = ((var1 * var1 * static_cast<int64_t>(c.P3)) >> 8) + ((var1 * static_cast<int64_t>(c.P2)) * 4096);  // << 12
    var1 = ((static_cast<int64_t>(1) << 47) + var1) * static_cast<int64_t>(c.P1) >> 33;
    if (var1 == 0) return 0;  // avoid division by zero (P1 = 0: no calibration)
    int64_t p = 1048576 - adc_P;
    p = (((p * 2147483648LL) - var2) * 3125) / var1;                     // p << 31
    var1 = (static_cast<int64_t>(c.P9) * (p >> 13) * (p >> 13)) >> 25;
    var2 = (static_cast<int64_t>(c.P8) * p) >> 19;
    p = ((p + var1 + var2) >> 8) + (static_cast<int64_t>(c.P7) * 16);    // << 4
    return static_cast<uint32_t>(p);
}

uint32_t bme280_humidity_q22_10(const Bme280Calib& c, int32_t adc_H, int32_t t_fine) {
    int32_t v = t_fine - 76800;
    v = (((((adc_H << 14) - (static_cast<int32_t>(c.H4) * 1048576) - (static_cast<int32_t>(c.H5) * v)) + 16384) >> 15) *
         (((((((v * static_cast<int32_t>(c.H6)) >> 10) * (((v * static_cast<int32_t>(c.H3)) >> 11) + 32768)) >> 10) +
            2097152) * static_cast<int32_t>(c.H2) + 8192) >> 14));
    v = v - (((((v >> 15) * (v >> 15)) >> 7) * static_cast<int32_t>(c.H1)) >> 4);
    v = clamp<int32_t>(v, 0, 419430400);  // 0 .. 100 %RH
    return static_cast<uint32_t>(v >> 12);
}

Bme280Reading bme280_compensate(const Bme280Calib& c, const Bme280Raw& raw) {
    Bme280Reading out{kNaN, kNaN, kNaN};
    if (raw.adc_T == 0x80000) return out;  // without temperature nothing can be compensated
    int32_t t_fine = 0;
    out.temperature_c = static_cast<float>(bme280_temperature_centi(c, raw.adc_T, t_fine)) / 100.0f;
    if (raw.adc_P != 0x80000) {
        const uint32_t p = bme280_pressure_q24_8(c, raw.adc_P, t_fine);
        if (p != 0) out.pressure_pa = static_cast<float>(p) / 256.0f;
    }
    if (raw.adc_H != 0x8000) {
        out.humidity_pct = static_cast<float>(bme280_humidity_q22_10(c, raw.adc_H, t_fine)) / 1024.0f;
    }
    return out;
}

}  // namespace av
