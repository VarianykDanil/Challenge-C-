// Driver for Sensirion SDP3x / SDP8xx differential-pressure sensors. See sdp.h.
#include "sdp.h"

#include <Arduino.h>
#include <Wire.h>

#include "i2c.h"

bool SdpSensor::find_address() {
    if (configured_address_ != 0) {
        address_ = configured_address_;
        return i2c::probe(address_);
    }
    for (uint8_t candidate : av::kSdpAddresses) {
        if (i2c::probe(candidate)) {
            address_ = candidate;
            return true;
        }
    }
    address_ = 0;
    return false;
}

bool SdpSensor::read_product_id() {
    // Two-part command, then 18 bytes; only allowed while no measurement is running.
    if (!i2c::write_command16(address_, av::kSdpCmdProductId1)) return false;
    if (!i2c::write_command16(address_, av::kSdpCmdProductId2)) return false;
    uint8_t rx[av::kSdpProductIdBytes];
    if (!i2c::read_bytes(address_, rx, sizeof rx)) return false;
    return av::sdp_parse_product_id(rx, product_) == av::SdpStatus::kOk;
}

bool SdpSensor::begin(uint32_t now_ms) {
    if (!find_address()) return false;
    stop();    // the MCU may have rebooted while the sensor kept measuring
    delay(1);  // >= 0.5 ms after the stop command before the next command (datasheet)
    if (!read_product_id()) return false;
    if (!i2c::write_command16(address_, av::kSdpCmdContinuousDpAverage)) return false;
    started_ms_ = now_ms;
    return true;
}

bool SdpSensor::stop() { return address_ != 0 && i2c::write_command16(address_, av::kSdpCmdStopContinuous); }

SdpSensor::Result SdpSensor::read(uint32_t now_ms, av::SdpMeasurement& out) {
    uint8_t rx[av::kSdpMeasurementBytes];
    if (address_ == 0 || !i2c::read_bytes(address_, rx, sizeof rx)) {
        // Right after the start command the sensor NACKs until its first result is ready.
        return (address_ != 0 && now_ms - started_ms_ < kWarmUpMs) ? Result::kWarmingUp : Result::kNoAnswer;
    }
    switch (av::sdp_parse_measurement(rx, out)) {
        case av::SdpStatus::kOk:
            return Result::kOk;
        case av::SdpStatus::kCrcError:
            return Result::kCrcError;
        case av::SdpStatus::kBadScale:
        default:
            return Result::kBadData;
    }
}

void SdpSensor::general_call_reset() {
    Wire.beginTransmission(av::kI2cGeneralCallAddress);
    Wire.write(av::kSdpSoftResetByte);
    Wire.endTransmission();
    delay(25);  // reset time (datasheet: < 20 ms)
}
