// firmware_sim_<profile> - runs the REAL firmware (src/) on the PC against emulated sensors.
//
//   firmware_sim_bench --self-test                 run the built-in scenario and check it
//   firmware_sim_front --seconds 12 --serial-out serial.txt --can-out can.txt
//                      [--disconnect fw_p03@3:6] [--crc-noise fw_p01@2:4]
//
// The emulated board is built from include/node_config.h, exactly like the real one: one
// SDP per pressure-table row (at its mux channel and address), a BME280, the pots and the
// HX711s. Every pressure sensor sees a known, slowly varying pressure, so the outputs can be
// checked against the truth: tests/test_firmware_node_sim.py parses the serial capture with
// aerovolt.sources.protocol and decodes the CAN capture with the DBC.
//
// Capture formats: --serial-out is the raw byte stream; --can-out has one frame per line,
// "<t_us> <id hex> <16 hex digits>".
#include <Arduino.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "aerovolt_can.h"
#include "av_line.h"
#include "bme280_comp.h"
#include "calibration.h"
#include "can_codec.h"
#include "node_config.h"
#include "sensirion.h"
#include "sim_world.h"

void setup();
void loop();

namespace {

using namespace node_config;
constexpr double kPi = 3.14159265358979323846;

/// The "true" pressure at channel `id` (Pa) at time t (s): taps get a distinct suction
/// level each, the pitot a dynamic pressure, all with a slow 0.25 Hz variation.
double true_pressure(const std::string& id, double t) {
    if (id == "pitot_dp") return 350.0 + 20.0 * std::sin(2 * kPi * 0.25 * t);
    const int n = std::atoi(id.c_str() + id.size() - 2);  // fw_p03 -> 3
    return -55.0 * n + 25.0 * std::sin(2 * kPi * 0.25 * t + n);
}

/// Counts the emulated pots and load cell report.
constexpr int kPotOffsetCounts = 300;
constexpr int32_t kLoadCounts = 100000;

struct Window {
    std::string channel;
    double from_s, to_s;
};

struct Options {
    double seconds = 12.0;
    std::string serial_out, can_out;
    bool self_test = false;
    std::vector<Window> disconnects, crc_noise;
};

bool parse_window(const char* text, Window& w) {
    const char* at = std::strchr(text, '@');
    const char* colon = at ? std::strchr(at, ':') : nullptr;
    if (!at || !colon) return false;
    w.channel.assign(text, at);
    w.from_s = std::atof(at + 1);
    w.to_s = std::atof(colon + 1);
    return true;
}

std::map<std::string, std::shared_ptr<sim::FakeSdp>> g_sdps;

void build_world() {
    sim::World& w = sim::world();
    if (uses_mux()) w.mux = std::make_shared<sim::FakeMux>();
    w.mux_address = TCA9548A_ADDRESS;
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) {
        const PressureSensorConfig& cfg = PRESSURE_SENSORS[i];
        const std::string id = cfg.channel;
        const uint8_t address = cfg.i2c_address == SDP_AUTO_ADDRESS ? 0x25 : cfg.i2c_address;
        const uint32_t product = address == 0x21 ? 0x03010188u : 0x03020A01u;  // SDP31 / SDP810
        auto sdp = std::make_shared<sim::FakeSdp>(product, 60, [id](double t) { return true_pressure(id, t); });
        g_sdps[id] = sdp;
        if (cfg.mux_channel == NO_MUX) {
            w.main_bus[address] = sdp;
        } else {
            w.mux_bus[cfg.mux_channel][address] = sdp;
        }
    }
    if (AMBIENT.fitted) {
        auto bme = std::make_shared<sim::FakeBme280>();
        if (AMBIENT.mux_channel == NO_MUX) {
            w.main_bus[AMBIENT.i2c_address] = bme;
        } else {
            w.mux_bus[AMBIENT.mux_channel][AMBIENT.i2c_address] = bme;
        }
    }
    for (uint8_t i = 0; i < POT_COUNT; ++i) w.analog[POTS[i].pin] = ADC_MAX / 2 + kPotOffsetCounts;
    for (uint8_t i = 0; i < LOAD_CELL_COUNT; ++i) {
        sim::FakeHx711 h;
        h.dout_pin = LOAD_CELLS[i].dout_pin;
        h.sck_pin = LOAD_CELLS[i].sck_pin;
        h.counts = LOAD_CELLS[i].cal.tare_counts + kLoadCounts;
        w.hx711.push_back(h);
    }
}

void apply_windows(const Options& opt, double t) {
    for (const Window& win : opt.disconnects) {
        auto it = g_sdps.find(win.channel);
        if (it == g_sdps.end()) continue;
        const bool want = !(t >= win.from_s && t < win.to_s);
        if (it->second->connected != want) {
            it->second->connected = want;
            if (want) it->second->on_general_call(av::kSdpSoftResetByte);  // plugged back in = power-on reset
        }
    }
    for (const Window& win : opt.crc_noise) {
        auto it = g_sdps.find(win.channel);
        if (it != g_sdps.end()) it->second->corrupt_crc = t >= win.from_s && t < win.to_s;
    }
}

// ---- Self-test ----------------------------------------------------------------------------

int g_failures = 0;
void expect(bool ok, const std::string& what) {
    if (!ok) {
        ++g_failures;
        std::printf("  FAIL %s\n", what.c_str());
    }
}

struct Line {
    std::string kind;   // AV, AVH, AVS
    std::vector<std::string> fields;
    uint32_t ms = 0;
};

std::vector<Line> parse_serial(const std::string& stream) {
    std::vector<Line> lines;
    std::istringstream in(stream);
    std::string raw;
    while (std::getline(in, raw)) {
        expect(!raw.empty() && raw.back() == '\r', "line ends with \\r\\n");
        if (!raw.empty() && raw.back() == '\r') raw.pop_back();
        const size_t star = raw.rfind('*');
        if (raw.empty() || raw[0] != '$' || star == std::string::npos) {
            expect(false, "malformed line: " + raw);
            continue;
        }
        const std::string payload = raw.substr(1, star - 1);
        char cs[3];
        std::snprintf(cs, sizeof cs, "%02X", av::nmea_checksum(payload.c_str()));
        expect(raw.substr(star + 1) == cs, "checksum of " + raw);
        Line line;
        std::istringstream fields(payload);
        std::string f;
        while (std::getline(fields, f, ',')) line.fields.push_back(f);
        line.kind = line.fields.empty() ? "" : line.fields[0];
        if ((line.kind == "AV" || line.kind == "AVS") && line.fields.size() > 2) {
            line.ms = static_cast<uint32_t>(std::strtoul(line.fields[2].c_str(), nullptr, 10));
        }
        lines.push_back(line);
    }
    return lines;
}

int self_test(const Options& opt) {
    const std::vector<Line> lines = parse_serial(sim::world().serial);
    const std::string first_tap = PRESSURE_SENSORS[0].channel;
    expect(!lines.empty() && lines[0].kind == "AVH", "the first line is the $AVH hello");

    // Hello: boot + every 5 s, listing every channel.
    int hellos = 0;
    for (const Line& l : lines) {
        if (l.kind != "AVH") continue;
        ++hellos;
        expect(l.fields.size() == 3u + CHANNEL_COUNT, "hello lists every channel");
        expect(l.fields[1] == NODE_NAME && l.fields[2] == FW_VERSION, "hello names node and firmware");
    }
    expect(hellos == static_cast<int>(opt.seconds / 5.0) + 1, "one hello at boot and every 5 s");

    // Data: every value matches the emulated truth.
    int data_lines = 0, tap_values = 0, nan_during_fault = 0, values_after_fault = 0;
    double max_err = 0;
    for (const Line& l : lines) {
        if (l.kind != "AV") continue;
        ++data_lines;
        const double t = l.ms / 1000.0;
        for (size_t k = 3; k < l.fields.size(); ++k) {
            const std::string& item = l.fields[k];
            const size_t eq = item.find('=');
            const std::string id = item.substr(0, eq), text = item.substr(eq + 1);
            const bool in_fault = !opt.disconnects.empty() && id == first_tap && t >= opt.disconnects[0].from_s + 0.3 &&
                                  t < opt.disconnects[0].to_s;
            if (in_fault) {
                nan_during_fault += text == "nan" ? 1 : 0;
                expect(text == "nan", "nan while " + id + " is unplugged");
                continue;
            }
            if (text == "nan") continue;
            const double v = std::atof(text.c_str());
            if (g_sdps.count(id)) {
                const double err = std::fabs(v - true_pressure(id, t));
                max_err = std::max(max_err, err);
                expect(err < 3.0, id + " value " + text + " vs truth");
                ++tap_values;
                if (!opt.disconnects.empty() && id == first_tap && t > opt.disconnects[0].to_s + 1.5) ++values_after_fault;
            } else if (id == "amb_temp") {
                expect(std::fabs(v - 25.08) < 0.006, "amb_temp " + text);
            } else if (id == "amb_press") {
                expect(std::fabs(v - 100653.0) < 1.0, "amb_press " + text);
            } else if (id == "amb_rh") {
                expect(v > 0.0 && v < 100.0, "amb_rh " + text);
            } else if (id.rfind("damper_", 0) == 0) {
                const double want = av::linear_pot_mm(POTS[0].cal, static_cast<uint16_t>(ADC_MAX / 2 + kPotOffsetCounts));
                expect(std::fabs(v - want) < 0.006, id + " " + text);
            } else if (id == "fw_load") {
                expect(std::fabs(v - kLoadCounts * LOAD_CELLS[0].cal.newtons_per_count) < 1.0, "fw_load " + text);
            } else {
                expect(false, "unexpected channel " + id);
            }
        }
    }
    // Lines stop only while a sensor warms up after (re)starting (25 ms each time).
    expect(data_lines >= static_cast<int>(0.98 * opt.seconds * 1000.0 / SERIAL_PERIOD_MS), "a data line every serial period");
    expect(tap_values > 0, "pressure values were sent");

    // Status lines around the unplugged sensor.
    if (!opt.disconnects.empty()) {
        const Window& win = opt.disconnects[0];
        bool error_seen = false, recovered_seen = false;
        for (const Line& l : lines) {
            if (l.kind != "AVS" || l.fields.size() < 5) continue;
            const double t = l.ms / 1000.0;
            const std::string& msg = l.fields[4];
            if (l.fields[3] == "error" && msg.find(win.channel) == 0 && t >= win.from_s && t < win.from_s + 0.3) error_seen = true;
            if (l.fields[3] == "ok" && msg == win.channel + ": recovered" && t >= win.to_s && t < win.to_s + 1.3) recovered_seen = true;
        }
        expect(error_seen, "$AVS error within 0.3 s of unplugging " + win.channel);
        expect(recovered_seen, "$AVS ok 'recovered' within 1.3 s of plugging " + win.channel + " back in");
        expect(nan_during_fault > 0, "nan values while unplugged");
        expect(values_after_fault > 0, "values again after recovery");
    }

    // CAN: every owned message at its cycle time, own signals = truth, others = SNA.
    const auto& frames = sim::world().can;
#if AV_USE_CAN
    expect(sim::world().can_started, "CAN controller started at 1 Mbit/s");
#else
    expect(!sim::world().can_started && frames.empty(), "serial-only build: CAN stays off");
#endif
    std::map<uint32_t, int> per_id;
    std::map<uint32_t, uint64_t> first_us;
    int checked = 0;
    for (const sim::CanFrame& f : frames) {
        if (per_id[f.id]++ == 0) first_us[f.id] = f.t_us;
        const aerovolt::can::MessageDef* msg = aerovolt::can::find_message(f.id);
        expect(msg != nullptr, "frame id is in the DBC");
        if (msg == nullptr) continue;
        const double t = f.t_us * 1e-6;
        for (uint8_t s = 0; s < msg->signal_count; ++s) {
            const aerovolt::can::SignalDef& sig = msg->signals[s];
            const double v = av::decode_signal(sig, f.data);
            const std::string id = sig.name;
            bool owned = false;
            for (uint8_t c = 0; c < PRESSURE_COUNT; ++c) owned = owned || id == PRESSURE_SENSORS[c].channel;
            if (g_sdps.count(id) && owned) {
                const bool in_fault = !opt.disconnects.empty() && id == first_tap && t >= opt.disconnects[0].from_s + 0.1 &&
                                      t < opt.disconnects[0].to_s;
                if (in_fault) {
                    expect(std::isnan(v), "SNA on CAN while " + id + " is unplugged");
                } else if (!std::isnan(v)) {
                    expect(std::fabs(v - true_pressure(id, t)) < 3.0, id + " on CAN vs truth");
                    ++checked;
                }
            }
            const bool node_owns = owned || id.rfind("amb_", 0) == 0 || id.rfind("damper_f", 0) == 0 ||
                                   (id == "fw_load" && LOAD_CELL_COUNT > 0);
            if (!node_owns) {
                expect(sig.has_sna ? std::isnan(v) : v == 0.0, id + " (not owned) is SNA");
            }
        }
    }
    expect(checked > 0 || !AV_USE_CAN, "pressure values decoded from CAN");
    for (const auto& [id, count] : per_id) {
        const aerovolt::can::MessageDef* msg = aerovolt::can::find_message(id);
        // From the first frame (after the boot sequence) to the end of the run, one per cycle.
        const int want = 1 + static_cast<int>((opt.seconds * 1e6 - first_us[id]) / 1000.0 / msg->cycle_ms);
        expect(std::abs(count - want) <= 1, std::string(msg->name) + " sent at its cycle time");
    }
    for (const auto& h : sim::world().hx711) expect(h.conversions > 0, "HX711 conversions read");

    std::printf("firmware_sim %s: %zu serial lines (%d data, %d hellos), %zu CAN frames, max pressure error %.3f Pa, "
                "%llu I2C transfers -> %s\n",
                NODE_NAME, lines.size(), data_lines, hellos, frames.size(), max_err,
                static_cast<unsigned long long>(sim::world().i2c_transfers), g_failures ? "FAILED" : "ok");
    return g_failures == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        Window w;
        if (a == "--self-test") {
            opt.self_test = true;
        } else if (a == "--seconds" && i + 1 < argc) {
            opt.seconds = std::atof(argv[++i]);
        } else if (a == "--serial-out" && i + 1 < argc) {
            opt.serial_out = argv[++i];
        } else if (a == "--can-out" && i + 1 < argc) {
            opt.can_out = argv[++i];
        } else if (a == "--disconnect" && i + 1 < argc && parse_window(argv[++i], w)) {
            opt.disconnects.push_back(w);
        } else if (a == "--crc-noise" && i + 1 < argc && parse_window(argv[++i], w)) {
            opt.crc_noise.push_back(w);
        } else {
            std::fprintf(stderr, "usage: %s [--self-test] [--seconds S] [--serial-out PATH] [--can-out PATH] "
                                 "[--disconnect CH@T1:T2] [--crc-noise CH@T1:T2]\n", argv[0]);
            return 2;
        }
    }
    if (opt.self_test && opt.disconnects.empty()) {
        opt.disconnects.push_back({PRESSURE_SENSORS[0].channel, 3.0, 6.0});
    }

    build_world();
    setup();
    const uint64_t end_us = static_cast<uint64_t>(opt.seconds * 1e6);
    while (sim::now_us() < end_us) {
        apply_windows(opt, sim::now_us() * 1e-6);
        loop();
        sim::advance_us(200);  // the rest of the loop: ~5000 loop() calls per second
    }

    if (!opt.serial_out.empty()) {
        FILE* f = std::fopen(opt.serial_out.c_str(), "wb");
        if (!f) return 2;
        std::fwrite(sim::world().serial.data(), 1, sim::world().serial.size(), f);
        std::fclose(f);
    }
    if (!opt.can_out.empty()) {
        FILE* f = std::fopen(opt.can_out.c_str(), "w");
        if (!f) return 2;
        for (const sim::CanFrame& fr : sim::world().can) {
            std::fprintf(f, "%llu %03X ", static_cast<unsigned long long>(fr.t_us), fr.id);
            for (uint8_t b : fr.data) std::fprintf(f, "%02X", b);
            std::fprintf(f, "\n");
        }
        std::fclose(f);
    }
    return opt.self_test ? self_test(opt) : 0;
}
