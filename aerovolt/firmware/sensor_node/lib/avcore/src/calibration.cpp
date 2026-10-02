// avcore - ADC counts -> engineering units. See calibration.h.
#include "calibration.h"

#include "av_math.h"

namespace av {

LinearPotCal linear_pot_two_point(float counts_a, float mm_a, float counts_b, float mm_b,
                                  uint16_t valid_min, uint16_t valid_max) {
    LinearPotCal cal{0.0f, 0.0f, valid_min, valid_max};
    if (counts_b == counts_a) return cal;  // degenerate: no slope -> every reading becomes 0 mm
    // Straight line through both points: mm = (counts - zero) * slope with mm(zero) = 0.
    cal.mm_per_count = (mm_b - mm_a) / (counts_b - counts_a);
    cal.zero_counts = counts_a - mm_a / cal.mm_per_count;
    return cal;
}

float linear_pot_mm(const LinearPotCal& cal, uint16_t counts) {
    if (counts < cal.valid_min || counts > cal.valid_max) return kNaN;
    return (static_cast<float>(counts) - cal.zero_counts) * cal.mm_per_count;
}

int32_t hx711_sign_extend(uint32_t raw24) {
    raw24 &= 0xFFFFFFu;
    // Bit 23 is the sign bit: subtract 2^24 for negative readings.
    return (raw24 & 0x800000u) ? static_cast<int32_t>(raw24) - 0x1000000 : static_cast<int32_t>(raw24);
}

float hx711_scale_from_reference(int32_t tare_counts, int32_t counts_loaded, float mass_kg) {
    const int32_t delta = counts_loaded - tare_counts;
    if (delta == 0) return kNaN;
    return mass_kg * kStandardGravity / static_cast<float>(delta);
}

float hx711_newtons(const Hx711Cal& cal, int32_t counts) {
    if (counts >= kHx711Max || counts <= kHx711Min) return kNaN;
    return static_cast<float>(counts - cal.tare_counts) * cal.newtons_per_count;
}

}  // namespace av
