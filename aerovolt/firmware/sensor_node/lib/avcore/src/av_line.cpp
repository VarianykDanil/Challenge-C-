// avcore - AeroVolt serial line protocol writer. See av_line.h.
#include "av_line.h"

#include "av_math.h"

namespace av {

// ---- BufferSink ------------------------------------------------------------------------

BufferSink::BufferSink(char* buffer, size_t capacity) : buffer_(buffer), capacity_(capacity) {
    clear();
}

void BufferSink::put(char c) {
    if (capacity_ == 0) {
        overflow_ = true;
        return;
    }
    if (size_ + 1 >= capacity_) {  // keep room for the NUL
        overflow_ = true;
        return;
    }
    buffer_[size_++] = c;
    buffer_[size_] = '\0';
}

void BufferSink::clear() {
    size_ = 0;
    overflow_ = false;
    if (capacity_ > 0) buffer_[0] = '\0';
}

// ---- Free functions --------------------------------------------------------------------

uint8_t nmea_checksum(const char* text) {
    uint8_t cs = 0;
    while (*text != '\0') cs ^= static_cast<uint8_t>(*text++);
    return cs;
}

size_t format_fixed(char* out, size_t capacity, double value, uint8_t decimals) {
    // Work in integers: value * 10^decimals, rounded, then print the digits and put the
    // decimal point back. Printing a float with printf("%f") is avoided on purpose: the
    // AVR C library leaves float support out of printf by default.
    if (capacity == 0) return 0;
    if (decimals > 6) decimals = 6;
    double scale = 1.0;
    for (uint8_t i = 0; i < decimals; ++i) scale *= 10.0;

    const double scaled = is_finite(value) ? round_half_even(value * scale) : value;
    const double kMaxExact = 9007199254740992.0;  // 2^53: doubles are exact integers below
    char tmp[24];
    size_t n = 0;
    if (!is_finite(scaled) || scaled > kMaxExact || scaled < -kMaxExact) {
        tmp[n++] = 'n';
        tmp[n++] = 'a';
        tmp[n++] = 'n';
    } else {
        const bool negative = scaled < 0.0;  // -0.04 rounds to 0 -> printed as "0.0"
        uint64_t magnitude = static_cast<uint64_t>(negative ? -scaled : scaled);
        char digits[20];
        uint8_t count = 0;
        do {  // least significant digit first
            digits[count++] = static_cast<char>('0' + magnitude % 10u);
            magnitude /= 10u;
        } while (magnitude != 0u || count <= decimals);  // at least one digit before the point
        if (negative) tmp[n++] = '-';
        while (count > 0) {
            if (count == decimals) tmp[n++] = '.';
            tmp[n++] = digits[--count];
        }
    }
    size_t written = 0;
    for (; written < n && written + 1 < capacity; ++written) out[written] = tmp[written];
    out[written] = '\0';
    return written;
}

const char* status_word(NodeStatus status) {
    switch (status) {
        case NodeStatus::kOk:
            return "ok";
        case NodeStatus::kWarn:
            return "warn";
        case NodeStatus::kError:
        default:
            return "error";
    }
}

// ---- AvWriter --------------------------------------------------------------------------

void AvWriter::start(const char* tag) {
    sink_.put('$');  // '$' itself is not part of the checksum
    checksum_ = 0;
    payload_text(tag);
}

void AvWriter::payload(char c) {
    checksum_ ^= static_cast<uint8_t>(c);
    sink_.put(c);
}

void AvWriter::payload_text(const char* text) {
    while (*text != '\0') payload(*text++);
}

void AvWriter::payload_token(const char* text) {
    if (*text == '\0') {
        payload('_');  // an empty field would shift every following field
        return;
    }
    for (; *text != '\0'; ++text) {
        const char c = *text;
        const bool separator = c == ',' || c == '*' || c == '$' || c == ' ' || c == '\t' ||
                               c == '\r' || c == '\n';
        payload(separator ? '_' : c);
    }
}

void AvWriter::payload_uint(uint32_t value) {
    char digits[10];
    uint8_t count = 0;
    do {
        digits[count++] = static_cast<char>('0' + value % 10u);
        value /= 10u;
    } while (value != 0u);
    while (count > 0) payload(digits[--count]);
}

void AvWriter::begin_data(const char* node, uint32_t ms) {
    start("AV,");
    payload_token(node);
    payload(',');
    payload_uint(ms);
}

void AvWriter::add_value(const char* channel, double value, uint8_t decimals) {
    char number[24];
    format_fixed(number, sizeof number, value, decimals);
    payload(',');
    payload_token(channel);
    payload('=');
    payload_text(number);
}

void AvWriter::begin_hello(const char* node, const char* fw_version) {
    start("AVH,");
    payload_token(node);
    payload(',');
    payload_token(fw_version);
}

void AvWriter::add_channel(const char* channel) {
    payload(',');
    payload_token(channel);
}

void AvWriter::status(const char* node, uint32_t ms, NodeStatus status, const char* message) {
    start("AVS,");
    payload_token(node);
    payload(',');
    payload_uint(ms);
    payload(',');
    payload_text(status_word(status));
    payload(',');
    for (const char* p = message; *p != '\0'; ++p) {
        const char c = *p;
        payload((c == '*' || c == '$' || c == '\r' || c == '\n') ? ' ' : c);
    }
    end();
}

void AvWriter::end() {
    static const char kHex[] = "0123456789ABCDEF";
    sink_.put('*');
    sink_.put(kHex[checksum_ >> 4]);
    sink_.put(kHex[checksum_ & 0x0F]);
    sink_.put('\r');
    sink_.put('\n');
}

}  // namespace av
