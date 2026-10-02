// Host tests: Sensirion CRC + SDP conversion, BME280 compensation, pot / HX711 calibration.
#include <cmath>
#include <cstring>
#include <string>

#include "bme280_comp.h"
#include "calibration.h"
#include "check.h"
#include "sensirion.h"

namespace {

/// Build a 9-byte SDP measurement response.
void sdp_response(int16_t dp_raw, int16_t t_raw, uint16_t scale, uint8_t out[9]) {
    av::sensirion_make_word(static_cast<uint16_t>(dp_raw), out);
    av::sensirion_make_word(static_cast<uint16_t>(t_raw), out + 3);
    av::sensirion_make_word(scale, out + 6);
}

// BME280 datasheet floating-point compensation (section 8.1, "double precision"), used as
// an independent reference for the integer implementation.
struct FloatBme {
    double t_fine;
    double temperature(const av::Bme280Calib& c, double adc_T) {
        const double v1 = (adc_T / 16384.0 - c.T1 / 1024.0) * c.T2;
        const double v2 = (adc_T / 131072.0 - c.T1 / 8192.0) * (adc_T / 131072.0 - c.T1 / 8192.0) * c.T3;
        t_fine = v1 + v2;
        return t_fine / 5120.0;
    }
    double pressure(const av::Bme280Calib& c, double adc_P) const {
        double v1 = t_fine / 2.0 - 64000.0;
        double v2 = v1 * v1 * c.P6 / 32768.0;
        v2 = v2 + v1 * c.P5 * 2.0;
        v2 = v2 / 4.0 + c.P4 * 65536.0;
        v1 = (c.P3 * v1 * v1 / 524288.0 + c.P2 * v1) / 524288.0;
        v1 = (1.0 + v1 / 32768.0) * c.P1;
        double p = 1048576.0 - adc_P;
        p = (p - v2 / 4096.0) * 6250.0 / v1;
        v1 = c.P9 * p * p / 2147483648.0;
        v2 = p * c.P8 / 32768.0;
        return p + (v1 + v2 + c.P7) / 16.0;
    }
    double humidity(const av::Bme280Calib& c, double adc_H) const {
        double h = t_fine - 76800.0;
        h = (adc_H - (c.H4 * 64.0 + c.H5 / 16384.0 * h)) *
            (c.H2 / 65536.0 * (1.0 + c.H6 / 67108864.0 * h * (1.0 + c.H3 / 67108864.0 * h)));
        h = h * (1.0 - c.H1 * h / 524288.0);
        return h < 0 ? 0 : (h > 100 ? 100 : h);
    }
};

/// Calibration of the Bosch datasheet example (BMP280 datasheet section 3.12) plus typical
/// humidity constants of a real BME280.
av::Bme280Calib example_calib() {
    av::Bme280Calib c;
    c.T1 = 27504; c.T2 = 26435; c.T3 = -1000;
    c.P1 = 36477; c.P2 = -10685; c.P3 = 3024; c.P4 = 2855; c.P5 = 140; c.P6 = -7;
    c.P7 = 15500; c.P8 = -14600; c.P9 = 6000;
    c.H1 = 75; c.H2 = 362; c.H3 = 0; c.H4 = 313; c.H5 = 50; c.H6 = 30;
    return c;
}

}  // namespace

TEST(sensirion_crc_vectors) {
    const uint8_t beef[2] = {0xBE, 0xEF};
    CHECK_EQ(av::sensirion_crc8(beef, 2), 0x92);  // datasheet check value
    const uint8_t zero[2] = {0x00, 0x00};
    CHECK_EQ(av::sensirion_crc8(zero, 2), 0x81);
    uint8_t w[3];
    av::sensirion_make_word(0xBEEF, w);
    CHECK(av::sensirion_word_ok(w));
    w[1] ^= 0x01;  // one flipped bit is always detected
    CHECK(!av::sensirion_word_ok(w));
}

TEST(sdp_measurement_conversion) {
    uint8_t rx[9];
    sdp_response(-24750, 5100, 60, rx);  // -412.5 Pa at 60 /Pa, 25.5 degC
    av::SdpMeasurement m;
    CHECK(av::sdp_parse_measurement(rx, m) == av::SdpStatus::kOk);
    CHECK_NEAR(m.dp_pa, -412.5, 1e-4);
    CHECK_NEAR(m.temperature_c, 25.5, 1e-4);
    CHECK_EQ(m.scale_factor, 60);
    CHECK(!m.saturated);
    CHECK_EQ(av::sdp_range_pa(m.scale_factor), 500);

    sdp_response(1000, -200, 240, rx);  // 125 Pa part: 1000 / 240 Pa, -1 degC
    CHECK(av::sdp_parse_measurement(rx, m) == av::SdpStatus::kOk);
    CHECK_NEAR(m.dp_pa, 1000.0 / 240.0, 1e-5);
    CHECK_NEAR(m.temperature_c, -1.0, 1e-6);
    CHECK_EQ(av::sdp_range_pa(240), 125);

    sdp_response(32767, 5000, 60, rx);
    CHECK(av::sdp_parse_measurement(rx, m) == av::SdpStatus::kOk);
    CHECK(m.saturated);

    for (int corrupt : {1, 4, 7}) {  // a bad CRC in any of the three words is rejected
        sdp_response(-24750, 5100, 60, rx);
        rx[corrupt] ^= 0x10;
        av::SdpMeasurement untouched;
        untouched.dp_pa = 123.0f;
        CHECK(av::sdp_parse_measurement(rx, untouched) == av::SdpStatus::kCrcError);
        CHECK_NEAR(untouched.dp_pa, 123.0, 0);
    }
    sdp_response(100, 100, 0, rx);
    CHECK(av::sdp_parse_measurement(rx, m) == av::SdpStatus::kBadScale);
    CHECK(std::isnan(av::sdp_dp_pa(10, 0)));
}

TEST(sdp_product_id) {
    uint8_t rx[18];
    const uint16_t words[6] = {0x0302, 0x0A01, 0x0000, 0x0001, 0x2345, 0x6789};
    for (int i = 0; i < 6; ++i) av::sensirion_make_word(words[i], rx + 3 * i);
    av::SdpProductId id;
    CHECK(av::sdp_parse_product_id(rx, id) == av::SdpStatus::kOk);
    CHECK_EQ(id.product_number, 0x03020A01u);
    CHECK(id.serial_number == 0x0000000123456789ull);
    CHECK_STR(std::string(av::sdp_family(id.product_number)), "SDP8xx");
    CHECK_STR(std::string(av::sdp_family(0x03010188u)), "SDP3x");
    CHECK_STR(std::string(av::sdp_family(0x12345678u)), "SDP?");
    rx[16] ^= 0xFF;
    CHECK(av::sdp_parse_product_id(rx, id) == av::SdpStatus::kCrcError);
}

TEST(bme280_datasheet_example) {
    const av::Bme280Calib c = example_calib();
    int32_t t_fine = 0;
    CHECK_EQ(av::bme280_temperature_centi(c, 519888, t_fine), 2508);  // 25.08 degC
    CHECK_EQ(t_fine, 128422);
    const double p = av::bme280_pressure_q24_8(c, 415148, t_fine) / 256.0;
    CHECK_NEAR(p, 100653.27, 0.1);  // datasheet: 100653.27 Pa
}

TEST(bme280_integer_matches_float_reference) {
    const av::Bme280Calib c = example_calib();
    FloatBme ref{};
    for (int32_t adc_T = 480000; adc_T <= 560000; adc_T += 8000) {
        int32_t t_fine = 0;
        const double t = av::bme280_temperature_centi(c, adc_T, t_fine) / 100.0;
        CHECK_NEAR(t, ref.temperature(c, adc_T), 0.011);
        for (int32_t adc_P = 300000; adc_P <= 450000; adc_P += 30000) {
            const double p = av::bme280_pressure_q24_8(c, adc_P, t_fine) / 256.0;
            CHECK_NEAR(p, ref.pressure(c, adc_P), 0.5);
        }
        for (int32_t adc_H = 20000; adc_H <= 40000; adc_H += 4000) {
            const double h = av::bme280_humidity_q22_10(c, adc_H, t_fine) / 1024.0;
            CHECK_NEAR(h, ref.humidity(c, adc_H), 0.05);
        }
    }
}

TEST(bme280_register_parsing) {
    const av::Bme280Calib want = example_calib();
    uint8_t tp[26] = {};
    auto put16 = [&](int off, int v) {
        tp[off] = static_cast<uint8_t>(v & 0xFF);
        tp[off + 1] = static_cast<uint8_t>((v >> 8) & 0xFF);
    };
    put16(0, want.T1); put16(2, want.T2); put16(4, want.T3);
    put16(6, want.P1); put16(8, want.P2); put16(10, want.P3); put16(12, want.P4);
    put16(14, want.P5); put16(16, want.P6); put16(18, want.P7); put16(20, want.P8); put16(22, want.P9);
    tp[25] = want.H1;
    // H4 = -100 and H5 = -3 exercise the signed 12-bit packing of 0xE4..0xE6.
    const int16_t h4 = -100, h5 = -3;
    const uint8_t h[7] = {static_cast<uint8_t>(want.H2 & 0xFF), static_cast<uint8_t>(want.H2 >> 8), want.H3,
                          static_cast<uint8_t>((h4 >> 4) & 0xFF),
                          static_cast<uint8_t>(((h5 & 0x0F) << 4) | (h4 & 0x0F)),
                          static_cast<uint8_t>((h5 >> 4) & 0xFF), static_cast<uint8_t>(want.H6)};
    av::Bme280Calib got;
    av::bme280_parse_calib(tp, h, got);
    CHECK_EQ(got.T1, want.T1); CHECK_EQ(got.T2, want.T2); CHECK_EQ(got.T3, want.T3);
    CHECK_EQ(got.P1, want.P1); CHECK_EQ(got.P2, want.P2); CHECK_EQ(got.P6, want.P6); CHECK_EQ(got.P9, want.P9);
    CHECK_EQ(got.H1, want.H1); CHECK_EQ(got.H2, want.H2); CHECK_EQ(got.H3, want.H3);
    CHECK_EQ(got.H4, h4); CHECK_EQ(got.H5, h5); CHECK_EQ(got.H6, want.H6);

    const uint8_t data[8] = {0x65, 0x5A, 0xC0, 0x7E, 0xED, 0x00, 0x75, 0x30};
    const av::Bme280Raw raw = av::bme280_parse_data(data);
    CHECK_EQ(raw.adc_P, 415148);  // 0x655AC
    CHECK_EQ(raw.adc_T, 519888);  // 0x7EED0
    CHECK_EQ(raw.adc_H, 30000);
    const av::Bme280Reading r = av::bme280_compensate(want, raw);
    CHECK_NEAR(r.temperature_c, 25.08, 1e-4);
    CHECK_NEAR(r.pressure_pa, 100653.27, 0.1);
    CHECK(r.humidity_pct > 0.0f && r.humidity_pct < 100.0f);

    av::Bme280Raw skipped = raw;
    skipped.adc_H = 0x8000;  // BMP280 / humidity disabled
    CHECK(std::isnan(av::bme280_compensate(want, skipped).humidity_pct));
    skipped.adc_T = 0x80000;
    CHECK(std::isnan(av::bme280_compensate(want, skipped).temperature_c));
}

TEST(linear_pot_calibration) {
    // 75 mm pot on a 12-bit ADC: 410 counts at -20 mm (droop), 3686 counts at +40 mm.
    const av::LinearPotCal cal = av::linear_pot_two_point(410.0f, -20.0f, 3686.0f, 40.0f, 100, 4000);
    CHECK_NEAR(av::linear_pot_mm(cal, 410), -20.0, 1e-3);
    CHECK_NEAR(av::linear_pot_mm(cal, 3686), 40.0, 1e-3);
    CHECK_NEAR(av::linear_pot_mm(cal, 1502), 0.0, 0.02);  // the reference (static) position
    CHECK(std::isnan(av::linear_pot_mm(cal, 50)));        // broken wire -> pulled to 0 V
    CHECK(std::isnan(av::linear_pot_mm(cal, 4090)));      // short to supply
    const av::LinearPotCal flat = av::linear_pot_two_point(100.0f, 0.0f, 100.0f, 10.0f, 0, 4095);
    CHECK_NEAR(av::linear_pot_mm(flat, 2000), 0.0, 0);
}

TEST(hx711_calibration) {
    CHECK_EQ(av::hx711_sign_extend(0x000001), 1);
    CHECK_EQ(av::hx711_sign_extend(0xFFFFFF), -1);
    CHECK_EQ(av::hx711_sign_extend(0x800000), -8388608);
    CHECK_EQ(av::hx711_sign_extend(0x7FFFFF), 8388607);
    // 2 kg reference mass gives +42000 counts above the tare.
    const float npc = av::hx711_scale_from_reference(-1500, 40500, 2.0f);
    CHECK_NEAR(npc, 2.0 * 9.80665 / 42000.0, 1e-9);
    const av::Hx711Cal cal{-1500, npc};
    CHECK_NEAR(av::hx711_newtons(cal, 40500), 19.6133, 1e-3);
    CHECK_NEAR(av::hx711_newtons(cal, -1500), 0.0, 1e-6);
    CHECK(std::isnan(av::hx711_newtons(cal, av::kHx711Max)));
    CHECK(std::isnan(av::hx711_newtons(cal, av::kHx711Min)));
    CHECK(std::isnan(av::hx711_scale_from_reference(5, 5, 1.0f)));
}
