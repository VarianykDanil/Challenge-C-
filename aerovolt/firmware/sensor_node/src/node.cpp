// The sensor-node application. See node.h for the overview and include/node_config.h for
// the sensor tables.
//
// Data flow:   sensor drivers --> channel table (latest value + time) --> outputs
//                                                                    |--> $AV line every SERIAL_PERIOD_MS
//                                                                    '--> CAN frame per message cycle_ms
// Every channel value carries its time; a value older than its max age (3 sample periods)
// is sent as "not available" (NaN in $AV lines, SNA on CAN) - a dead sensor must never
// freeze a believable number on the dashboard.
#include "node.h"

#include <Arduino.h>
#include <Wire.h>

#include "drivers/bme280.h"
#include "drivers/hx711.h"
#include "drivers/sdp.h"
#include "drivers/tca9548a.h"
#include "filters.h"
#include "node_config.h"
#include "scheduler.h"
#include "text.h"
#include "transport/serial_out.h"

#if AV_USE_CAN
#include "aerovolt_can.h"
#include "can_codec.h"
#include "transport/can_bus.h"
#endif

using namespace node_config;

namespace {

// ---- Channel table ------------------------------------------------------------------------

/// One output channel: the latest value and when it was measured.
struct Channel {
    const char* id = "";
    uint8_t decimals = 1;        // digits after the point in $AV lines (catalogue resolution)
    uint32_t max_age_ms = 100;   // older values are "not available"
    float value = av::kNaN;
    uint32_t updated_ms = 0;
    bool fresh = false;          // updated since the last $AV line
#if AV_USE_CAN
    const aerovolt::can::MessageDef* message = nullptr;
#endif
};

// Layout of the table: pressure sensors, then ambient (3), then pots, then load cells.
constexpr uint8_t kAmbientBase = PRESSURE_COUNT;
constexpr uint8_t kAmbientCount = AMBIENT.fitted ? 3 : 0;
constexpr uint8_t kPotBase = kAmbientBase + kAmbientCount;
constexpr uint8_t kLoadBase = kPotBase + POT_COUNT;
// Arrays need at least one element even when a profile has no pots / load cells.
constexpr uint8_t kPotSlots = POT_COUNT > 0 ? POT_COUNT : 1;
constexpr uint8_t kLoadSlots = LOAD_CELL_COUNT > 0 ? LOAD_CELL_COUNT : 1;

Channel g_channels[CHANNEL_COUNT];

// ---- Sensor health ----------------------------------------------------------------------

/// Error bookkeeping of one physical sensor (drives the $AVS status lines).
struct Health {
    bool running = false;          // initialised; reads are attempted
    bool failed = false;           // reported as "error" to the computer
    bool over_range = false;       // reported as "warn"
    uint8_t consecutive_failures = 0;
    uint32_t retry_ms = 0;         // when to try to re-initialise a sensor that is not running
    uint32_t last_ok_ms = 0;
};

SdpSensor g_sdp[PRESSURE_COUNT];
Health g_sdp_health[PRESSURE_COUNT];
Tca9548a g_mux(TCA9548A_ADDRESS);
bool g_mux_ok = true;
Bme280 g_bme(AMBIENT.i2c_address);
Health g_bme_health;
av::MovingAverage<5> g_pot_filter[kPotSlots];
Health g_pot_health[kPotSlots];
Hx711 g_hx711[kLoadSlots];
av::LowPass1 g_load_filter[kLoadSlots];
Health g_load_health[kLoadSlots];

// ---- Timers -----------------------------------------------------------------------------
av::CycleTimer g_pressure_timer(PRESSURE_PERIOD_MS);
av::CycleTimer g_ambient_timer(AMBIENT_PERIOD_MS, 100);  // phases spread the work out; the
                                                         // BME280's first conversion takes ~20 ms
av::CycleTimer g_pot_timer(POT_PERIOD_MS);
av::CycleTimer g_serial_timer(SERIAL_PERIOD_MS, 3);
av::CycleTimer g_hello_timer(HELLO_PERIOD_MS);

/// Load cells must deliver a conversion at least this often (HX711: 80 or 10 samples/s).
constexpr uint32_t kLoadCellTimeoutMs = 500;
/// HX711 sample interval at 80 samples/s, for the low-pass filter.
constexpr float kLoadCellDtS = 1.0f / 80.0f;
/// Load-cell smoothing time constant (fc ~ 8 Hz, keeps the 50 Hz channel honest).
constexpr float kLoadCellTauS = 0.02f;

#if AV_USE_SERIAL
SerialSink g_sink;
av::AvWriter g_writer(g_sink);
#endif

#if AV_USE_CAN
const aerovolt::can::MessageDef* g_messages[CHANNEL_COUNT];
av::CycleTimer g_message_timers[CHANNEL_COUNT];
uint8_t g_message_count = 0;
bool g_can_ok = false;
uint32_t g_can_tx_failures = 0;
uint32_t g_can_tx_failures_reported = 0;
#endif

// ---- Helpers ----------------------------------------------------------------------------

void send_status(av::NodeStatus status, const char* message, uint32_t now_ms) {
#if AV_USE_SERIAL
    g_writer.status(NODE_NAME, now_ms, status, message);
#else
    (void)status;
    (void)message;
    (void)now_ms;
#endif
}

void send_status(av::NodeStatus status, const __FlashStringHelper* message, uint32_t now_ms) {
    Text<72> t;
    t.add(message);
    send_status(status, t.c_str(), now_ms);
}

void define_channel(uint8_t index, const char* id, uint8_t decimals, uint32_t period_ms) {
    Channel& ch = g_channels[index];
    ch.id = id;
    ch.decimals = decimals;
    ch.max_age_ms = 3 * period_ms + 20;  // three missed samples (+ loop jitter) = stale
}

void set_value(uint8_t index, float value, uint32_t now_ms) {
    Channel& ch = g_channels[index];
    ch.value = value;
    ch.updated_ms = now_ms;
    ch.fresh = true;
}

/// The value to publish now: NaN when missing or too old.
float current_value(const Channel& ch, uint32_t now_ms) {
    if (av::is_nan(ch.value) || now_ms - ch.updated_ms > ch.max_age_ms) return av::kNaN;
    return ch.value;
}

/// Count a bad reading; after SENSOR_FAILS_BEFORE_ERROR in a row (or at once when
/// `immediately`), report the sensor as failed and schedule a re-initialisation.
void report_failure(Health& h, const char* channel, const char* reason, uint32_t now_ms, bool immediately) {
    if (h.consecutive_failures < 255) ++h.consecutive_failures;
    if (!immediately && h.consecutive_failures < SENSOR_FAILS_BEFORE_ERROR) return;
    h.running = false;
    h.retry_ms = now_ms + SENSOR_RETRY_MS;
    if (!h.failed) {
        h.failed = true;
        Text<72> t;
        t.add(channel).add(F(": ")).add(reason);
        send_status(av::NodeStatus::kError, t.c_str(), now_ms);
    }
}

void report_failure(Health& h, const char* channel, const __FlashStringHelper* reason, uint32_t now_ms,
                    bool immediately) {
    Text<72> t;
    t.add(reason);
    report_failure(h, channel, t.c_str(), now_ms, immediately);
}

/// A good reading: clears the failure count and announces a recovery.
void report_ok(Health& h, const char* channel, uint32_t now_ms) {
    h.consecutive_failures = 0;
    h.last_ok_ms = now_ms;
    if (h.failed) {
        h.failed = false;
        Text<72> t;
        t.add(channel).add(F(": recovered"));
        send_status(av::NodeStatus::kOk, t.c_str(), now_ms);
    }
}

bool retry_due(const Health& h, uint32_t now_ms) {
    return !h.running && static_cast<int32_t>(now_ms - h.retry_ms) >= 0;
}

// ---- Pressure sensors (SDP) ---------------------------------------------------------------

void describe_location(Text<72>& t, uint8_t i) {
    const PressureSensorConfig& cfg = PRESSURE_SENSORS[i];
    if (cfg.i2c_address == SDP_AUTO_ADDRESS) {
        t.add(F("no SDP sensor at 0x25/0x21/0x26/0x22/0x23"));
    } else {
        t.add(F("no answer at 0x")).add_hex(cfg.i2c_address);
    }
    if (cfg.mux_channel != NO_MUX) t.add(F(" (mux channel ")).add_uint(static_cast<uint32_t>(cfg.mux_channel)).add(F(")"));
}

bool select_mux(int8_t channel) {
    if (!uses_mux()) return true;
    g_mux_ok = g_mux.select(channel);
    return g_mux_ok;
}

void start_pressure_sensor(uint8_t i, uint32_t now_ms) {
    const PressureSensorConfig& cfg = PRESSURE_SENSORS[i];
    Health& h = g_sdp_health[i];
    if (select_mux(cfg.mux_channel) && g_sdp[i].begin(now_ms)) {
        h.running = true;
        h.last_ok_ms = now_ms;
        return;
    }
    Text<72> reason;
    if (!g_mux_ok) {
        reason.add(F("I2C mux not answering at 0x")).add_hex(TCA9548A_ADDRESS);
    } else {
        describe_location(reason, i);
    }
    report_failure(h, cfg.channel, reason.c_str(), now_ms, true);
}

void read_pressure_sensors(uint32_t now_ms) {
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) {
        const PressureSensorConfig& cfg = PRESSURE_SENSORS[i];
        Health& h = g_sdp_health[i];
        if (!h.running) {
            if (retry_due(h, now_ms)) start_pressure_sensor(i, now_ms);
            if (!h.running) set_value(i, av::kNaN, now_ms);  // say "nan" instead of going quiet
            continue;
        }
        av::SdpMeasurement m;
        const SdpSensor::Result r = select_mux(cfg.mux_channel) ? g_sdp[i].read(now_ms, m) : SdpSensor::Result::kNoAnswer;
        switch (r) {
            case SdpSensor::Result::kOk:
                report_ok(h, cfg.channel, now_ms);
                if (m.saturated) {
                    // Beyond the sensor's range: the true pressure is unknown, so it is NOT
                    // sent as the clipped number (a wrong Cp is worse than no Cp).
                    set_value(i, av::kNaN, now_ms);
                    if (!h.over_range) {
                        h.over_range = true;
                        Text<72> t;
                        t.add(cfg.channel).add(F(": over range (> ")).add_uint(av::sdp_range_pa(m.scale_factor)).add(F(" Pa)"));
                        send_status(av::NodeStatus::kWarn, t.c_str(), now_ms);
                    }
                } else {
                    h.over_range = false;
                    set_value(i, m.dp_pa, now_ms);
                }
                break;
            case SdpSensor::Result::kWarmingUp:
                break;
            case SdpSensor::Result::kCrcError:
                report_failure(h, cfg.channel, F("CRC errors (noise? pull-ups? cable length?)"), now_ms, false);
                break;
            case SdpSensor::Result::kBadData:
                report_failure(h, cfg.channel, F("invalid data (scale factor 0)"), now_ms, false);
                break;
            case SdpSensor::Result::kNoAnswer:
            default: {
                Text<72> reason;
                reason.add(F("stopped answering"));
                if (cfg.mux_channel != NO_MUX) reason.add(F(" (mux channel ")).add_uint(static_cast<uint32_t>(cfg.mux_channel)).add(F(")"));
                report_failure(h, cfg.channel, reason.c_str(), now_ms, false);
                break;
            }
        }
    }
}

// ---- Ambient (BME280) -------------------------------------------------------------------

void start_ambient(uint32_t now_ms) {
    if (select_mux(AMBIENT.mux_channel) && g_bme.begin()) {
        g_bme_health.running = true;
        if (!g_bme.has_humidity()) {
            send_status(av::NodeStatus::kWarn, F("BMP280 fitted: no humidity sensor, amb_rh not available"), now_ms);
        }
        return;
    }
    Text<72> t;
    t.add(F("BME280 not found at 0x")).add_hex(AMBIENT.i2c_address);
    report_failure(g_bme_health, "BME280", t.c_str(), now_ms, true);
}

void read_ambient(uint32_t now_ms) {
    if (!g_bme_health.running) {
        if (retry_due(g_bme_health, now_ms)) start_ambient(now_ms);
        if (!g_bme_health.running) {
            for (uint8_t k = 0; k < 3; ++k) set_value(kAmbientBase + k, av::kNaN, now_ms);
            return;
        }
    }
    av::Bme280Reading r;
    if (select_mux(AMBIENT.mux_channel) && g_bme.read(r)) {
        report_ok(g_bme_health, "BME280", now_ms);
        set_value(kAmbientBase + 0, r.temperature_c, now_ms);
        set_value(kAmbientBase + 1, r.pressure_pa, now_ms);
        set_value(kAmbientBase + 2, r.humidity_pct, now_ms);
    } else {
        report_failure(g_bme_health, "BME280", F("stopped answering"), now_ms, false);
    }
}

// ---- Linear pots (dampers) ------------------------------------------------------------------

void read_pots(uint32_t now_ms) {
    for (uint8_t i = 0; i < POT_COUNT; ++i) {
        const PotConfig& cfg = POTS[i];
        const uint16_t counts = static_cast<uint16_t>(analogRead(cfg.pin));
        const float mm = av::linear_pot_mm(cfg.cal, counts);
        if (av::is_nan(mm)) {
            g_pot_filter[i].reset();
            set_value(kPotBase + i, av::kNaN, now_ms);
            Text<72> t;
            t.add(F("reading ")).add_uint(counts).add(F(" outside ")).add_uint(cfg.cal.valid_min).add(F(".."))
                .add_uint(cfg.cal.valid_max).add(F(" (wiring?)"));
            report_failure(g_pot_health[i], cfg.channel, t.c_str(), now_ms, false);
        } else {
            report_ok(g_pot_health[i], cfg.channel, now_ms);
            set_value(kPotBase + i, g_pot_filter[i].update(mm), now_ms);
        }
    }
}

// ---- Load cells (HX711) ---------------------------------------------------------------------

void poll_load_cells(uint32_t now_ms) {
    for (uint8_t i = 0; i < LOAD_CELL_COUNT; ++i) {
        const LoadCellConfig& cfg = LOAD_CELLS[i];
        Health& h = g_load_health[i];
        if (g_hx711[i].ready()) {
            const int32_t counts = g_hx711[i].read_counts();
            const float newtons = av::hx711_newtons(cfg.cal, counts);
            if (av::is_nan(newtons)) {
                g_load_filter[i].reset();
                set_value(kLoadBase + i, av::kNaN, now_ms);
                report_failure(h, cfg.channel, F("HX711 saturated (overload or open bridge wire)"), now_ms, false);
                h.last_ok_ms = now_ms;  // it is answering, just out of range
            } else {
                report_ok(h, cfg.channel, now_ms);
                set_value(kLoadBase + i, g_load_filter[i].update(newtons), now_ms);
            }
        } else if (now_ms - h.last_ok_ms > kLoadCellTimeoutMs) {
            h.last_ok_ms = now_ms;  // report again only after another timeout
            Text<72> t;
            t.add(F("no data from HX711 (DOUT pin ")).add_uint(cfg.dout_pin).add(F(")"));
            report_failure(h, cfg.channel, t.c_str(), now_ms, true);
            g_load_filter[i].reset();
            set_value(kLoadBase + i, av::kNaN, now_ms);
        }
    }
}

// ---- Outputs ----------------------------------------------------------------------------------

void send_hello() {
#if AV_USE_SERIAL
    g_writer.begin_hello(NODE_NAME, FW_VERSION);
    for (uint8_t i = 0; i < CHANNEL_COUNT; ++i) g_writer.add_channel(g_channels[i].id);
    g_writer.end();
#endif
}

/// With every hello: a reminder of what is still broken (the computer may have connected
/// after the original error message).
void send_health_summary(uint32_t now_ms) {
    Text<72> t;
    t.add(F("failing:"));
    uint8_t failing = 0;
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) {
        if (g_sdp_health[i].failed) {
            t.add(F(" ")).add(PRESSURE_SENSORS[i].channel);
            ++failing;
        }
    }
    if (AMBIENT.fitted && g_bme_health.failed) {
        t.add(F(" BME280"));
        ++failing;
    }
    for (uint8_t i = 0; i < POT_COUNT; ++i) {
        if (g_pot_health[i].failed) {
            t.add(F(" ")).add(POTS[i].channel);
            ++failing;
        }
    }
    for (uint8_t i = 0; i < LOAD_CELL_COUNT; ++i) {
        if (g_load_health[i].failed) {
            t.add(F(" ")).add(LOAD_CELLS[i].channel);
            ++failing;
        }
    }
    if (failing > 0) send_status(av::NodeStatus::kError, t.c_str(), now_ms);
#if AV_USE_CAN
    if (!g_can_ok) {
        send_status(av::NodeStatus::kError, F("CAN controller did not start"), now_ms);
    } else if (g_can_tx_failures != g_can_tx_failures_reported) {
        Text<72> c;
        c.add(F("CAN: ")).add_uint(g_can_tx_failures - g_can_tx_failures_reported)
            .add(F(" frames not sent (bus unplugged? no other node to ACK?)"));
        g_can_tx_failures_reported = g_can_tx_failures;
        send_status(av::NodeStatus::kWarn, c.c_str(), now_ms);
    }
#endif
}

void send_serial_line(uint32_t now_ms) {
#if AV_USE_SERIAL
    bool started = false;
    for (uint8_t i = 0; i < CHANNEL_COUNT; ++i) {
        Channel& ch = g_channels[i];
        if (!ch.fresh) continue;
        if (!started) {
            g_writer.begin_data(NODE_NAME, now_ms);
            started = true;
        }
        g_writer.add_value(ch.id, current_value(ch, now_ms), ch.decimals);
        ch.fresh = false;
    }
    if (started) g_writer.end();
#else
    (void)now_ms;
#endif
}

#if AV_USE_CAN
/// Find the CAN message of every channel and give each message its own cycle timer.
void plan_can_messages(uint32_t now_ms) {
    for (uint8_t i = 0; i < CHANNEL_COUNT; ++i) {
        Channel& ch = g_channels[i];
        const aerovolt::can::SignalRef ref = aerovolt::can::find_channel(ch.id);
        if (ref.message == nullptr) {
            Text<72> t;
            t.add(ch.id).add(F(" is not a CAN signal (check node_config.h)"));
            send_status(av::NodeStatus::kError, t.c_str(), now_ms);
            continue;
        }
        ch.message = ref.message;
        bool known = false;
        for (uint8_t m = 0; m < g_message_count; ++m) known = known || g_messages[m] == ref.message;
        if (!known) {
            // Phase offsets of 1 ms per message spread equal-period frames over the cycle.
            g_message_timers[g_message_count] = av::CycleTimer(ref.message->cycle_ms, g_message_count % ref.message->cycle_ms);
            g_messages[g_message_count++] = ref.message;
        }
    }
}

void send_can_messages(uint32_t now_ms) {
    for (uint8_t m = 0; m < g_message_count; ++m) {
        if (!g_message_timers[m].due(now_ms)) continue;
        const aerovolt::can::MessageDef& msg = *g_messages[m];
        uint8_t data[av::kFrameBytes];
        av::fill_sna(msg, data);  // signals of other nodes stay "not available"
        for (uint8_t i = 0; i < CHANNEL_COUNT; ++i) {
            const Channel& ch = g_channels[i];
            if (ch.message == &msg) av::set_channel(msg, ch.id, current_value(ch, now_ms), data);
        }
        if (!can_bus_send(msg.id, data)) ++g_can_tx_failures;
    }
}
#endif

void define_channels() {
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) {
        define_channel(i, PRESSURE_SENSORS[i].channel, 1, PRESSURE_PERIOD_MS);  // 0.1 Pa
        g_sdp[i] = SdpSensor(PRESSURE_SENSORS[i].i2c_address);
    }
    if (AMBIENT.fitted) {
        define_channel(kAmbientBase + 0, "amb_temp", 2, AMBIENT_PERIOD_MS);   // 0.01 degC
        define_channel(kAmbientBase + 1, "amb_press", 0, AMBIENT_PERIOD_MS);  // 1 Pa
        define_channel(kAmbientBase + 2, "amb_rh", 1, AMBIENT_PERIOD_MS);     // 0.5 %
    }
    for (uint8_t i = 0; i < POT_COUNT; ++i) {
        define_channel(kPotBase + i, POTS[i].channel, 2, POT_PERIOD_MS * 5);  // 0.01 mm
    }
    for (uint8_t i = 0; i < LOAD_CELL_COUNT; ++i) {
        define_channel(kLoadBase + i, LOAD_CELLS[i].channel, 0, 160);  // 1 N; 80 S/s HX711
        g_load_filter[i].set_time_constant(kLoadCellTauS, kLoadCellDtS);
    }
}

}  // namespace

// ---- Entry points -------------------------------------------------------------------------

void node_begin() {
#if AV_USE_SERIAL
    serial_out_begin(SERIAL_BAUD);
#endif
    const uint32_t now = millis();
    define_channels();
    send_hello();  // first line out: lets the computer recognise the node immediately

    Wire.begin();
    Wire.setClock(I2C_CLOCK_HZ);
#if defined(__IMXRT1062__) || defined(ESP32)
    analogReadResolution(ADC_BITS);
#endif

    // Soft-reset all SDP sensors with one I2C general call - through every mux channel.
    if (uses_mux()) {
        g_mux_ok = g_mux.begin() && g_mux.select_mask(0xFF);
        if (!g_mux_ok) {
            Text<72> t;
            t.add(F("TCA9548A I2C mux not found at 0x")).add_hex(TCA9548A_ADDRESS);
            send_status(av::NodeStatus::kError, t.c_str(), now);
        }
    }
    SdpSensor::general_call_reset();

    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) start_pressure_sensor(i, millis());
    if (AMBIENT.fitted) start_ambient(millis());
    for (uint8_t i = 0; i < LOAD_CELL_COUNT; ++i) {
        g_hx711[i].begin(LOAD_CELLS[i].dout_pin, LOAD_CELLS[i].sck_pin);
        g_load_health[i].last_ok_ms = millis();
    }

#if AV_USE_CAN
    g_can_ok = can_bus_begin(CAN_BITRATE);
    if (!g_can_ok) send_status(av::NodeStatus::kError, F("CAN controller did not start"), millis());
    plan_can_messages(millis());
#endif

    uint8_t working = 0;
    for (uint8_t i = 0; i < PRESSURE_COUNT; ++i) working += g_sdp_health[i].running ? 1 : 0;
    Text<72> t;
    t.add(F("boot: ")).add_uint(working).add(F("/")).add_uint(PRESSURE_COUNT).add(F(" pressure sensors"));
    if (AMBIENT.fitted) t.add(g_bme_health.running ? F(", ambient ok") : F(", no ambient"));
#if AV_USE_CAN
    t.add(g_can_ok ? F(", CAN on") : F(", CAN failed"));
#endif
    const bool all_ok = working == PRESSURE_COUNT && (!AMBIENT.fitted || g_bme_health.running);
    send_status(all_ok ? av::NodeStatus::kOk : av::NodeStatus::kWarn, t.c_str(), millis());
    g_hello_timer.due(millis());  // the boot hello counts as the first one
}

void node_poll(uint32_t now_ms) {
    if (g_pressure_timer.due(now_ms)) read_pressure_sensors(now_ms);
    if (AMBIENT.fitted && g_ambient_timer.due(now_ms)) read_ambient(now_ms);
    if (POT_COUNT > 0 && g_pot_timer.due(now_ms)) read_pots(now_ms);
    if (LOAD_CELL_COUNT > 0) poll_load_cells(now_ms);
#if AV_USE_CAN
    send_can_messages(now_ms);
    can_bus_poll(now_ms);
#endif
    if (g_serial_timer.due(now_ms)) send_serial_line(now_ms);
    if (g_hello_timer.due(now_ms)) {
        send_hello();
        send_health_summary(now_ms);
    }
}
