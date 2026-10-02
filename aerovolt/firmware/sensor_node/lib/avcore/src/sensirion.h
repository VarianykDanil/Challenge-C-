// avcore - Sensirion SDP3x / SDP8xx differential pressure sensors: CRC and conversions.
//
// The SDP31/SDP32 (SDP3x, I2C address 0x21..0x23) and SDP810/SDP800 (SDP8xx, 0x25/0x26)
// measure the pressure difference between their two ports with a thermal (MEMS flow)
// principle, which gives a very stable zero and no drift - ideal for aero pressure taps.
//
// I2C protocol (datasheets "SDP3x" and "SDP8xx-Digital", section "Commands"):
//   * Every 16-bit word the sensor sends is followed by a CRC-8 byte.
//   * Continuous measurement, differential pressure, "average till read": command 0x3615.
//     The sensor samples internally (~2 kHz) and returns the average of all samples since
//     the last read - a free anti-aliasing filter for a 50 Hz read rate.
//   * A measurement read returns 9 bytes = 3 words + 3 CRCs:
//       [dp_hi dp_lo crc] [temp_hi temp_lo crc] [scale_hi scale_lo crc]
//     dp_raw and temp_raw are signed 16-bit;
//       differential pressure  dp  = dp_raw / scale_factor      [Pa]
//       temperature            T   = temp_raw / 200             [degC]
//     The scale factor is read from the sensor itself (60 /Pa for the 500 Pa parts, 240 /Pa
//     for the 125 Pa parts), so one driver supports every variant without a model table.
//   * Stop continuous mode: 0x3FF9.  Product identifier: 0x367C then 0xE102, then read
//     18 bytes = 6 words (product number = words 1-2, serial number = words 3-6).
//   * Soft reset: I2C general call (address 0x00) with the byte 0x06 - resets every device
//     on the bus segment that supports general call.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace av {

// ---- Commands and constants ------------------------------------------------------------
constexpr uint16_t kSdpCmdContinuousDpAverage = 0x3615;  // differential pressure, averaged
constexpr uint16_t kSdpCmdContinuousDpNone = 0x361E;     // differential pressure, no averaging
constexpr uint16_t kSdpCmdStopContinuous = 0x3FF9;
constexpr uint16_t kSdpCmdProductId1 = 0x367C;
constexpr uint16_t kSdpCmdProductId2 = 0xE102;
constexpr uint8_t kI2cGeneralCallAddress = 0x00;
constexpr uint8_t kSdpSoftResetByte = 0x06;
constexpr uint8_t kSdpMeasurementBytes = 9;
constexpr uint8_t kSdpProductIdBytes = 18;
constexpr float kSdpTemperatureScale = 200.0f;  // LSB per degC
/// Default I2C addresses: SDP31/32 = 0x21 (0x22, 0x23 on request), SDP8xx = 0x25 (SDP801 /
/// SDP811: 0x26).
constexpr uint8_t kSdpAddresses[] = {0x25, 0x21, 0x26, 0x22, 0x23};

/// Sensirion CRC-8: polynomial 0x31 (x^8 + x^5 + x^4 + 1), initial value 0xFF, no
/// reflection, no final XOR. Datasheet check value: crc8({0xBE, 0xEF}) == 0x92.
uint8_t sensirion_crc8(const uint8_t* data, size_t length);

/// True if the 2 data bytes at `word` are followed by their correct CRC byte.
bool sensirion_word_ok(const uint8_t* word);

/// Result of decoding a sensor response.
enum class SdpStatus : uint8_t {
    kOk,         // valid data
    kCrcError,   // a CRC did not match (electrical noise, loose wire, wrong address mux)
    kBadScale,   // scale factor 0: not an SDP sensor or a corrupted response
};

/// One decoded measurement.
struct SdpMeasurement {
    float dp_pa = 0.0f;           // differential pressure, Pa (port + minus port -)
    float temperature_c = 0.0f;   // sensor temperature, degC
    int16_t dp_raw = 0;
    uint16_t scale_factor = 0;    // LSB per Pa
    bool saturated = false;       // dp_raw at the int16 limit: true pressure is beyond range
};

/// Decode the 9-byte response of a measurement read. Every word's CRC is checked first;
/// `out` is only written when the result is kOk.
SdpStatus sdp_parse_measurement(const uint8_t rx[kSdpMeasurementBytes], SdpMeasurement& out);

/// dp [Pa] = dp_raw / scale_factor (0 scale -> NaN).
float sdp_dp_pa(int16_t dp_raw, uint16_t scale_factor);

/// Product number and serial number from the 18-byte product-identifier response.
struct SdpProductId {
    uint32_t product_number = 0;
    uint64_t serial_number = 0;
};

/// Decode the product-identifier response (CRC per word).
SdpStatus sdp_parse_product_id(const uint8_t rx[kSdpProductIdBytes], SdpProductId& out);

/// "SDP3x" (product number 0x0301xxxx), "SDP8xx" (0x0302xxxx) or "SDP?" (unknown).
const char* sdp_family(uint32_t product_number);

/// Full-scale range of a variant from its scale factor: 60 /Pa -> 500 Pa, 240 /Pa ->
/// 125 Pa (0 if unknown).
uint16_t sdp_range_pa(uint16_t scale_factor);

/// Build the 3-byte word "hi lo crc" a sensor would send (used by tests and the host
/// sensor emulator).
void sensirion_make_word(uint16_t value, uint8_t out[3]);

}  // namespace av
