// avcore - the AeroVolt serial line protocol, sending side (SPEC section 7.1).
//
//   $AV,<node>,<ms>,<ch>=<value>[,<ch>=<value>...]*<CS>\r\n     data
//   $AVH,<node>,<fw_version>,<ch>[,<ch>...]*<CS>\r\n              hello (boot + every 5 s)
//   $AVS,<node>,<ms>,<status>,<message>*<CS>\r\n                  status (ok|warn|error)
//
// <CS> is the NMEA 0183 checksum: the XOR of every byte between '$' and '*', printed as two
// upper-case hex digits. Example: "$AV,N1,0,a=1*19" - XOR of the bytes of "AV,N1,0,a=1"
// is 0x19. The host (aerovolt/sources/protocol.py) drops any line whose checksum does not
// match, which catches the bit errors and lost characters of a noisy UART/USB link.
//
// The writer STREAMS characters into a sink while updating the checksum, so it needs no
// line buffer at all - important on the Arduino Nano (2 KB of RAM, no heap).
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace av {

/// Anything that accepts characters: the Arduino Serial port, or a buffer in tests.
/// (The destructor is protected and non-virtual on purpose: sinks are never deleted through
/// this interface, and avr-gcc then needs no operator delete.)
class CharSink {
public:
    virtual void put(char c) = 0;

protected:
    ~CharSink() = default;
};

/// A sink that writes into a fixed char array (always NUL-terminated, truncates when full).
class BufferSink final : public CharSink {
public:
    BufferSink(char* buffer, size_t capacity);
    void put(char c) override;
    void clear();
    const char* c_str() const { return buffer_; }
    size_t size() const { return size_; }
    bool overflowed() const { return overflow_; }

private:
    char* buffer_;
    size_t capacity_;
    size_t size_ = 0;
    bool overflow_ = false;
};

/// XOR of every byte of `text` (a NUL-terminated string): the NMEA checksum.
uint8_t nmea_checksum(const char* text);

/// Format `value` with exactly `decimals` digits after the point (0..6), e.g. -412.5 or
/// 101325, into `out` (capacity >= 24 is always enough). NaN, infinity and magnitudes too
/// big to print exactly (> 2^53 after scaling) give "nan". Rounding is half to even.
/// Returns the number of characters written (without the terminating NUL).
size_t format_fixed(char* out, size_t capacity, double value, uint8_t decimals);

/// Severity word of a $AVS status line.
enum class NodeStatus : uint8_t { kOk, kWarn, kError };

/// Text of a status word: "ok", "warn", "error".
const char* status_word(NodeStatus status);

/// Streams AeroVolt sentences into a CharSink, computing the checksum on the fly.
///
/// Usage (one data line):
///     AvWriter w(sink);
///     w.begin_data("AERO1", millis());
///     w.add_value("fw_p03", -412.53, 1);    // -> ",fw_p03=-412.5"
///     w.end();                               // -> "*CS\r\n"
///
/// Text fields (node name, firmware version) must not contain ',', '*', '$' or spaces;
/// such characters are replaced by '_' so that a typo in a config can never produce a line
/// the host cannot parse. In status messages '*', '$', CR and LF become spaces.
class AvWriter {
public:
    explicit AvWriter(CharSink& sink) : sink_(sink) {}

    /// "$AV,<node>,<ms>"
    void begin_data(const char* node, uint32_t ms);
    /// ",<channel>=<value>" with `decimals` digits after the point (NaN -> "nan").
    void add_value(const char* channel, double value, uint8_t decimals);

    /// "$AVH,<node>,<fw_version>"
    void begin_hello(const char* node, const char* fw_version);
    /// ",<channel>" (a channel announced in a hello line).
    void add_channel(const char* channel);

    /// A complete status line "$AVS,<node>,<ms>,<status>,<message>*CS\r\n".
    void status(const char* node, uint32_t ms, NodeStatus status, const char* message);

    /// "*CS\r\n" - finishes the current sentence.
    void end();

private:
    void start(const char* tag);           // '$' + tag (tag is part of the checksum)
    void payload(char c);                  // one checksummed character
    void payload_text(const char* text);   // checksummed text, verbatim
    void payload_token(const char* text);  // checksummed text, separators replaced by '_'
    void payload_uint(uint32_t value);

    CharSink& sink_;
    uint8_t checksum_ = 0;
};

}  // namespace av
