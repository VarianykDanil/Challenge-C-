# Host build of the sensor-node firmware core: unit tests and cross-check tools.
#
#   make -C firmware/sensor_node/test/host test     build everything and run the tests
#   make -C firmware/sensor_node/test/host tools    only build pack_vectors / av_lines / firmware_sim
#   make -C firmware/sensor_node/test/host clean
#
# Everything is built with the strict flags below into ./build (git-ignored). Nothing here
# needs Arduino or a microcontroller toolchain: lib/avcore is plain C++17, and the firmware
# itself (src/) is compiled against small fakes of the Arduino API in ./sim.

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Werror -O2
ROOT     := ../..
AVCORE   := $(ROOT)/lib/avcore/src
INCLUDES := -I$(AVCORE) -I$(ROOT)/include
BUILD    := build

AVCORE_SRC := $(wildcard $(AVCORE)/*.cpp)
AVCORE_HDR := $(wildcard $(AVCORE)/*.h) $(ROOT)/include/aerovolt_can.h
UNIT_SRC   := test_main.cpp test_can_codec.cpp test_av_line.cpp test_sensors.cpp test_filters_scheduler.cpp

# The real firmware sources, built for the host against the fakes in ./sim.
# (transport/can_bus.cpp is the Teensy/ESP32 CAN driver; the simulation provides its own.)
FW_SRC  := $(wildcard $(ROOT)/src/*.cpp $(ROOT)/src/drivers/*.cpp) $(ROOT)/src/transport/serial_out.cpp
FW_HDR  := $(wildcard $(ROOT)/src/*.h $(ROOT)/src/drivers/*.h $(ROOT)/src/transport/*.h) $(ROOT)/include/node_config.h
SIM_SRC := $(wildcard sim/*.cpp)
SIM_HDR := $(wildcard sim/*.h)
SIM_INC := -Isim -I$(ROOT)/src $(INCLUDES)

SIMS     := $(BUILD)/firmware_sim_bench $(BUILD)/firmware_sim_front $(BUILD)/firmware_sim_nano
PROGRAMS := $(BUILD)/avcore_tests $(BUILD)/pack_vectors $(BUILD)/av_lines $(SIMS)

.PHONY: all tools test clean
all: $(PROGRAMS)
tools: $(BUILD)/pack_vectors $(BUILD)/av_lines $(SIMS)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/avcore_tests: $(UNIT_SRC) $(AVCORE_SRC) $(AVCORE_HDR) check.h | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ $(UNIT_SRC) $(AVCORE_SRC)

$(BUILD)/pack_vectors: pack_vectors.cpp $(AVCORE_SRC) $(AVCORE_HDR) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ pack_vectors.cpp $(AVCORE_SRC)

$(BUILD)/av_lines: av_lines.cpp $(AVCORE_SRC) $(AVCORE_HDR) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ av_lines.cpp $(AVCORE_SRC)

# Firmware-in-the-loop: the same src/ as on the real boards - bench and front profiles with
# CAN (like teensy41 / esp32dev), and the bench profile serial-only (like nano_serial).
$(BUILD)/firmware_sim_bench: $(FW_SRC) $(FW_HDR) $(SIM_SRC) $(SIM_HDR) $(AVCORE_SRC) $(AVCORE_HDR) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(SIM_INC) -DNODE_PROFILE=NODE_PROFILE_BENCH_ONE_TAP -DAV_USE_CAN=1 \
	    -o $@ $(FW_SRC) $(SIM_SRC) $(AVCORE_SRC)

$(BUILD)/firmware_sim_front: $(FW_SRC) $(FW_HDR) $(SIM_SRC) $(SIM_HDR) $(AVCORE_SRC) $(AVCORE_HDR) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(SIM_INC) -DNODE_PROFILE=NODE_PROFILE_AERO_FRONT -DAV_USE_CAN=1 \
	    -o $@ $(FW_SRC) $(SIM_SRC) $(AVCORE_SRC)

$(BUILD)/firmware_sim_nano: $(FW_SRC) $(FW_HDR) $(SIM_SRC) $(SIM_HDR) $(AVCORE_SRC) $(AVCORE_HDR) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(SIM_INC) -DNODE_PROFILE=NODE_PROFILE_BENCH_ONE_TAP -DAV_USE_CAN=0 \
	    -o $@ $(FW_SRC) $(SIM_SRC) $(AVCORE_SRC)

test: all
	./$(BUILD)/avcore_tests
	./$(BUILD)/firmware_sim_bench --self-test
	./$(BUILD)/firmware_sim_front --self-test
	./$(BUILD)/firmware_sim_nano --self-test
	@echo "host tests passed"

clean:
	rm -rf $(BUILD)
