// avcore - CAN signal packing / unpacking. See can_codec.h for the rules.
#include "can_codec.h"

#include <string.h>

#include "av_math.h"

namespace av {

namespace {

/// True if a field of `length` bits starting at `start_bit` fits in one 8-byte frame.
bool field_fits(uint8_t start_bit, uint8_t length) {
    return length >= 1 && length <= kMaxSignalBits &&
           static_cast<unsigned>(start_bit) + length <= 8u * kFrameBytes;
}

}  // namespace

bool insert_bits(uint8_t data[kFrameBytes], uint8_t start_bit, uint8_t length, uint32_t raw) {
    if (!field_fits(start_bit, length)) return false;
    // Walk the field one bit at a time, LSB first: signal bit i -> frame bit start_bit + i.
    // A bit loop is slower than shifting a 64-bit word but it is obviously correct for any
    // start bit and length, and 8-byte frames make it cheap.
    for (uint8_t i = 0; i < length; ++i) {
        const unsigned bit = static_cast<unsigned>(start_bit) + i;
        const uint8_t mask = static_cast<uint8_t>(1u << (bit % 8u));
        if ((raw >> i) & 1u) {
            data[bit / 8u] |= mask;
        } else {
            data[bit / 8u] &= static_cast<uint8_t>(~mask);
        }
    }
    return true;
}

uint32_t extract_bits(const uint8_t data[kFrameBytes], uint8_t start_bit, uint8_t length) {
    if (!field_fits(start_bit, length)) return 0;
    uint32_t raw = 0;
    for (uint8_t i = 0; i < length; ++i) {
        const unsigned bit = static_cast<unsigned>(start_bit) + i;
        if ((data[bit / 8u] >> (bit % 8u)) & 1u) raw |= (uint32_t(1) << i);
    }
    return raw;
}

int32_t sign_extend(uint32_t bits, uint8_t length) {
    if (length == 0 || length >= 32) return static_cast<int32_t>(bits);
    const uint32_t sign = uint32_t(1) << (length - 1);
    const uint32_t mask = (uint32_t(1) << length) - 1u;
    bits &= mask;
    // (bits XOR sign) - sign maps 0..2^n-1 onto -2^(n-1)..2^(n-1)-1 (two's complement).
    return static_cast<int32_t>(static_cast<int64_t>(bits ^ sign) - static_cast<int64_t>(sign));
}

int64_t physical_to_raw(const SignalDef& signal, double physical) {
    if (!is_finite(physical)) {
        return signal.has_sna ? aerovolt::can::sna_raw(signal) : 0;
    }
    // Same expression, same evaluation order as cantools: (value - offset) / scale, in
    // IEEE double, then round half to even. Clamping happens on the double, BEFORE the
    // conversion to an integer, so huge values cannot overflow the cast.
    const double scaled = round_half_even((physical - signal.offset) / signal.scale);
    const double lo = static_cast<double>(aerovolt::can::raw_min(signal));
    const double hi = static_cast<double>(aerovolt::can::raw_max(signal));
    return static_cast<int64_t>(clamp(scaled, lo, hi));
}

double raw_to_physical(const SignalDef& signal, int64_t raw) {
    if (aerovolt::can::is_sna(signal, raw)) return kNaN;
    return static_cast<double>(raw) * signal.scale + signal.offset;
}

void encode_signal(const SignalDef& signal, double physical, uint8_t data[kFrameBytes]) {
    const int64_t raw = physical_to_raw(signal, physical);
    // Two's complement bit pattern of the raw value; insert_bits keeps the low `length` bits.
    insert_bits(data, signal.start_bit, signal.length, static_cast<uint32_t>(raw));
}

double decode_signal(const SignalDef& signal, const uint8_t data[kFrameBytes]) {
    const uint32_t bits = extract_bits(data, signal.start_bit, signal.length);
    const int64_t raw = signal.is_signed ? static_cast<int64_t>(sign_extend(bits, signal.length))
                                         : static_cast<int64_t>(bits);
    return raw_to_physical(signal, raw);
}

void fill_sna(const MessageDef& message, uint8_t data[kFrameBytes]) {
    memset(data, 0, kFrameBytes);
    for (uint8_t i = 0; i < message.signal_count; ++i) {
        const SignalDef& s = message.signals[i];
        if (s.has_sna) {
            insert_bits(data, s.start_bit, s.length,
                        static_cast<uint32_t>(aerovolt::can::sna_raw(s)));
        }
    }
}

bool set_channel(const MessageDef& message, const char* channel, double physical,
                 uint8_t data[kFrameBytes]) {
    const SignalDef* signal = aerovolt::can::find_signal(message, channel);
    if (signal == nullptr) return false;
    encode_signal(*signal, physical, data);
    return true;
}

}  // namespace av
