// avcore - converting raw ADC counts into engineering units (linear pots, HX711 load cells).
//
// Both sensors are linear: physical = (counts - zero_counts) * units_per_count. What makes
// them trustworthy in a car is the PLAUSIBILITY check around that line:
//   * a linear potentiometer is wired so that its full mechanical travel uses only part of
//     the ADC range (e.g. 5 % .. 95 %), with a pull-down on the wiper; a broken wire or a
//     shorted connector then reads outside that window and is reported as "no value" (NaN)
//     instead of as a believable damper position - the same idea as the out-of-range
//     diagnostics of automotive sensors (e.g. 0.25 V .. 4.75 V on a 5 V supply);
//   * an HX711 24-bit load-cell ADC returns its most positive/negative code when the input
//     is overloaded or a bridge wire is open: those codes are reported as NaN too.
#pragma once

#include <stdint.h>

namespace av {

// ---- Linear potentiometer (damper position) ----------------------------------------------

/// Calibration of one linear potentiometer.
struct LinearPotCal {
    float zero_counts;      // ADC reading at the reference position (e.g. static ride height)
    float mm_per_count;     // stroke per ADC count; negative if the pot is mounted reversed
    uint16_t valid_min;     // readings below this are a wiring fault -> NaN
    uint16_t valid_max;     // readings above this are a wiring fault -> NaN
};

/// Two-point calibration: the pot reads `counts_a` at `mm_a` and `counts_b` at `mm_b`
/// (e.g. measured with a vernier at full droop and at a spacer block). The zero is placed
/// at 0 mm, so a damper channel reads "compression from the reference, + = bump".
LinearPotCal linear_pot_two_point(float counts_a, float mm_a, float counts_b, float mm_b,
                                  uint16_t valid_min, uint16_t valid_max);

/// ADC counts -> mm; NaN outside [valid_min, valid_max].
float linear_pot_mm(const LinearPotCal& cal, uint16_t counts);

// ---- HX711 load cell ---------------------------------------------------------------------

/// HX711 saturation codes (24-bit two's complement).
constexpr int32_t kHx711Max = 0x7FFFFF;
constexpr int32_t kHx711Min = -0x800000;

/// Calibration of one load cell: force = (counts - tare_counts) * newtons_per_count.
struct Hx711Cal {
    int32_t tare_counts;        // reading with no load (wing mounted, car stationary)
    float newtons_per_count;    // from a known mass: g * kg / (counts_loaded - tare_counts)
};

/// The 24 data bits clocked out of an HX711 -> signed counts (two's complement).
int32_t hx711_sign_extend(uint32_t raw24);

/// Newtons per count from a reference load: hang `mass_kg` and read `counts_loaded`.
float hx711_scale_from_reference(int32_t tare_counts, int32_t counts_loaded, float mass_kg);

/// Counts -> newtons; NaN at the saturation codes (overload / open bridge).
float hx711_newtons(const Hx711Cal& cal, int32_t counts);

/// Standard gravity, m/s^2 (ISO 80000-3).
constexpr float kStandardGravity = 9.80665f;

}  // namespace av
