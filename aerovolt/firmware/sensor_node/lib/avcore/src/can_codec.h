// avcore - CAN signal packing / unpacking for the AeroVolt bus (SPEC section 7.3).
//
// The bus layout (message ids, signal start bits, lengths, scales, offsets) is NOT written
// here: it comes from include/aerovolt_can.h, which tools/gen_can.py generates from
// config/can_layout.yaml - the same file the DBC (can/aerovolt.dbc) is generated from.
// This file only knows the rules, and they are the rules cantools applies to the DBC:
//
//   * Intel byte order (little-endian): signal bit i is frame bit (start_bit + i), and frame
//     bit b lives in byte b / 8 at bit position b % 8. A 16-bit signal at start bit 32
//     therefore occupies bytes 4 (low byte) and 5 (high byte).
//   * physical = raw * scale + offset           (decoding)
//     raw = round_half_even((physical - offset) / scale)   (encoding, in double precision,
//     exactly cantools' `round((value - offset) / scale)`)
//   * Signed signals are two's complement.
//   * SNA ("signal not available"): signed -> most negative raw (0x8000 for 16 bit),
//     unsigned -> all ones (0xFFFF). A value that is out of range is SATURATED to the
//     largest/smallest valid raw value - never wrapped around, and never turned into SNA by
//     accident (raw_min/raw_max exclude the SNA code). NaN (no reading) is sent as SNA.
//   * 1-bit flags have no SNA (all ones would mean "true"); a missing flag is sent as 0.
//   * Every frame is 8 bytes; bits no signal uses are 0.
//
// Signals may start at any bit and be 1..32 bits long.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "aerovolt_can.h"

namespace av {

using aerovolt::can::MessageDef;
using aerovolt::can::SignalDef;

/// Bytes in every AeroVolt CAN frame (classic CAN, DLC 8).
constexpr uint8_t kFrameBytes = 8;

/// Longest signal this codec packs (SPEC: <= 32 bit).
constexpr uint8_t kMaxSignalBits = 32;

// ---- Bit fields ------------------------------------------------------------------------

/// Write the low `length` bits of `raw` into `data` at Intel `start_bit`; other bits are
/// left unchanged. Returns false (and writes nothing) if the field does not fit in 8 bytes.
bool insert_bits(uint8_t data[kFrameBytes], uint8_t start_bit, uint8_t length, uint32_t raw);

/// Read `length` bits at Intel `start_bit` as an unsigned number (0 if it does not fit).
uint32_t extract_bits(const uint8_t data[kFrameBytes], uint8_t start_bit, uint8_t length);

/// Interpret the low `length` bits of `bits` as a two's-complement number.
int32_t sign_extend(uint32_t bits, uint8_t length);

// ---- Physical <-> raw ------------------------------------------------------------------

/// Physical value -> raw integer: round half to even, saturate to [raw_min, raw_max];
/// NaN / infinity -> SNA (or 0 for a 1-bit flag, which has no SNA).
int64_t physical_to_raw(const SignalDef& signal, double physical);

/// Raw integer (sign-extended for signed signals) -> physical value; SNA -> NaN.
double raw_to_physical(const SignalDef& signal, int64_t raw);

// ---- Signals and frames ----------------------------------------------------------------

/// Encode one physical value into its field of `data`.
void encode_signal(const SignalDef& signal, double physical, uint8_t data[kFrameBytes]);

/// Decode one signal of `data`; NaN if it carries SNA.
double decode_signal(const SignalDef& signal, const uint8_t data[kFrameBytes]);

/// Start a frame: all bits 0, then every signal that has an SNA code set to SNA.
/// A node that owns only some signals of a message calls this first and then fills in its
/// own signals - the others stay SNA, so receivers ignore them (SPEC 7.3).
void fill_sna(const MessageDef& message, uint8_t data[kFrameBytes]);

/// Encode `physical` into the signal called `channel` (== channel id) of `message`.
/// Returns false if the message has no such signal.
bool set_channel(const MessageDef& message, const char* channel, double physical,
                 uint8_t data[kFrameBytes]);

}  // namespace av
