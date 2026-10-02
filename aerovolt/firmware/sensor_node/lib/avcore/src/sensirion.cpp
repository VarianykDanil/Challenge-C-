// avcore - Sensirion SDP3x / SDP8xx CRC and conversions. See sensirion.h.
#include "sensirion.h"

#include "av_math.h"

namespace av {

namespace {

uint16_t word_at(const uint8_t* p) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

}  // namespace

uint8_t sensirion_crc8(const uint8_t* data, size_t length) {
    // Bit-by-bit CRC: for each byte, XOR it into the register, then shift 8 times; whenever
    // a 1 falls out of the top, XOR the polynomial back in (polynomial long division).
    uint8_t crc = 0xFF;
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (uint8_t bit = 0; bit < 8; ++bit) {
            crc = (crc & 0x80u) ? static_cast<uint8_t>((crc << 1) ^ 0x31u)
                                : static_cast<uint8_t>(crc << 1);
        }
    }
    return crc;
}

bool sensirion_word_ok(const uint8_t* word) { return sensirion_crc8(word, 2) == word[2]; }

void sensirion_make_word(uint16_t value, uint8_t out[3]) {
    out[0] = static_cast<uint8_t>(value >> 8);
    out[1] = static_cast<uint8_t>(value & 0xFF);
    out[2] = sensirion_crc8(out, 2);
}

float sdp_dp_pa(int16_t dp_raw, uint16_t scale_factor) {
    if (scale_factor == 0) return kNaN;
    return static_cast<float>(dp_raw) / static_cast<float>(scale_factor);
}

SdpStatus sdp_parse_measurement(const uint8_t rx[kSdpMeasurementBytes], SdpMeasurement& out) {
    for (uint8_t w = 0; w < 3; ++w) {
        if (!sensirion_word_ok(rx + 3 * w)) return SdpStatus::kCrcError;
    }
    const uint16_t scale = word_at(rx + 6);
    if (scale == 0) return SdpStatus::kBadScale;
    const int16_t dp_raw = static_cast<int16_t>(word_at(rx));
    const int16_t t_raw = static_cast<int16_t>(word_at(rx + 3));
    out.dp_raw = dp_raw;
    out.scale_factor = scale;
    out.dp_pa = sdp_dp_pa(dp_raw, scale);
    out.temperature_c = static_cast<float>(t_raw) / kSdpTemperatureScale;
    // The sensor clips at the ends of the int16 range (INT16_MAX/MIN are not used: avr-libc
    // hides them from C++ unless __STDC_LIMIT_MACROS is defined).
    out.saturated = (dp_raw == 32767) || (dp_raw == -32768);
    return SdpStatus::kOk;
}

SdpStatus sdp_parse_product_id(const uint8_t rx[kSdpProductIdBytes], SdpProductId& out) {
    for (uint8_t w = 0; w < 6; ++w) {
        if (!sensirion_word_ok(rx + 3 * w)) return SdpStatus::kCrcError;
    }
    out.product_number = (static_cast<uint32_t>(word_at(rx)) << 16) | word_at(rx + 3);
    uint64_t serial = 0;
    for (uint8_t w = 2; w < 6; ++w) serial = (serial << 16) | word_at(rx + 3 * w);
    out.serial_number = serial;
    return SdpStatus::kOk;
}

const char* sdp_family(uint32_t product_number) {
    switch (product_number >> 16) {
        case 0x0301:
            return "SDP3x";
        case 0x0302:
            return "SDP8xx";
        default:
            return "SDP?";
    }
}

uint16_t sdp_range_pa(uint16_t scale_factor) {
    switch (scale_factor) {
        case 60:
            return 500;
        case 240:
            return 125;
        default:
            return 0;
    }
}

}  // namespace av
