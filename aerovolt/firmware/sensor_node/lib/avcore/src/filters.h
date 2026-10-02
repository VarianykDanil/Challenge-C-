// avcore - small digital filters (no heap: fixed-size state only).
//
// LowPass1 - first-order low-pass ("RC filter" in software):
//     y[n] = y[n-1] + alpha * (x[n] - y[n-1]),   alpha = dt / (tau + dt)
//   This is the backward-Euler discretisation of  tau * dy/dt + y = x : the step response
//   reaches 63 % after tau seconds and the -3 dB cut-off is fc = 1 / (2 pi tau).
//   Example: tau = 20 ms -> fc ~ 8 Hz, a sensible smoothing for a 50 Hz load-cell channel.
//
// MovingAverage<N> - mean of the last N samples (a boxcar FIR filter). Used to average
//   oversampled ADC readings (e.g. 4 pot readings at 400 Hz -> one 100 Hz damper value),
//   which lowers noise by sqrt(N) and suppresses frequencies near the output rate.
//
// Both skip NaN inputs (a missing sample must not poison the state) and report NaN until
// they have seen a valid sample.
#pragma once

#include <stdint.h>

#include "av_math.h"

namespace av {

class LowPass1 {
public:
    /// A pass-through filter until set_time_constant() is called.
    LowPass1() = default;

    /// tau_s: time constant (s); dt_s: sample interval (s). tau = 0 passes x through.
    LowPass1(float tau_s, float dt_s) { set_time_constant(tau_s, dt_s); }

    void set_time_constant(float tau_s, float dt_s) {
        alpha_ = (tau_s <= 0.0f || dt_s <= 0.0f) ? 1.0f : dt_s / (tau_s + dt_s);
    }

    /// Feed one sample, return the filtered value (the first valid sample initialises the
    /// state, so the output does not ramp up from zero).
    float update(float x) {
        if (is_nan(x)) return value();
        if (!primed_) {
            y_ = x;
            primed_ = true;
        } else {
            y_ += alpha_ * (x - y_);
        }
        return y_;
    }

    float value() const { return primed_ ? y_ : kNaN; }
    float alpha() const { return alpha_; }
    void reset() { primed_ = false; }

private:
    float alpha_ = 1.0f;
    float y_ = 0.0f;
    bool primed_ = false;
};

template <uint8_t N>
class MovingAverage {
    static_assert(N >= 1, "MovingAverage needs at least one sample");

public:
    /// Add a sample and return the mean of the last (up to) N valid samples.
    float update(float x) {
        if (is_nan(x)) return value();
        if (count_ == N) sum_ -= buf_[index_];  // drop the oldest sample
        buf_[index_] = x;
        sum_ += x;
        index_ = static_cast<uint8_t>((index_ + 1) % N);
        if (count_ < N) ++count_;
        if (index_ == 0) resum();  // once per N samples: remove float round-off drift
        return value();
    }

    float value() const { return count_ == 0 ? kNaN : sum_ / static_cast<float>(count_); }
    uint8_t count() const { return count_; }
    bool full() const { return count_ == N; }
    void reset() {
        count_ = 0;
        index_ = 0;
        sum_ = 0.0f;
    }

private:
    void resum() {
        sum_ = 0.0f;
        for (uint8_t i = 0; i < count_; ++i) sum_ += buf_[i];
    }

    float buf_[N] = {};
    float sum_ = 0.0f;
    uint8_t index_ = 0;
    uint8_t count_ = 0;
};

}  // namespace av
