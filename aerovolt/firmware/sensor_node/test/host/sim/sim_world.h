// The emulated hardware around the firmware when it runs on a PC (firmware-in-the-loop).
//
//   * virtual time (microseconds), advanced by the test harness and by delay();
//   * an I2C bus with a TCA9548A multiplexer, Sensirion SDP sensors (continuous mode,
//     CRC-protected 9-byte reads, product id, general-call reset) and a BME280 (register
//     file with the Bosch datasheet calibration example);
//   * analog pins (linear pots) and an HX711 that shifts its 24-bit result out on the
//     clock pulses the firmware bit-bangs;
//   * captures of everything the firmware sends: serial bytes and CAN frames.
//
// The emulated sensors implement the datasheet behaviour that the firmware relies on, so
// mistakes such as "reading the product id while measuring" or "forgetting the 25th HX711
// clock" show up as failing host tests.
#pragma once

#include <stdint.h>

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace sim {

/// Virtual time in microseconds since power-on.
uint64_t now_us();
void advance_us(uint64_t us);

/// An I2C target device.
class I2cDevice {
public:
    virtual ~I2cDevice() = default;
    /// A write transfer; return true to ACK.
    virtual bool on_write(const uint8_t* data, uint8_t n) = 0;
    /// A read transfer of n bytes; return false to NACK.
    virtual bool on_read(uint8_t* out, uint8_t n) = 0;
    /// I2C general call (address 0); return true if the device reacts (ACKs).
    virtual bool on_general_call(uint8_t /*byte*/) { return false; }
    bool connected = true;  // false = unplugged (never ACKs)
};

/// Sensirion SDP3x/SDP8xx emulation.
class FakeSdp : public I2cDevice {
public:
    FakeSdp(uint32_t product_number, uint16_t scale_factor, std::function<double(double)> pressure_pa)
        : product_(product_number), scale_(scale_factor), pressure_(std::move(pressure_pa)) {}
    bool on_write(const uint8_t* data, uint8_t n) override;
    bool on_read(uint8_t* out, uint8_t n) override;
    bool on_general_call(uint8_t byte) override;
    bool corrupt_crc = false;     // flip a CRC bit in every response
    double temperature_c = 24.5;
    bool measuring() const { return measuring_; }
    int product_id_reads = 0;

private:
    uint32_t product_;
    uint16_t scale_;
    std::function<double(double)> pressure_;
    bool measuring_ = false;
    uint64_t started_us_ = 0;
    int id_stage_ = 0;            // 0 idle, 1 got 0x367C, 2 got 0xE102 (product id readable)
};

/// TCA9548A emulation: one control register = channel mask.
class FakeMux : public I2cDevice {
public:
    bool on_write(const uint8_t* data, uint8_t n) override;
    bool on_read(uint8_t* out, uint8_t n) override;
    uint8_t mask = 0;
};

/// BME280 emulation (register file, normal mode).
class FakeBme280 : public I2cDevice {
public:
    FakeBme280();
    bool on_write(const uint8_t* data, uint8_t n) override;
    bool on_read(uint8_t* out, uint8_t n) override;
    /// Raw ADC values the "sensor" reports (defaults: datasheet example + 30000 for RH).
    void set_raw(int32_t adc_T, int32_t adc_P, int32_t adc_H);

private:
    uint8_t regs_[256] = {};
    uint8_t pointer_ = 0;
};

/// HX711 emulation driven by the firmware's SCK pulses.
struct FakeHx711 {
    uint8_t dout_pin = 0;
    uint8_t sck_pin = 0;
    int32_t counts = 0;           // value of the next conversion (24-bit two's complement)
    bool connected = true;
    uint64_t period_us = 12500;   // 80 samples/s
    // internal state
    uint64_t next_ready_us = 0;
    int pulses = 0;
    bool shifting = false;
    int dout_level = 1;
    uint32_t shift_value = 0;
    int conversions = 0;
};

/// One captured CAN frame.
struct CanFrame {
    uint64_t t_us;
    uint32_t id;
    uint8_t data[8];
};

/// The whole emulated board.
struct World {
    std::map<uint8_t, std::shared_ptr<I2cDevice>> main_bus;           // address -> device
    std::map<int, std::map<uint8_t, std::shared_ptr<I2cDevice>>> mux_bus;  // channel -> address -> device
    std::shared_ptr<FakeMux> mux;                                     // nullptr = no mux fitted
    uint8_t mux_address = 0x70;
    std::map<uint8_t, int> analog;                                    // pin -> counts
    std::vector<FakeHx711> hx711;
    std::string serial;                                               // everything printed
    std::vector<CanFrame> can;                                        // everything sent
    bool can_started = false;
    uint64_t i2c_transfers = 0;
};

World& world();

/// Devices that answer `address` right now (main bus + enabled mux channels).
std::vector<I2cDevice*> devices_at(uint8_t address);

}  // namespace sim
