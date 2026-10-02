// Host tests: $AV serial line formatting and the NMEA checksum (lib/avcore/src/av_line).
#include <cmath>
#include <string>

#include "av_line.h"
#include "check.h"

namespace {

std::string fixed(double v, uint8_t decimals) {
    char buf[32];
    av::format_fixed(buf, sizeof buf, v, decimals);
    return buf;
}

}  // namespace

TEST(nmea_checksum_spec_example) {
    // SPEC 7.1 / protocol.py worked example: "$AV,N1,0,a=1*19".
    CHECK_EQ(av::nmea_checksum("AV,N1,0,a=1"), 0x19);
    CHECK_EQ(av::nmea_checksum(""), 0);
}

TEST(format_fixed_values) {
    CHECK_STR(fixed(-412.53, 1), "-412.5");
    CHECK_STR(fixed(-412.56, 1), "-412.6");
    CHECK_STR(fixed(18.4, 2), "18.40");
    CHECK_STR(fixed(101325.0, 0), "101325");
    CHECK_STR(fixed(0.5, 1), "0.5");
    CHECK_STR(fixed(0.04, 1), "0.0");
    CHECK_STR(fixed(-0.04, 1), "0.0");  // no "-0.0"
    CHECK_STR(fixed(-0.06, 1), "-0.1");
    CHECK_STR(fixed(2.5, 0), "2");      // ties to even, like everything else
    CHECK_STR(fixed(3.5, 0), "4");
    CHECK_STR(fixed(0.001, 3), "0.001");
    CHECK_STR(fixed(-7.0, 2), "-7.00");
    CHECK_STR(fixed(52.0786123, 6), "52.078612");
    CHECK_STR(fixed(1.0, 9), "1.000000");  // decimals are capped at 6
    CHECK_STR(fixed(NAN, 1), "nan");
    CHECK_STR(fixed(INFINITY, 1), "nan");
    CHECK_STR(fixed(1e300, 1), "nan");
    char small[4];
    CHECK_EQ(av::format_fixed(small, sizeof small, -412.5, 1), 3u);  // truncated, NUL kept
    CHECK_STR(std::string(small), "-41");
}

TEST(data_line_matches_spec_example) {
    char buf[128];
    av::BufferSink sink(buf, sizeof buf);
    av::AvWriter w(sink);
    w.begin_data("N1", 0);
    w.add_value("a", 1.0, 0);
    w.end();
    CHECK_STR(std::string(sink.c_str()), "$AV,N1,0,a=1*19\r\n");
}

TEST(data_line_several_values) {
    char buf[160];
    av::BufferSink sink(buf, sizeof buf);
    av::AvWriter w(sink);
    w.begin_data("BENCH", 123456);
    w.add_value("fw_p03", -412.53, 1);
    w.add_value("amb_temp", 18.4, 2);
    w.add_value("amb_rh", NAN, 1);
    w.end();
    const std::string line = sink.c_str();
    const std::string body = "AV,BENCH,123456,fw_p03=-412.5,amb_temp=18.40,amb_rh=nan";
    char cs[3];
    std::snprintf(cs, sizeof cs, "%02X", av::nmea_checksum(body.c_str()));
    CHECK_STR(line, "$" + body + "*" + cs + "\r\n");
}

TEST(hello_and_status_lines) {
    char buf[160];
    av::BufferSink sink(buf, sizeof buf);
    av::AvWriter w(sink);
    w.begin_hello("AERO_FRONT", "1.0.0");
    w.add_channel("fw_p01");
    w.add_channel("pitot_dp");
    w.end();
    std::string body = "AVH,AERO_FRONT,1.0.0,fw_p01,pitot_dp";
    char cs[3];
    std::snprintf(cs, sizeof cs, "%02X", av::nmea_checksum(body.c_str()));
    CHECK_STR(std::string(sink.c_str()), "$" + body + "*" + cs + "\r\n");

    sink.clear();
    w.status("AERO_FRONT", 42, av::NodeStatus::kError, "fw_p03: no answer, mux 2*");
    body = "AVS,AERO_FRONT,42,error,fw_p03: no answer, mux 2 ";  // '*' replaced by a space
    std::snprintf(cs, sizeof cs, "%02X", av::nmea_checksum(body.c_str()));
    CHECK_STR(std::string(sink.c_str()), "$" + body + "*" + cs + "\r\n");
    CHECK_STR(std::string(av::status_word(av::NodeStatus::kWarn)), "warn");
}

TEST(tokens_are_sanitised) {
    char buf[96];
    av::BufferSink sink(buf, sizeof buf);
    av::AvWriter w(sink);
    w.begin_data("my node,1", 5);  // separators in a node name would break the line
    w.add_value("x", 2.0, 0);
    w.end();
    CHECK(std::string(sink.c_str()).rfind("$AV,my_node_1,5,x=2*", 0) == 0);
    sink.clear();
    w.begin_hello("", "v1");
    w.end();
    CHECK(std::string(sink.c_str()).rfind("$AVH,_,v1*", 0) == 0);
}

TEST(buffer_sink_overflow) {
    char buf[8];
    av::BufferSink sink(buf, sizeof buf);
    for (char c : std::string("0123456789")) sink.put(c);
    CHECK(sink.overflowed());
    CHECK_EQ(sink.size(), 7u);
    CHECK_STR(std::string(sink.c_str()), "0123456");
    sink.clear();
    CHECK(!sink.overflowed());
    CHECK_EQ(sink.size(), 0u);
}
