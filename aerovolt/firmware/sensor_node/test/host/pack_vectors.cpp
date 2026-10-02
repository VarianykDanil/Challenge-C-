// pack_vectors - pack CAN frames with the firmware's own code, for cross-checking.
//
// Reads lines from stdin:
//     <MESSAGE_NAME> <signal>=<value> [<signal>=<value> ...]
// e.g. "AERO_FW_TAPS_A fw_p03=-412.5". For each line it starts the frame with SNA in every
// signal (exactly what a node that owns only some signals sends), encodes the given values
// with avcore (round half to even, saturation, NaN -> SNA) and prints the 8 data bytes as
// 16 upper-case hex digits. Values are decimal text (strtod), "nan" allowed.
// Blank lines and lines starting with '#' are ignored. A line it cannot pack prints
// "ERROR <reason>" (the exit status is then 1).
//
// tests/test_firmware_cross.py feeds thousands of random vectors through this program and
// compares every byte with cantools encoding the same values from can/aerovolt.dbc.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

#include "can_codec.h"

namespace can = aerovolt::can;

int main() {
    std::string line;
    int errors = 0;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string name;
        if (!(in >> name) || name[0] == '#') continue;
        const can::MessageDef* msg = can::find_message_by_name(name.c_str());
        if (msg == nullptr) {
            std::printf("ERROR unknown message %s\n", name.c_str());
            ++errors;
            continue;
        }
        uint8_t data[av::kFrameBytes];
        av::fill_sna(*msg, data);
        std::string item;
        bool ok = true;
        while (in >> item) {
            const size_t eq = item.find('=');
            if (eq == std::string::npos) {
                std::printf("ERROR bad item %s\n", item.c_str());
                ok = false;
                break;
            }
            const std::string channel = item.substr(0, eq);
            const std::string text = item.substr(eq + 1);
            char* end = nullptr;
            const double value = std::strtod(text.c_str(), &end);
            if (end == text.c_str() || *end != '\0') {
                std::printf("ERROR bad value %s\n", item.c_str());
                ok = false;
                break;
            }
            if (!av::set_channel(*msg, channel.c_str(), value, data)) {
                std::printf("ERROR %s has no signal %s\n", name.c_str(), channel.c_str());
                ok = false;
                break;
            }
        }
        if (!ok) {
            ++errors;
            continue;
        }
        for (uint8_t b : data) std::printf("%02X", b);
        std::printf("\n");
    }
    return errors == 0 ? 0 : 1;
}
