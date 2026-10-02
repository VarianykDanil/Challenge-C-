// Host tests: first-order low-pass, moving average, cycle timer (lib/avcore/src).
#include <cmath>
#include <cstdint>

#include "check.h"
#include "filters.h"
#include "scheduler.h"

TEST(lowpass_step_response) {
    const float dt = 0.001f, tau = 0.020f;
    av::LowPass1 lp(tau, dt);
    CHECK_NEAR(lp.alpha(), dt / (tau + dt), 1e-9);
    CHECK(std::isnan(lp.value()));
    lp.update(0.0f);
    float y = 0.0f;
    for (int i = 0; i < 20; ++i) y = lp.update(1.0f);  // one time constant
    CHECK_NEAR(y, 1.0 - std::exp(-1.0), 0.02);         // ~63 %
    for (int i = 0; i < 200; ++i) y = lp.update(1.0f);
    CHECK_NEAR(y, 1.0, 1e-4);
    CHECK_NEAR(lp.update(NAN), y, 0);                   // NaN skipped
    av::LowPass1 pass(0.0f, dt);                        // tau 0 = no filtering
    CHECK_NEAR(pass.update(5.0f), 5.0, 0);
    CHECK_NEAR(pass.update(-3.0f), -3.0, 0);
    av::LowPass1 first(1.0f, 0.01f);                    // first sample initialises the state
    CHECK_NEAR(first.update(42.0f), 42.0, 0);
    first.reset();
    CHECK(std::isnan(first.value()));
}

TEST(moving_average) {
    av::MovingAverage<4> ma;
    CHECK(std::isnan(ma.value()));
    CHECK_NEAR(ma.update(1.0f), 1.0, 1e-6);
    CHECK_NEAR(ma.update(3.0f), 2.0, 1e-6);
    ma.update(5.0f);
    CHECK_NEAR(ma.update(7.0f), 4.0, 1e-6);
    CHECK(ma.full());
    CHECK_NEAR(ma.update(9.0f), 6.0, 1e-6);  // oldest (1) dropped
    CHECK_NEAR(ma.update(NAN), 6.0, 1e-6);   // NaN skipped
    CHECK_EQ(ma.count(), 4);
    ma.reset();
    CHECK(std::isnan(ma.value()));
    av::MovingAverage<8> drift;  // float round-off does not accumulate
    for (int i = 0; i < 1000000; ++i) drift.update(i % 2 ? 1000.1f : -999.9f);
    CHECK_NEAR(drift.value(), 0.1, 1e-3);
}

TEST(cycle_timer_basic) {
    av::CycleTimer t(20);
    CHECK(t.due(1000));   // fires immediately the first time
    CHECK(!t.due(1001));
    CHECK(!t.due(1019));
    CHECK(t.due(1020));
    CHECK(t.due(1045));   // a little late ...
    CHECK(!t.due(1059));
    CHECK(t.due(1060));   // ... but no drift: deadlines stay on the 20 ms grid
    int fired = 0;
    for (uint32_t ms = 2000; ms < 3000; ++ms) fired += t.due(ms) ? 1 : 0;
    CHECK_EQ(fired, 50);  // exactly 50 Hz
}

TEST(cycle_timer_phase_and_disable) {
    av::CycleTimer t(100, 30);
    CHECK(!t.due(0));
    CHECK(!t.due(29));
    CHECK(t.due(30));
    CHECK(t.due(130));
    av::CycleTimer off(0);
    CHECK(!off.due(0));
    CHECK(!off.due(1000));
    t.restart();
    CHECK(!t.due(500));
    CHECK(t.due(530));
}

TEST(cycle_timer_millis_wraparound) {
    av::CycleTimer t(20);
    uint32_t ms = 0xFFFFFF00u;  // 256 ms before millis() overflows (after 49.7 days)
    int fired = 0;
    for (int i = 0; i < 1000; ++i, ++ms) fired += t.due(ms) ? 1 : 0;
    CHECK_EQ(fired, 50);
}

TEST(cycle_timer_stall_resyncs_without_burst) {
    av::CycleTimer t(10);
    CHECK(t.due(0));
    CHECK(t.due(500));    // loop stalled for 500 ms: fire once ...
    CHECK(!t.due(501));   // ... not 49 more times
    CHECK(!t.due(509));
    CHECK(t.due(510));
}
