// A fixed-size text builder for status messages (no heap, no printf - works on the Nano).
//
//   Text<48> t;
//   t.add(channel).add(F(": no answer at 0x")).add_hex(0x25).add(F(" (mux ")).add_uint(2).add(F(")"));
//   writer.status(node, ms, av::NodeStatus::kError, t.c_str());
//
// Fixed texts are wrapped in Arduino's F() macro: on the ATmega328P a plain "string
// literal" is copied into the 2 KB of RAM at start-up, while F("...") stays in the 32 KB of
// flash and is read byte by byte with pgm_read_byte(). (On Teensy / ESP32 F() costs nothing.)
// Text that does not fit is cut off and marked with "~" at the end.
#pragma once

#include <Arduino.h>  // F(), __FlashStringHelper, pgm_read_byte()
#include <stddef.h>
#include <stdint.h>

template <size_t N>
class Text {
    static_assert(N >= 4, "Text needs room for at least a few characters");

public:
    Text() { buf_[0] = '\0'; }

    /// Append text that lives in RAM (e.g. a channel id).
    Text& add(const char* s) {
        while (*s != '\0') put(*s++);
        return *this;
    }

    /// Append a fixed text kept in flash: t.add(F("..."))
    Text& add(const __FlashStringHelper* s) {
        const char* p = reinterpret_cast<const char*>(s);
        for (char c = static_cast<char>(pgm_read_byte(p)); c != '\0'; c = static_cast<char>(pgm_read_byte(++p))) put(c);
        return *this;
    }

    Text& add_uint(uint32_t v) {
        char digits[10];
        uint8_t n = 0;
        do {
            digits[n++] = static_cast<char>('0' + v % 10u);
            v /= 10u;
        } while (v != 0u);
        while (n > 0) put(digits[--n]);
        return *this;
    }

    Text& add_int(int32_t v) {
        if (v < 0) {
            put('-');
            return add_uint(static_cast<uint32_t>(-(v + 1)) + 1u);
        }
        return add_uint(static_cast<uint32_t>(v));
    }

    Text& add_hex(uint8_t v) {
        static const char kHex[] = "0123456789ABCDEF";
        put(kHex[v >> 4]);
        put(kHex[v & 0x0F]);
        return *this;
    }

    const char* c_str() const { return buf_; }
    size_t size() const { return len_; }
    bool empty() const { return len_ == 0; }

private:
    void put(char c) {
        if (len_ + 1 < N) {
            buf_[len_++] = c;
            buf_[len_] = '\0';
        } else {
            buf_[N - 2] = '~';  // mark the truncation
        }
    }

    char buf_[N];
    size_t len_ = 0;
};
