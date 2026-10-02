// Host tests: CAN packing/unpacking, rounding, saturation and SNA (lib/avcore/src/can_codec).
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <random>
#include <string>

#include "av_math.h"
#include "can_codec.h"
#include "check.h"

namespace can = aerovolt::can;

namespace {

std::string hex(const uint8_t d[8]) {
    char buf[17];
    for (int i = 0; i < 8; ++i) std::snprintf(buf + 2 * i, 3, "%02X", d[i]);
    return buf;
}

const can::MessageDef& msg(const char* name) {
    const can::MessageDef* m = can::find_message_by_name(name);
    if (m == nullptr) std::abort();
    return *m;
}

const can::SignalDef& sig(const char* channel) {
    const can::SignalRef ref = can::find_channel(channel);
    if (ref.signal == nullptr) std::abort();
    return *ref.signal;
}

}  // namespace

TEST(round_half_even_matches_nearbyint) {
    CHECK_EQ(av::round_half_even(2.5), 2.0);
    CHECK_EQ(av::round_half_even(3.5), 4.0);
    CHECK_EQ(av::round_half_even(-2.5), -2.0);
    CHECK_EQ(av::round_half_even(-3.5), -4.0);
    CHECK_EQ(av::round_half_even(0.5), 0.0);
    CHECK_EQ(av::round_half_even(-0.5), 0.0);
    CHECK_EQ(av::round_half_even(2.4999999), 2.0);
    CHECK_EQ(av::round_half_even(2.5000001), 3.0);
    CHECK_EQ(av::round_half_even(0.49999999999999994), 0.0);
    CHECK_EQ(av::round_half_even(-0.49999999999999994), 0.0);
    CHECK_EQ(av::round_half_even(4503599627370495.5), 4503599627370496.0);
    CHECK(std::isnan(av::round_half_even(NAN)));
    // A million random values across many magnitudes, half of them exact ties.
    std::mt19937_64 rng(1234);
    std::uniform_real_distribution<double> u(-1.0, 1.0);
    std::uniform_int_distribution<int> e(-30, 40);
    std::uniform_int_distribution<long long> k(-100000000LL, 100000000LL);
    int mismatches = 0;
    for (int i = 0; i < 1000000; ++i) {
        const double x = (i % 2 == 0) ? std::ldexp(u(rng), e(rng)) : static_cast<double>(k(rng)) + 0.5;
        if (av::round_half_even(x) != std::nearbyint(x)) ++mismatches;
    }
    CHECK_EQ(mismatches, 0);
}

TEST(bit_fields_intel_order) {
    uint8_t d[8] = {};
    // 13-bit field starting at bit 3 crosses a byte boundary.
    CHECK(av::insert_bits(d, 3, 13, 0x1ABC));
    CHECK_EQ(av::extract_bits(d, 3, 13), 0x1ABCu);
    CHECK_EQ(d[0], uint8_t((0x1ABC << 3) & 0xFF));
    CHECK_EQ(d[1], uint8_t((0x1ABC << 3) >> 8));
    // Writing a field leaves its neighbours alone.
    uint8_t e[8];
    std::memset(e, 0xFF, 8);
    av::insert_bits(e, 20, 7, 0);
    CHECK_EQ(av::extract_bits(e, 20, 7), 0u);
    CHECK_EQ(av::extract_bits(e, 13, 7), 0x7Fu);
    CHECK_EQ(av::extract_bits(e, 27, 32), 0xFFFFFFFFu);
    // A 32-bit field at the very end of the frame, and one that does not fit.
    CHECK(av::insert_bits(d, 32, 32, 0xDEADBEEF));
    CHECK_EQ(d[4], 0xEF);
    CHECK_EQ(d[7], 0xDE);
    CHECK(!av::insert_bits(d, 40, 32, 1));
    CHECK(!av::insert_bits(d, 0, 0, 1));
    // Random round trips for every start bit and length.
    std::mt19937 rng(7);
    for (uint8_t len = 1; len <= 32; ++len) {
        for (uint8_t start = 0; start + len <= 64; ++start) {
            uint8_t f[8];
            for (auto& b : f) b = static_cast<uint8_t>(rng());
            const uint32_t mask = len == 32 ? 0xFFFFFFFFu : ((1u << len) - 1u);
            const uint32_t value = static_cast<uint32_t>(rng()) & mask;
            uint8_t before[8];
            std::memcpy(before, f, 8);
            av::insert_bits(f, start, len, value);
            if (av::extract_bits(f, start, len) != value) CHECK(false);
            for (int bit = 0; bit < 64; ++bit) {  // bits outside the field unchanged
                if (bit >= start && bit < start + len) continue;
                if (((f[bit / 8] ^ before[bit / 8]) >> (bit % 8)) & 1) CHECK(false);
            }
        }
    }
}

TEST(sign_extension) {
    CHECK_EQ(av::sign_extend(0x8000, 16), -32768);
    CHECK_EQ(av::sign_extend(0x7FFF, 16), 32767);
    CHECK_EQ(av::sign_extend(0xFFFF, 16), -1);
    CHECK_EQ(av::sign_extend(0x1F, 5), -1);
    CHECK_EQ(av::sign_extend(0x0F, 5), 15);
    CHECK_EQ(av::sign_extend(0x80000000u, 32), INT32_MIN);
    CHECK_EQ(av::sign_extend(1, 1), -1);
}

TEST(physical_to_raw_rounding_and_saturation) {
    const auto& tap = sig("fw_p03");      // i16, 0.1 Pa
    CHECK_EQ(av::physical_to_raw(tap, -412.5), -4125);
    CHECK_EQ(av::physical_to_raw(tap, -412.54), -4125);
    CHECK_EQ(av::physical_to_raw(tap, -412.56), -4126);
    CHECK_EQ(av::physical_to_raw(tap, 1e6), 32767);        // saturates high
    CHECK_EQ(av::physical_to_raw(tap, -1e6), -32767);      // saturates low, NOT the SNA code
    CHECK_EQ(av::physical_to_raw(tap, -3276.8), -32767);
    CHECK_EQ(av::physical_to_raw(tap, NAN), -32768);       // NaN -> SNA
    CHECK_EQ(av::physical_to_raw(tap, INFINITY), -32768);
    const auto& load = sig("fw_load");    // i16, 1 N: exact ties round to even
    CHECK_EQ(av::physical_to_raw(load, 12.5), 12);
    CHECK_EQ(av::physical_to_raw(load, 13.5), 14);
    CHECK_EQ(av::physical_to_raw(load, -12.5), -12);
    const auto& rh = sig("amb_rh");       // u8, 0.5 %
    CHECK_EQ(av::physical_to_raw(rh, 46.3), 93);
    CHECK_EQ(av::physical_to_raw(rh, 200.0), 254);         // 255 is SNA
    CHECK_EQ(av::physical_to_raw(rh, -5.0), 0);
    CHECK_EQ(av::physical_to_raw(rh, NAN), 255);
    const auto& press = sig("amb_press"); // u16, 1 Pa, offset 50000
    CHECK_EQ(av::physical_to_raw(press, 101325.0), 51325);
    CHECK_EQ(av::physical_to_raw(press, 101325.5), 51326); // 51325.5 -> even 51326
    CHECK_EQ(av::physical_to_raw(press, 40000.0), 0);
    const auto& lat = sig("gps_lat");     // i32, 1e-7 deg
    CHECK_EQ(av::physical_to_raw(lat, 52.0786), 520786000);
    CHECK_EQ(av::physical_to_raw(lat, -1.0169), -10169000);
    CHECK_EQ(av::physical_to_raw(lat, NAN), INT32_MIN);
    const auto& flag = sig("sdc_closed"); // 1-bit flag: no SNA
    CHECK_EQ(av::physical_to_raw(flag, 1.0), 1);
    CHECK_EQ(av::physical_to_raw(flag, 0.0), 0);
    CHECK_EQ(av::physical_to_raw(flag, 7.0), 1);
    CHECK_EQ(av::physical_to_raw(flag, NAN), 0);
    const auto& temp = sig("cell_t_00");  // u8, 0.5 degC, offset -20
    CHECK_EQ(av::physical_to_raw(temp, 25.0), 90);
    CHECK_EQ(av::physical_to_raw(temp, -30.0), 0);
}

TEST(raw_to_physical_and_sna) {
    const auto& tap = sig("fw_p03");
    CHECK_NEAR(av::raw_to_physical(tap, -4125), -412.5, 1e-9);
    CHECK(std::isnan(av::raw_to_physical(tap, -32768)));
    const auto& press = sig("amb_press");
    CHECK_NEAR(av::raw_to_physical(press, 51325), 101325.0, 1e-9);
    CHECK(std::isnan(av::raw_to_physical(press, 65535)));
    const auto& flag = sig("imd_ok");
    CHECK_NEAR(av::raw_to_physical(flag, 1), 1.0, 0);  // all-ones is a value, not SNA
}

TEST(fill_sna_patterns) {
    uint8_t d[8];
    av::fill_sna(msg("AERO_FW_TAPS_A"), d);
    CHECK_STR(hex(d), "0080008000800080");
    av::fill_sna(msg("AERO_AIR"), d);
    CHECK_STR(hex(d), "00800080FFFFFF00");  // i16, i16, u16, u8, unused byte = 0
    av::fill_sna(msg("SAFETY"), d);
    CHECK_STR(hex(d), "00FFFFFF00000000");  // flags 0, tsal_state SNA, imd_iso SNA
    av::fill_sna(msg("GPS_POS"), d);
    CHECK_STR(hex(d), "0000008000000080");
}

TEST(set_channel_partial_frame) {
    // The Phase-2 bench node owns only fw_p03: the other taps of the frame stay SNA.
    uint8_t d[8];
    const auto& m = msg("AERO_FW_TAPS_A");
    av::fill_sna(m, d);
    CHECK(av::set_channel(m, "fw_p03", -412.5, d));  // -4125 = 0xEFE3
    CHECK_STR(hex(d), "00800080E3EF0080");
    CHECK(!av::set_channel(m, "rw_p01", 1.0, d));
    CHECK(std::isnan(av::decode_signal(*can::find_signal(m, "fw_p01"), d)));
    CHECK_NEAR(av::decode_signal(*can::find_signal(m, "fw_p03"), d), -412.5, 1e-9);
}

TEST(every_signal_round_trips) {
    std::mt19937_64 rng(99);
    int checked = 0;
    for (size_t mi = 0; mi < can::MESSAGE_COUNT; ++mi) {
        const auto& m = can::MESSAGES[mi];
        CHECK_EQ(m.dlc, 8);
        for (uint8_t si = 0; si < m.signal_count; ++si) {
            const auto& s = m.signals[si];
            for (int rep = 0; rep < 50; ++rep) {
                const int64_t lo = can::raw_min(s), hi = can::raw_max(s);
                const int64_t raw = lo + static_cast<int64_t>(rng() % static_cast<uint64_t>(hi - lo + 1));
                const double physical = static_cast<double>(raw) * s.scale + s.offset;
                uint8_t d[8];
                av::fill_sna(m, d);
                av::encode_signal(s, physical, d);
                const double back = av::decode_signal(s, d);
                if (std::fabs(back - physical) > 1e-9 * (1.0 + std::fabs(physical))) CHECK(false);
                if (av::physical_to_raw(s, physical) != raw) CHECK(false);
                // The other signals of the frame are still SNA (or 0 for flags).
                for (uint8_t oi = 0; oi < m.signal_count; ++oi) {
                    if (oi == si) continue;
                    const auto& o = m.signals[oi];
                    const double v = av::decode_signal(o, d);
                    if (o.has_sna ? !std::isnan(v) : v != 0.0) CHECK(false);
                }
                ++checked;
            }
        }
    }
    CHECK_EQ(checked, static_cast<int>(can::SIGNAL_COUNT) * 50);
}
