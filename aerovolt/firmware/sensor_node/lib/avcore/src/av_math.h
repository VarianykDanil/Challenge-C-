// avcore - portable C++17 core of the AeroVolt sensor node (no Arduino dependency).
//
// av_math.h: the few numeric helpers every other module needs. They are written by hand
// instead of using <cmath> because the same code must build with avr-gcc for the
// ATmega328P (Arduino Nano), whose toolchain has no C++ standard library - only the C
// headers of avr-libc (<math.h>, <stdint.h>).
#pragma once

#include <math.h>
#include <stdint.h>

namespace av {

/// Quiet NaN: "value not available" everywhere in the firmware (sent as SNA on CAN and
/// as `nan` in $AV lines).
constexpr float kNaN = NAN;

/// True for NaN. IEEE-754 defines NaN as the only value that is not equal to itself.
/// (This breaks under -ffast-math, which the firmware never uses.)
inline bool is_nan(double x) { return x != x; }

/// True for an ordinary number (not NaN, not +-infinity): inf - inf is NaN.
inline bool is_finite(double x) { return !is_nan(x) && !is_nan(x - x); }

/// Round to the nearest integer, ties to EVEN ("banker's rounding").
///
/// This is IEEE-754 roundTiesToEven - what Python's round(), cantools' encoder and
/// std::nearbyint (default rounding mode) do - so the firmware, the DBC tools and the
/// Python side produce bit-identical CAN frames:
///     2.5 -> 2,  3.5 -> 4,  -2.5 -> -2,  2.4999 -> 2,  2.5001 -> 3.
/// Round-half-away-from-zero (the C library's round()) would differ on exact ties such as
/// 12.5 Pa at a 1 Pa scale.
///
/// How: f = floor(x) and diff = x - f in [0, 1). For |x| >= 1 the subtraction is exact
/// (both are multiples of x's last bit); for -1 < x < 0 it can round, but only so far that
/// a value just above -0.5 looks like a tie, and the tie rule (f = -1 is odd -> f + 1 = 0)
/// then still gives the right answer. The host tests compare it with std::nearbyint.
inline double round_half_even(double x) {
    if (!is_finite(x)) return x;
    const double f = floor(x);
    const double diff = x - f;
    if (diff > 0.5) return f + 1.0;
    if (diff < 0.5) return f;
    return (fmod(f, 2.0) == 0.0) ? f : f + 1.0;  // exactly half-way: take the even one
}

/// Clamp `x` into [lo, hi].
template <typename T>
constexpr T clamp(T x, T lo, T hi) {
    return x < lo ? lo : (x > hi ? hi : x);
}

}  // namespace av
