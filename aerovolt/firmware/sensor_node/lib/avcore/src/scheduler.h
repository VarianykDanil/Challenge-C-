// avcore - a tiny cooperative scheduler for periodic jobs (CAN messages, sensor reads).
//
// Each CAN message has a cycle time (cycle_ms in aerovolt_can.h, e.g. 20 ms = 50 Hz).
// A CycleTimer answers "is it time to send this message again?" from the millisecond
// counter, without blocking and without delay():
//
//   * Wrap-around safe: millis() overflows every 2^32 ms = 49.7 days. Comparing
//     (int32_t)(now - deadline) >= 0 instead of now >= deadline stays correct across the
//     overflow (modular arithmetic), as long as deadlines are less than 24.8 days ahead.
//   * Drift free: the next deadline is the previous deadline + period (not now + period),
//     so a 20 ms message really averages 50 Hz even if loop() is a bit late every time.
//   * No bursts: if the loop stalled for more than a whole period (e.g. a blocking sensor
//     read), the timer re-synchronises to now instead of firing several times in a row to
//     "catch up" - flooding the bus with stale copies helps nobody.
//   * Phase: timers can start with an offset so that messages with the same period are
//     spread out instead of all being queued in the same millisecond.
#pragma once

#include <stdint.h>

namespace av {

class CycleTimer {
public:
    CycleTimer() = default;
    CycleTimer(uint32_t period_ms, uint32_t phase_ms = 0) : period_(period_ms), phase_(phase_ms) {}

    /// Change the period (takes effect from the next deadline).
    void set_period(uint32_t period_ms) { period_ = period_ms; }
    uint32_t period() const { return period_; }

    /// True once per period. The first call at time t schedules the first firing at
    /// t + phase (fires immediately when phase is 0).
    bool due(uint32_t now_ms) {
        if (period_ == 0) return false;  // disabled
        if (!started_) {
            started_ = true;
            next_ = now_ms + phase_;
        }
        if (static_cast<int32_t>(now_ms - next_) < 0) return false;
        next_ += period_;
        if (static_cast<int32_t>(now_ms - next_) >= 0) next_ = now_ms + period_;  // stalled: resync
        return true;
    }

    /// Next deadline (valid after the first call of due()).
    uint32_t next_deadline() const { return next_; }

    /// Start over: the next call of due() behaves like the very first one.
    void restart() { started_ = false; }

private:
    uint32_t period_ = 0;
    uint32_t phase_ = 0;
    uint32_t next_ = 0;
    bool started_ = false;
};

}  // namespace av
