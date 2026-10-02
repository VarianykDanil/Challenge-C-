// The emulated hardware for the firmware-in-the-loop host build. See sim_world.h.
#include "sim_world.h"

#include <Arduino.h>
#include <Wire.h>

#include <cmath>
#include <cstring>

#include "sensirion.h"
#include "transport/can_bus.h"

namespace sim {

namespace {
uint64_t g_now_us = 0;
/// One I2C byte at 400 kHz: 8 data bits + ACK = 22.5 us.
constexpr uint64_t kI2cByteUs = 23;
}  // namespace

uint64_t now_us() { return g_now_us; }
void advance_us(uint64_t us) { g_now_us += us; }

World& world() {
    static World w;
    return w;
}

std::vector<I2cDevice*> devices_at(uint8_t address) {
    World& w = world();
    std::vector<I2cDevice*> found;
    auto it = w.main_bus.find(address);
    if (it != w.main_bus.end() && it->second->connected) found.push_back(it->second.get());
    if (w.mux) {
        for (auto& [channel, devices] : w.mux_bus) {
            if (!(w.mux->mask & (1u << channel))) continue;
            auto d = devices.find(address);
            if (d != devices.end() && d->second->connected) found.push_back(d->second.get());
        }
    }
    return found;
}

// ---- FakeSdp ----------------------------------------------------------------------------

bool FakeSdp::on_write(const uint8_t* data, uint8_t n) {
    if (n == 0) return true;  // address-only write (I2C scan): ACK
    if (n != 2) return false;
    const uint16_t cmd = static_cast<uint16_t>((data[0] << 8) | data[1]);
    if (cmd == av::kSdpCmdStopContinuous) {
        measuring_ = false;
        id_stage_ = 0;
        return true;
    }
    if (measuring_) return false;  // datasheet: only "stop" is accepted while measuring
    if (cmd == av::kSdpCmdContinuousDpAverage || cmd == av::kSdpCmdContinuousDpNone) {
        measuring_ = true;
        started_us_ = now_us();
        return true;
    }
    if (cmd == av::kSdpCmdProductId1) {
        id_stage_ = 1;
        return true;
    }
    if (cmd == av::kSdpCmdProductId2 && id_stage_ == 1) {
        id_stage_ = 2;
        return true;
    }
    return false;
}

bool FakeSdp::on_read(uint8_t* out, uint8_t n) {
    if (id_stage_ == 2 && !measuring_ && n == av::kSdpProductIdBytes) {
        const uint16_t words[6] = {static_cast<uint16_t>(product_ >> 16), static_cast<uint16_t>(product_ & 0xFFFF),
                                   0x0000, 0x0042, 0x1234, 0x5678};
        for (int i = 0; i < 6; ++i) av::sensirion_make_word(words[i], out + 3 * i);
        ++product_id_reads;
        return true;
    }
    if (!measuring_ || n != av::kSdpMeasurementBytes) return false;
    if (now_us() - started_us_ < 8000) return false;  // first result after 8 ms
    const double t = static_cast<double>(now_us()) * 1e-6;
    const double raw = std::nearbyint(pressure_(t) * scale_);
    const int16_t dp = static_cast<int16_t>(raw > 32767 ? 32767 : (raw < -32768 ? -32768 : raw));
    av::sensirion_make_word(static_cast<uint16_t>(dp), out);
    av::sensirion_make_word(static_cast<uint16_t>(static_cast<int16_t>(std::lround(temperature_c * 200.0))), out + 3);
    av::sensirion_make_word(scale_, out + 6);
    if (corrupt_crc) out[2] ^= 0x01;
    return true;
}

bool FakeSdp::on_general_call(uint8_t byte) {
    if (byte != av::kSdpSoftResetByte) return false;
    measuring_ = false;
    id_stage_ = 0;
    return true;
}

// ---- FakeMux ----------------------------------------------------------------------------

bool FakeMux::on_write(const uint8_t* data, uint8_t n) {
    if (n != 1) return false;
    mask = data[0];
    return true;
}

bool FakeMux::on_read(uint8_t* out, uint8_t n) {
    for (uint8_t i = 0; i < n; ++i) out[i] = mask;
    return true;
}

// ---- FakeBme280 ---------------------------------------------------------------------------

FakeBme280::FakeBme280() {
    // Calibration of the Bosch datasheet example (+ typical humidity constants).
    const int16_t tp[12] = {27504, 26435, -1000, static_cast<int16_t>(36477), -10685, 3024,
                            2855, 140, -7, 15500, -14600, 6000};
    for (int i = 0; i < 12; ++i) {
        regs_[0x88 + 2 * i] = static_cast<uint8_t>(tp[i] & 0xFF);
        regs_[0x89 + 2 * i] = static_cast<uint8_t>((static_cast<uint16_t>(tp[i]) >> 8) & 0xFF);
    }
    regs_[0xA1] = 75;                         // H1
    regs_[0xE1] = 0x6A; regs_[0xE2] = 0x01;   // H2 = 362
    regs_[0xE3] = 0;                          // H3
    regs_[0xE4] = 0x13; regs_[0xE5] = 0x29;   // H4 = 313, H5 = 50
    regs_[0xE6] = 0x03; regs_[0xE7] = 30;     // H6
    regs_[0xD0] = 0x60;                       // chip id: BME280
    set_raw(519888, 415148, 30000);
}

void FakeBme280::set_raw(int32_t adc_T, int32_t adc_P, int32_t adc_H) {
    regs_[0xF7] = static_cast<uint8_t>(adc_P >> 12);
    regs_[0xF8] = static_cast<uint8_t>(adc_P >> 4);
    regs_[0xF9] = static_cast<uint8_t>((adc_P & 0xF) << 4);
    regs_[0xFA] = static_cast<uint8_t>(adc_T >> 12);
    regs_[0xFB] = static_cast<uint8_t>(adc_T >> 4);
    regs_[0xFC] = static_cast<uint8_t>((adc_T & 0xF) << 4);
    regs_[0xFD] = static_cast<uint8_t>(adc_H >> 8);
    regs_[0xFE] = static_cast<uint8_t>(adc_H & 0xFF);
}

bool FakeBme280::on_write(const uint8_t* data, uint8_t n) {
    if (n == 0) return true;
    pointer_ = data[0];
    for (uint8_t i = 0; i + 1 < n; i += 2) {  // burst write: register / value pairs
        const uint8_t reg = data[i], value = data[i + 1];
        if (reg == 0xE0 && value == 0xB6) continue;  // soft reset: register file unchanged
        if (reg >= 0xF2 && reg <= 0xF5) regs_[reg] = value;
    }
    return true;
}

bool FakeBme280::on_read(uint8_t* out, uint8_t n) {
    for (uint8_t i = 0; i < n; ++i) out[i] = regs_[static_cast<uint8_t>(pointer_ + i)];
    return true;
}

}  // namespace sim

// ---- Arduino API ----------------------------------------------------------------------------

using sim::world;

SimSerial Serial;
TwoWire Wire;

uint32_t millis() { return static_cast<uint32_t>(sim::now_us() / 1000u); }
uint32_t micros() { return static_cast<uint32_t>(sim::now_us()); }
void delay(uint32_t ms) { sim::advance_us(static_cast<uint64_t>(ms) * 1000u); }
void delayMicroseconds(uint32_t us) { sim::advance_us(us); }
void noInterrupts() {}
void interrupts() {}
void pinMode(uint8_t, uint8_t) {}

void SimSerial::begin(uint32_t) {}
size_t SimSerial::write(uint8_t byte) {
    world().serial.push_back(static_cast<char>(byte));
    return 1;
}

int analogRead(uint8_t pin) {
    auto it = world().analog.find(pin);
    return it == world().analog.end() ? 0 : it->second;
}

namespace {

int hx711_dout(sim::FakeHx711& h) {
    if (!h.connected) return HIGH;  // pull-up, nothing drives the line
    if (h.shifting) return h.dout_level;
    return sim::now_us() >= h.next_ready_us ? LOW : HIGH;
}

void hx711_clock_rising(sim::FakeHx711& h) {
    if (!h.connected) return;
    if (!h.shifting) {
        if (sim::now_us() < h.next_ready_us) return;  // no conversion ready: pulse ignored
        h.shifting = true;
        h.pulses = 0;
        h.shift_value = static_cast<uint32_t>(h.counts) & 0xFFFFFFu;
    }
    ++h.pulses;
    if (h.pulses <= 24) {
        h.dout_level = static_cast<int>((h.shift_value >> (24 - h.pulses)) & 1u);
    } else {  // 25th pulse: gain 128 selected, conversion finished
        h.shifting = false;
        h.dout_level = HIGH;
        h.next_ready_us = sim::now_us() + h.period_us;
        ++h.conversions;
    }
}

}  // namespace

void digitalWrite(uint8_t pin, uint8_t level) {
    for (auto& h : world().hx711) {
        if (h.sck_pin == pin && level == HIGH) hx711_clock_rising(h);
    }
}

int digitalRead(uint8_t pin) {
    for (auto& h : world().hx711) {
        if (h.dout_pin == pin) return hx711_dout(h);
    }
    return LOW;
}

// ---- Wire ---------------------------------------------------------------------------------

void TwoWire::begin() {}
void TwoWire::setClock(uint32_t) {}

void TwoWire::beginTransmission(uint8_t address) {
    address_ = address;
    tx_len_ = 0;
}

size_t TwoWire::write(uint8_t byte) {
    if (tx_len_ >= sizeof tx_) return 0;
    tx_[tx_len_++] = byte;
    return 1;
}

uint8_t TwoWire::endTransmission(bool) {
    sim::World& w = world();
    ++w.i2c_transfers;
    sim::advance_us(sim::kI2cByteUs * (tx_len_ + 1u));
    if (address_ == 0) {  // general call: every device that supports it reacts
        bool acked = false;
        std::vector<sim::I2cDevice*> all;
        for (auto& [addr, dev] : w.main_bus) all.push_back(dev.get());
        if (w.mux) {
            for (auto& [channel, devices] : w.mux_bus) {
                if (!(w.mux->mask & (1u << channel))) continue;
                for (auto& [addr, dev] : devices) all.push_back(dev.get());
            }
        }
        for (sim::I2cDevice* d : all) {
            if (d->connected && tx_len_ == 1) acked = d->on_general_call(tx_[0]) || acked;
        }
        return acked ? 0 : 2;
    }
    if (w.mux && address_ == w.mux_address) return w.mux->on_write(tx_, tx_len_) ? 0 : 3;
    const auto found = sim::devices_at(address_);
    if (found.empty()) return 2;    // address NACK
    if (found.size() > 1) return 4; // two devices answer: bus conflict
    return found[0]->on_write(tx_, tx_len_) ? 0 : 3;
}

uint8_t TwoWire::requestFrom(uint8_t address, uint8_t quantity) {
    sim::World& w = world();
    ++w.i2c_transfers;
    rx_len_ = rx_pos_ = 0;
    if (quantity > sizeof rx_) return 0;
    sim::advance_us(sim::kI2cByteUs);
    bool ok = false;
    if (w.mux && address == w.mux_address) {
        ok = w.mux->on_read(rx_, quantity);
    } else {
        const auto found = sim::devices_at(address);
        ok = found.size() == 1 && found[0]->on_read(rx_, quantity);
    }
    if (!ok) return 0;
    sim::advance_us(sim::kI2cByteUs * quantity);
    rx_len_ = quantity;
    return quantity;
}

int TwoWire::available() { return rx_len_ - rx_pos_; }

int TwoWire::read() { return rx_pos_ < rx_len_ ? rx_[rx_pos_++] : -1; }

// ---- CAN backend --------------------------------------------------------------------------

bool can_bus_begin(uint32_t bitrate) {
    world().can_started = bitrate == 1000000;
    return world().can_started;
}

bool can_bus_send(uint32_t id, const uint8_t data[8]) {
    sim::CanFrame f{sim::now_us(), id, {}};
    std::memcpy(f.data, data, 8);
    world().can.push_back(f);
    return true;
}

void can_bus_poll(uint32_t) {}
