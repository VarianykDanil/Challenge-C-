// av_lines - print AeroVolt serial sentences with the firmware's own writer (av_line.h),
// so tests/test_firmware_cross.py can check that the Python parser accepts them.
//
// Reads commands from stdin, one per line:
//     DATA <node> <ms> <channel>=<value>[:<decimals>] ...     -> $AV line (decimals default 2)
//     HELLO <node> <fw_version> <channel> ...                  -> $AVH line
//     STATUS <node> <ms> <ok|warn|error> <message words...>    -> $AVS line
// and prints each sentence exactly as the node would send it (with \r\n).
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>

#include "av_line.h"

namespace {

class StdoutSink final : public av::CharSink {
public:
    void put(char c) override { std::fputc(c, stdout); }
};

}  // namespace

int main() {
    StdoutSink sink;
    av::AvWriter writer(sink);
    std::string line;
    int errors = 0;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string kind, node;
        if (!(in >> kind) || kind[0] == '#') continue;
        if (kind == "DATA") {
            unsigned long ms = 0;
            in >> node >> ms;
            writer.begin_data(node.c_str(), static_cast<uint32_t>(ms));
            std::string item;
            while (in >> item) {
                const size_t eq = item.find('=');
                const size_t colon = item.find(':', eq);
                const std::string channel = item.substr(0, eq);
                const std::string value = item.substr(eq + 1, colon == std::string::npos ? std::string::npos : colon - eq - 1);
                const int decimals = colon == std::string::npos ? 2 : std::atoi(item.c_str() + colon + 1);
                writer.add_value(channel.c_str(), std::strtod(value.c_str(), nullptr), static_cast<uint8_t>(decimals));
            }
            writer.end();
        } else if (kind == "HELLO") {
            std::string fw, channel;
            in >> node >> fw;
            writer.begin_hello(node.c_str(), fw.c_str());
            while (in >> channel) writer.add_channel(channel.c_str());
            writer.end();
        } else if (kind == "STATUS") {
            unsigned long ms = 0;
            std::string word, message, rest;
            in >> node >> ms >> word;
            std::getline(in, rest);
            message = rest.empty() ? "" : rest.substr(1);
            const av::NodeStatus status = word == "ok" ? av::NodeStatus::kOk
                                          : word == "warn" ? av::NodeStatus::kWarn
                                                           : av::NodeStatus::kError;
            writer.status(node.c_str(), static_cast<uint32_t>(ms), status, message.c_str());
        } else {
            std::fprintf(stderr, "unknown command %s\n", kind.c_str());
            ++errors;
        }
    }
    return errors == 0 ? 0 : 1;
}
