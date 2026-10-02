// Minimal unit-test helpers for the host tests (no external test framework needed).
//
//   TEST(name) { CHECK(cond); CHECK_EQ(a, b); CHECK_NEAR(a, b, tol); CHECK_STR(a, b); }
//   int main() { return run_all_tests(); }
//
// Each failed check prints file:line and the values; the program exits non-zero if any
// check failed, which makes `make test` fail.
#pragma once

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace check {

struct Registry {
    std::vector<std::pair<std::string, std::function<void()>>> tests;
    int failures = 0;
    int checks = 0;
    static Registry& get() {
        static Registry r;
        return r;
    }
};

struct Register {
    Register(const char* name, std::function<void()> fn) { Registry::get().tests.emplace_back(name, fn); }
};

inline void fail(const char* file, int line, const std::string& what) {
    ++Registry::get().failures;
    std::printf("  FAIL %s:%d: %s\n", file, line, what.c_str());
}

template <typename A, typename B>
void check_eq(const A& a, const B& b, const char* ea, const char* eb, const char* file, int line) {
    ++Registry::get().checks;
    if (!(a == b)) {
        fail(file, line, std::string(ea) + " == " + eb + "  (" + std::to_string(a) + " vs " + std::to_string(b) + ")");
    }
}

inline void check_near(double a, double b, double tol, const char* ea, const char* eb, const char* file, int line) {
    ++Registry::get().checks;
    const bool both_nan = std::isnan(a) && std::isnan(b);
    if (!both_nan && !(std::fabs(a - b) <= tol)) {
        char buf[256];
        std::snprintf(buf, sizeof buf, "%s ~= %s  (%.9g vs %.9g, tol %.3g)", ea, eb, a, b, tol);
        fail(file, line, buf);
    }
}

inline void check_str(const std::string& a, const std::string& b, const char* ea, const char* eb, const char* file, int line) {
    ++Registry::get().checks;
    if (a != b) fail(file, line, std::string(ea) + " == " + eb + "  (\"" + a + "\" vs \"" + b + "\")");
}

inline int run_all_tests() {
    auto& r = Registry::get();
    for (auto& [name, fn] : r.tests) {
        const int before = r.failures;
        fn();
        std::printf("%s %s\n", r.failures == before ? "ok  " : "FAIL", name.c_str());
    }
    std::printf("%zu tests, %d checks, %d failures\n", r.tests.size(), r.checks, r.failures);
    return r.failures == 0 ? 0 : 1;
}

}  // namespace check

#define TEST(name)                                              \
    static void name();                                         \
    static check::Register name##_registration(#name, name);    \
    static void name()

#define CHECK(cond)                                                              \
    do {                                                                         \
        ++check::Registry::get().checks;                                         \
        if (!(cond)) check::fail(__FILE__, __LINE__, #cond);                     \
    } while (0)
#define CHECK_EQ(a, b) check::check_eq((a), (b), #a, #b, __FILE__, __LINE__)
#define CHECK_NEAR(a, b, tol) check::check_near((a), (b), (tol), #a, #b, __FILE__, __LINE__)
#define CHECK_STR(a, b) check::check_str((a), (b), #a, #b, __FILE__, __LINE__)
