// ======================================================================================
// GENERATED - DO NOT EDIT.
// Source: config/can_layout.yaml   Generator: tools/gen_can.py   (python tools/gen_can.py)
// AeroVolt 1.0.0 CAN layout: classic CAN 2.0A, 11-bit IDs, 1000 kbit/s, Intel byte order, DLC 8.
//
// physical = raw * scale + offset
// raw      = nearbyint((physical - offset) / scale)   // round half to EVEN, exactly like
//            cantools / Python round(); then clamp to the valid raw range (SNA excluded).
// SNA (signal not available): signed -> most negative raw (0x80..0), unsigned -> all ones.
// 1-bit flags have no SNA. Unused bits are 0. Signed values are two's complement.
// ======================================================================================
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace aerovolt {
namespace can {

constexpr uint32_t BITRATE = 1000000u;

struct SignalDef {
    const char* name;   // == AeroVolt channel id
    uint8_t start_bit;  // Intel (little-endian) start bit, LSB first
    uint8_t length;     // bits
    bool is_signed;     // two's complement
    double scale;       // physical = raw * scale + offset
    double offset;
    bool has_sna;       // false only for 1-bit flags
};

struct MessageDef {
    uint32_t id;        // 11-bit identifier
    const char* name;
    uint8_t dlc;
    uint16_t cycle_ms;  // transmit period
    const SignalDef* signals;
    uint8_t signal_count;
};

// ---- Message identifiers ------------------------------------------------------------
constexpr uint32_t ID_AERO_FW_TAPS_A = 0x300;
constexpr uint32_t ID_AERO_FW_TAPS_B = 0x301;
constexpr uint32_t ID_AERO_FW_TAPS_C = 0x302;
constexpr uint32_t ID_AERO_RW_TAPS_A = 0x303;
constexpr uint32_t ID_AERO_RW_TAPS_B = 0x304;
constexpr uint32_t ID_AERO_RW_TAPS_C = 0x305;
constexpr uint32_t ID_AERO_UT_TAPS_A = 0x306;
constexpr uint32_t ID_AERO_UT_TAPS_B = 0x307;
constexpr uint32_t ID_AERO_AIR = 0x310;
constexpr uint32_t ID_AERO_PROBE = 0x311;
constexpr uint32_t ID_AERO_WING_LOADS = 0x312;
constexpr uint32_t ID_SUSP_DAMPERS = 0x320;
constexpr uint32_t ID_SUSP_PUSHRODS = 0x321;
constexpr uint32_t ID_IMU_ACCEL = 0x330;
constexpr uint32_t ID_IMU_GYRO = 0x331;
constexpr uint32_t ID_GPS_POS = 0x340;
constexpr uint32_t ID_GPS_VEL = 0x341;
constexpr uint32_t ID_WHEEL_SPEEDS = 0x350;
constexpr uint32_t ID_DRIVER = 0x351;
constexpr uint32_t ID_INV_STATUS = 0x400;
constexpr uint32_t ID_INV_TEMPS = 0x401;
constexpr uint32_t ID_BMS_PACK = 0x410;
constexpr uint32_t ID_BMS_CELL_V_00 = 0x420;
constexpr uint32_t ID_BMS_CELL_V_01 = 0x421;
constexpr uint32_t ID_BMS_CELL_V_02 = 0x422;
constexpr uint32_t ID_BMS_CELL_V_03 = 0x423;
constexpr uint32_t ID_BMS_CELL_V_04 = 0x424;
constexpr uint32_t ID_BMS_CELL_V_05 = 0x425;
constexpr uint32_t ID_BMS_CELL_V_06 = 0x426;
constexpr uint32_t ID_BMS_CELL_V_07 = 0x427;
constexpr uint32_t ID_BMS_CELL_V_08 = 0x428;
constexpr uint32_t ID_BMS_CELL_V_09 = 0x429;
constexpr uint32_t ID_BMS_CELL_V_10 = 0x42A;
constexpr uint32_t ID_BMS_CELL_V_11 = 0x42B;
constexpr uint32_t ID_BMS_CELL_V_12 = 0x42C;
constexpr uint32_t ID_BMS_CELL_V_13 = 0x42D;
constexpr uint32_t ID_BMS_CELL_V_14 = 0x42E;
constexpr uint32_t ID_BMS_CELL_V_15 = 0x42F;
constexpr uint32_t ID_BMS_CELL_V_16 = 0x430;
constexpr uint32_t ID_BMS_CELL_V_17 = 0x431;
constexpr uint32_t ID_BMS_CELL_V_18 = 0x432;
constexpr uint32_t ID_BMS_CELL_V_19 = 0x433;
constexpr uint32_t ID_BMS_CELL_V_20 = 0x434;
constexpr uint32_t ID_BMS_CELL_V_21 = 0x435;
constexpr uint32_t ID_BMS_CELL_V_22 = 0x436;
constexpr uint32_t ID_BMS_CELL_V_23 = 0x437;
constexpr uint32_t ID_BMS_CELL_V_24 = 0x438;
constexpr uint32_t ID_BMS_CELL_V_25 = 0x439;
constexpr uint32_t ID_BMS_CELL_V_26 = 0x43A;
constexpr uint32_t ID_BMS_CELL_V_27 = 0x43B;
constexpr uint32_t ID_BMS_CELL_V_28 = 0x43C;
constexpr uint32_t ID_BMS_CELL_V_29 = 0x43D;
constexpr uint32_t ID_BMS_CELL_V_30 = 0x43E;
constexpr uint32_t ID_BMS_CELL_V_31 = 0x43F;
constexpr uint32_t ID_BMS_CELL_V_32 = 0x440;
constexpr uint32_t ID_BMS_CELL_V_33 = 0x441;
constexpr uint32_t ID_BMS_CELL_V_34 = 0x442;
constexpr uint32_t ID_BMS_CELL_T_0 = 0x450;
constexpr uint32_t ID_BMS_CELL_T_1 = 0x451;
constexpr uint32_t ID_BMS_CELL_T_2 = 0x452;
constexpr uint32_t ID_BMS_CELL_T_3 = 0x453;
constexpr uint32_t ID_BMS_CELL_T_4 = 0x454;
constexpr uint32_t ID_BMS_CELL_T_5 = 0x455;
constexpr uint32_t ID_BMS_CELL_T_6 = 0x456;
constexpr uint32_t ID_BMS_CELL_T_7 = 0x457;
constexpr uint32_t ID_COOLING = 0x460;
constexpr uint32_t ID_SAFETY = 0x470;

// ---- Signal tables ------------------------------------------------------------------
// 0x300 AERO_FW_TAPS_A: Front wing pressure taps 1-4 (station L suction side), Pa relative to freestream static.
constexpr SignalDef SIGNALS_AERO_FW_TAPS_A[] = {
    {"fw_p01", 0, 16, true, 0.1, 0.0, true},
    {"fw_p02", 16, 16, true, 0.1, 0.0, true},
    {"fw_p03", 32, 16, true, 0.1, 0.0, true},
    {"fw_p04", 48, 16, true, 0.1, 0.0, true},
};
// 0x301 AERO_FW_TAPS_B: Front wing pressure taps 5-8 (station L pressure side, station R suction side), Pa.
constexpr SignalDef SIGNALS_AERO_FW_TAPS_B[] = {
    {"fw_p05", 0, 16, true, 0.1, 0.0, true},
    {"fw_p06", 16, 16, true, 0.1, 0.0, true},
    {"fw_p07", 32, 16, true, 0.1, 0.0, true},
    {"fw_p08", 48, 16, true, 0.1, 0.0, true},
};
// 0x302 AERO_FW_TAPS_C: Front wing pressure taps 9-12 (station R), Pa.
constexpr SignalDef SIGNALS_AERO_FW_TAPS_C[] = {
    {"fw_p09", 0, 16, true, 0.1, 0.0, true},
    {"fw_p10", 16, 16, true, 0.1, 0.0, true},
    {"fw_p11", 32, 16, true, 0.1, 0.0, true},
    {"fw_p12", 48, 16, true, 0.1, 0.0, true},
};
// 0x303 AERO_RW_TAPS_A: Rear wing pressure taps 1-4 (station L suction side), Pa.
constexpr SignalDef SIGNALS_AERO_RW_TAPS_A[] = {
    {"rw_p01", 0, 16, true, 0.1, 0.0, true},
    {"rw_p02", 16, 16, true, 0.1, 0.0, true},
    {"rw_p03", 32, 16, true, 0.1, 0.0, true},
    {"rw_p04", 48, 16, true, 0.1, 0.0, true},
};
// 0x304 AERO_RW_TAPS_B: Rear wing pressure taps 5-8, Pa.
constexpr SignalDef SIGNALS_AERO_RW_TAPS_B[] = {
    {"rw_p05", 0, 16, true, 0.1, 0.0, true},
    {"rw_p06", 16, 16, true, 0.1, 0.0, true},
    {"rw_p07", 32, 16, true, 0.1, 0.0, true},
    {"rw_p08", 48, 16, true, 0.1, 0.0, true},
};
// 0x305 AERO_RW_TAPS_C: Rear wing pressure taps 9-12 (station R), Pa.
constexpr SignalDef SIGNALS_AERO_RW_TAPS_C[] = {
    {"rw_p09", 0, 16, true, 0.1, 0.0, true},
    {"rw_p10", 16, 16, true, 0.1, 0.0, true},
    {"rw_p11", 32, 16, true, 0.1, 0.0, true},
    {"rw_p12", 48, 16, true, 0.1, 0.0, true},
};
// 0x306 AERO_UT_TAPS_A: Undertray centreline taps 1-4 (inlet to throat), Pa.
constexpr SignalDef SIGNALS_AERO_UT_TAPS_A[] = {
    {"ut_p01", 0, 16, true, 0.1, 0.0, true},
    {"ut_p02", 16, 16, true, 0.1, 0.0, true},
    {"ut_p03", 32, 16, true, 0.1, 0.0, true},
    {"ut_p04", 48, 16, true, 0.1, 0.0, true},
};
// 0x307 AERO_UT_TAPS_B: Undertray taps 5-8 (diffuser centreline and tunnels), Pa.
constexpr SignalDef SIGNALS_AERO_UT_TAPS_B[] = {
    {"ut_p05", 0, 16, true, 0.1, 0.0, true},
    {"ut_p06", 16, 16, true, 0.1, 0.0, true},
    {"ut_p07", 32, 16, true, 0.1, 0.0, true},
    {"ut_p08", 48, 16, true, 0.1, 0.0, true},
};
// 0x310 AERO_AIR: Pitot dynamic pressure (50 Hz) and BME280 ambient air data (updated at 1 Hz).
constexpr SignalDef SIGNALS_AERO_AIR[] = {
    {"pitot_dp", 0, 16, true, 0.1, 0.0, true},
    {"amb_temp", 16, 16, true, 0.01, 0.0, true},
    {"amb_press", 32, 16, false, 1.0, 50000.0, true},
    {"amb_rh", 48, 8, false, 0.5, 0.0, true},
};
// 0x311 AERO_PROBE: 5-hole probe flow angles and laser ride heights.
constexpr SignalDef SIGNALS_AERO_PROBE[] = {
    {"probe_yaw", 0, 16, true, 0.01, 0.0, true},
    {"probe_pitch", 16, 16, true, 0.01, 0.0, true},
    {"rh_front", 32, 16, false, 0.01, 0.0, true},
    {"rh_rear", 48, 16, false, 0.01, 0.0, true},
};
// 0x312 AERO_WING_LOADS: Wing mount load cells, vertical force, + = down.
constexpr SignalDef SIGNALS_AERO_WING_LOADS[] = {
    {"fw_load", 0, 16, true, 1.0, 0.0, true},
    {"rw_load", 16, 16, true, 1.0, 0.0, true},
};
// 0x320 SUSP_DAMPERS: Damper positions from static, + = bump.
constexpr SignalDef SIGNALS_SUSP_DAMPERS[] = {
    {"damper_fl", 0, 16, true, 0.01, 0.0, true},
    {"damper_fr", 16, 16, true, 0.01, 0.0, true},
    {"damper_rl", 32, 16, true, 0.01, 0.0, true},
    {"damper_rr", 48, 16, true, 0.01, 0.0, true},
};
// 0x321 SUSP_PUSHRODS: Pushrod compression forces.
constexpr SignalDef SIGNALS_SUSP_PUSHRODS[] = {
    {"pushrod_fl", 0, 16, true, 1.0, 0.0, true},
    {"pushrod_fr", 16, 16, true, 1.0, 0.0, true},
    {"pushrod_rl", 32, 16, true, 1.0, 0.0, true},
    {"pushrod_rr", 48, 16, true, 1.0, 0.0, true},
};
// 0x330 IMU_ACCEL: Accelerations in the vehicle frame (ISO 8855), az = +9.81 at rest.
constexpr SignalDef SIGNALS_IMU_ACCEL[] = {
    {"ax", 0, 16, true, 0.002, 0.0, true},
    {"ay", 16, 16, true, 0.002, 0.0, true},
    {"az", 32, 16, true, 0.002, 0.0, true},
};
// 0x331 IMU_GYRO: Angular rates: roll, pitch, yaw.
constexpr SignalDef SIGNALS_IMU_GYRO[] = {
    {"gx", 0, 16, true, 0.01, 0.0, true},
    {"gy", 16, 16, true, 0.01, 0.0, true},
    {"gz", 32, 16, true, 0.01, 0.0, true},
};
// 0x340 GPS_POS: GNSS position (WGS-84).
constexpr SignalDef SIGNALS_GPS_POS[] = {
    {"gps_lat", 0, 32, true, 1e-07, 0.0, true},
    {"gps_lon", 32, 32, true, 1e-07, 0.0, true},
};
// 0x341 GPS_VEL: GNSS ground speed and heading (0 = north, clockwise).
constexpr SignalDef SIGNALS_GPS_VEL[] = {
    {"gps_speed", 0, 16, false, 0.01, 0.0, true},
    {"gps_heading", 16, 16, false, 0.01, 0.0, true},
};
// 0x350 WHEEL_SPEEDS: Wheel surface speeds.
constexpr SignalDef SIGNALS_WHEEL_SPEEDS[] = {
    {"ws_fl", 0, 16, false, 0.01, 0.0, true},
    {"ws_fr", 16, 16, false, 0.01, 0.0, true},
    {"ws_rl", 32, 16, false, 0.01, 0.0, true},
    {"ws_rr", 48, 16, false, 0.01, 0.0, true},
};
// 0x351 DRIVER: Driver inputs: steering, both accelerator pedal sensors, brake pressures.
constexpr SignalDef SIGNALS_DRIVER[] = {
    {"steer", 0, 16, true, 0.01, 0.0, true},
    {"apps1", 16, 8, false, 0.5, 0.0, true},
    {"apps2", 24, 8, false, 0.5, 0.0, true},
    {"brake_press_f", 32, 16, false, 0.01, 0.0, true},
    {"brake_press_r", 48, 16, false, 0.01, 0.0, true},
};
// 0x400 INV_STATUS: Inverter fast status: motor speed and torque, DC link.
constexpr SignalDef SIGNALS_INV_STATUS[] = {
    {"mot_speed", 0, 16, true, 1.0, 0.0, true},
    {"mot_torque", 16, 16, true, 0.1, 0.0, true},
    {"inv_dc_voltage", 32, 16, false, 0.1, 0.0, true},
    {"inv_dc_current", 48, 16, true, 0.1, 0.0, true},
};
// 0x401 INV_TEMPS: Inverter slow status: temperatures, phase current, state machine and fault code.
constexpr SignalDef SIGNALS_INV_TEMPS[] = {
    {"mot_winding_temp", 0, 16, true, 0.1, 0.0, true},
    {"inv_igbt_temp", 16, 16, true, 0.1, 0.0, true},
    {"inv_phase_current", 32, 16, false, 0.1, 0.0, true},
    {"inv_state", 48, 8, false, 1.0, 0.0, true},
    {"inv_fault", 56, 8, false, 1.0, 0.0, true},
};
// 0x410 BMS_PACK: Accumulator pack status.
constexpr SignalDef SIGNALS_BMS_PACK[] = {
    {"pack_voltage", 0, 16, false, 0.1, 0.0, true},
    {"pack_current", 16, 16, true, 0.1, 0.0, true},
    {"bms_soc", 32, 8, false, 0.5, 0.0, true},
    {"bms_state", 40, 8, false, 1.0, 0.0, true},
    {"bms_fault", 48, 8, false, 1.0, 0.0, true},
};
// 0x420 BMS_CELL_V_00: Cell voltages cell_v_000 ... cell_v_003 (frame 0).
constexpr SignalDef SIGNALS_BMS_CELL_V_00[] = {
    {"cell_v_000", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_001", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_002", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_003", 48, 16, false, 0.001, 0.0, true},
};
// 0x421 BMS_CELL_V_01: Cell voltages cell_v_004 ... cell_v_007 (frame 1).
constexpr SignalDef SIGNALS_BMS_CELL_V_01[] = {
    {"cell_v_004", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_005", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_006", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_007", 48, 16, false, 0.001, 0.0, true},
};
// 0x422 BMS_CELL_V_02: Cell voltages cell_v_008 ... cell_v_011 (frame 2).
constexpr SignalDef SIGNALS_BMS_CELL_V_02[] = {
    {"cell_v_008", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_009", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_010", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_011", 48, 16, false, 0.001, 0.0, true},
};
// 0x423 BMS_CELL_V_03: Cell voltages cell_v_012 ... cell_v_015 (frame 3).
constexpr SignalDef SIGNALS_BMS_CELL_V_03[] = {
    {"cell_v_012", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_013", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_014", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_015", 48, 16, false, 0.001, 0.0, true},
};
// 0x424 BMS_CELL_V_04: Cell voltages cell_v_016 ... cell_v_019 (frame 4).
constexpr SignalDef SIGNALS_BMS_CELL_V_04[] = {
    {"cell_v_016", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_017", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_018", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_019", 48, 16, false, 0.001, 0.0, true},
};
// 0x425 BMS_CELL_V_05: Cell voltages cell_v_020 ... cell_v_023 (frame 5).
constexpr SignalDef SIGNALS_BMS_CELL_V_05[] = {
    {"cell_v_020", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_021", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_022", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_023", 48, 16, false, 0.001, 0.0, true},
};
// 0x426 BMS_CELL_V_06: Cell voltages cell_v_024 ... cell_v_027 (frame 6).
constexpr SignalDef SIGNALS_BMS_CELL_V_06[] = {
    {"cell_v_024", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_025", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_026", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_027", 48, 16, false, 0.001, 0.0, true},
};
// 0x427 BMS_CELL_V_07: Cell voltages cell_v_028 ... cell_v_031 (frame 7).
constexpr SignalDef SIGNALS_BMS_CELL_V_07[] = {
    {"cell_v_028", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_029", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_030", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_031", 48, 16, false, 0.001, 0.0, true},
};
// 0x428 BMS_CELL_V_08: Cell voltages cell_v_032 ... cell_v_035 (frame 8).
constexpr SignalDef SIGNALS_BMS_CELL_V_08[] = {
    {"cell_v_032", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_033", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_034", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_035", 48, 16, false, 0.001, 0.0, true},
};
// 0x429 BMS_CELL_V_09: Cell voltages cell_v_036 ... cell_v_039 (frame 9).
constexpr SignalDef SIGNALS_BMS_CELL_V_09[] = {
    {"cell_v_036", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_037", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_038", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_039", 48, 16, false, 0.001, 0.0, true},
};
// 0x42A BMS_CELL_V_10: Cell voltages cell_v_040 ... cell_v_043 (frame 10).
constexpr SignalDef SIGNALS_BMS_CELL_V_10[] = {
    {"cell_v_040", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_041", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_042", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_043", 48, 16, false, 0.001, 0.0, true},
};
// 0x42B BMS_CELL_V_11: Cell voltages cell_v_044 ... cell_v_047 (frame 11).
constexpr SignalDef SIGNALS_BMS_CELL_V_11[] = {
    {"cell_v_044", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_045", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_046", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_047", 48, 16, false, 0.001, 0.0, true},
};
// 0x42C BMS_CELL_V_12: Cell voltages cell_v_048 ... cell_v_051 (frame 12).
constexpr SignalDef SIGNALS_BMS_CELL_V_12[] = {
    {"cell_v_048", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_049", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_050", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_051", 48, 16, false, 0.001, 0.0, true},
};
// 0x42D BMS_CELL_V_13: Cell voltages cell_v_052 ... cell_v_055 (frame 13).
constexpr SignalDef SIGNALS_BMS_CELL_V_13[] = {
    {"cell_v_052", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_053", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_054", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_055", 48, 16, false, 0.001, 0.0, true},
};
// 0x42E BMS_CELL_V_14: Cell voltages cell_v_056 ... cell_v_059 (frame 14).
constexpr SignalDef SIGNALS_BMS_CELL_V_14[] = {
    {"cell_v_056", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_057", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_058", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_059", 48, 16, false, 0.001, 0.0, true},
};
// 0x42F BMS_CELL_V_15: Cell voltages cell_v_060 ... cell_v_063 (frame 15).
constexpr SignalDef SIGNALS_BMS_CELL_V_15[] = {
    {"cell_v_060", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_061", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_062", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_063", 48, 16, false, 0.001, 0.0, true},
};
// 0x430 BMS_CELL_V_16: Cell voltages cell_v_064 ... cell_v_067 (frame 16).
constexpr SignalDef SIGNALS_BMS_CELL_V_16[] = {
    {"cell_v_064", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_065", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_066", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_067", 48, 16, false, 0.001, 0.0, true},
};
// 0x431 BMS_CELL_V_17: Cell voltages cell_v_068 ... cell_v_071 (frame 17).
constexpr SignalDef SIGNALS_BMS_CELL_V_17[] = {
    {"cell_v_068", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_069", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_070", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_071", 48, 16, false, 0.001, 0.0, true},
};
// 0x432 BMS_CELL_V_18: Cell voltages cell_v_072 ... cell_v_075 (frame 18).
constexpr SignalDef SIGNALS_BMS_CELL_V_18[] = {
    {"cell_v_072", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_073", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_074", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_075", 48, 16, false, 0.001, 0.0, true},
};
// 0x433 BMS_CELL_V_19: Cell voltages cell_v_076 ... cell_v_079 (frame 19).
constexpr SignalDef SIGNALS_BMS_CELL_V_19[] = {
    {"cell_v_076", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_077", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_078", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_079", 48, 16, false, 0.001, 0.0, true},
};
// 0x434 BMS_CELL_V_20: Cell voltages cell_v_080 ... cell_v_083 (frame 20).
constexpr SignalDef SIGNALS_BMS_CELL_V_20[] = {
    {"cell_v_080", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_081", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_082", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_083", 48, 16, false, 0.001, 0.0, true},
};
// 0x435 BMS_CELL_V_21: Cell voltages cell_v_084 ... cell_v_087 (frame 21).
constexpr SignalDef SIGNALS_BMS_CELL_V_21[] = {
    {"cell_v_084", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_085", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_086", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_087", 48, 16, false, 0.001, 0.0, true},
};
// 0x436 BMS_CELL_V_22: Cell voltages cell_v_088 ... cell_v_091 (frame 22).
constexpr SignalDef SIGNALS_BMS_CELL_V_22[] = {
    {"cell_v_088", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_089", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_090", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_091", 48, 16, false, 0.001, 0.0, true},
};
// 0x437 BMS_CELL_V_23: Cell voltages cell_v_092 ... cell_v_095 (frame 23).
constexpr SignalDef SIGNALS_BMS_CELL_V_23[] = {
    {"cell_v_092", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_093", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_094", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_095", 48, 16, false, 0.001, 0.0, true},
};
// 0x438 BMS_CELL_V_24: Cell voltages cell_v_096 ... cell_v_099 (frame 24).
constexpr SignalDef SIGNALS_BMS_CELL_V_24[] = {
    {"cell_v_096", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_097", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_098", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_099", 48, 16, false, 0.001, 0.0, true},
};
// 0x439 BMS_CELL_V_25: Cell voltages cell_v_100 ... cell_v_103 (frame 25).
constexpr SignalDef SIGNALS_BMS_CELL_V_25[] = {
    {"cell_v_100", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_101", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_102", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_103", 48, 16, false, 0.001, 0.0, true},
};
// 0x43A BMS_CELL_V_26: Cell voltages cell_v_104 ... cell_v_107 (frame 26).
constexpr SignalDef SIGNALS_BMS_CELL_V_26[] = {
    {"cell_v_104", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_105", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_106", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_107", 48, 16, false, 0.001, 0.0, true},
};
// 0x43B BMS_CELL_V_27: Cell voltages cell_v_108 ... cell_v_111 (frame 27).
constexpr SignalDef SIGNALS_BMS_CELL_V_27[] = {
    {"cell_v_108", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_109", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_110", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_111", 48, 16, false, 0.001, 0.0, true},
};
// 0x43C BMS_CELL_V_28: Cell voltages cell_v_112 ... cell_v_115 (frame 28).
constexpr SignalDef SIGNALS_BMS_CELL_V_28[] = {
    {"cell_v_112", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_113", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_114", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_115", 48, 16, false, 0.001, 0.0, true},
};
// 0x43D BMS_CELL_V_29: Cell voltages cell_v_116 ... cell_v_119 (frame 29).
constexpr SignalDef SIGNALS_BMS_CELL_V_29[] = {
    {"cell_v_116", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_117", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_118", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_119", 48, 16, false, 0.001, 0.0, true},
};
// 0x43E BMS_CELL_V_30: Cell voltages cell_v_120 ... cell_v_123 (frame 30).
constexpr SignalDef SIGNALS_BMS_CELL_V_30[] = {
    {"cell_v_120", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_121", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_122", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_123", 48, 16, false, 0.001, 0.0, true},
};
// 0x43F BMS_CELL_V_31: Cell voltages cell_v_124 ... cell_v_127 (frame 31).
constexpr SignalDef SIGNALS_BMS_CELL_V_31[] = {
    {"cell_v_124", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_125", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_126", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_127", 48, 16, false, 0.001, 0.0, true},
};
// 0x440 BMS_CELL_V_32: Cell voltages cell_v_128 ... cell_v_131 (frame 32).
constexpr SignalDef SIGNALS_BMS_CELL_V_32[] = {
    {"cell_v_128", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_129", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_130", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_131", 48, 16, false, 0.001, 0.0, true},
};
// 0x441 BMS_CELL_V_33: Cell voltages cell_v_132 ... cell_v_135 (frame 33).
constexpr SignalDef SIGNALS_BMS_CELL_V_33[] = {
    {"cell_v_132", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_133", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_134", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_135", 48, 16, false, 0.001, 0.0, true},
};
// 0x442 BMS_CELL_V_34: Cell voltages cell_v_136 ... cell_v_139 (frame 34).
constexpr SignalDef SIGNALS_BMS_CELL_V_34[] = {
    {"cell_v_136", 0, 16, false, 0.001, 0.0, true},
    {"cell_v_137", 16, 16, false, 0.001, 0.0, true},
    {"cell_v_138", 32, 16, false, 0.001, 0.0, true},
    {"cell_v_139", 48, 16, false, 0.001, 0.0, true},
};
// 0x450 BMS_CELL_T_0: Cell temperature sensors cell_t_00 ... cell_t_07 (frame 0), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_0[] = {
    {"cell_t_00", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_01", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_02", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_03", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_04", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_05", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_06", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_07", 56, 8, false, 0.5, -20.0, true},
};
// 0x451 BMS_CELL_T_1: Cell temperature sensors cell_t_08 ... cell_t_15 (frame 1), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_1[] = {
    {"cell_t_08", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_09", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_10", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_11", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_12", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_13", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_14", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_15", 56, 8, false, 0.5, -20.0, true},
};
// 0x452 BMS_CELL_T_2: Cell temperature sensors cell_t_16 ... cell_t_23 (frame 2), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_2[] = {
    {"cell_t_16", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_17", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_18", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_19", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_20", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_21", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_22", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_23", 56, 8, false, 0.5, -20.0, true},
};
// 0x453 BMS_CELL_T_3: Cell temperature sensors cell_t_24 ... cell_t_31 (frame 3), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_3[] = {
    {"cell_t_24", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_25", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_26", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_27", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_28", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_29", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_30", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_31", 56, 8, false, 0.5, -20.0, true},
};
// 0x454 BMS_CELL_T_4: Cell temperature sensors cell_t_32 ... cell_t_39 (frame 4), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_4[] = {
    {"cell_t_32", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_33", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_34", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_35", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_36", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_37", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_38", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_39", 56, 8, false, 0.5, -20.0, true},
};
// 0x455 BMS_CELL_T_5: Cell temperature sensors cell_t_40 ... cell_t_47 (frame 5), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_5[] = {
    {"cell_t_40", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_41", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_42", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_43", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_44", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_45", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_46", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_47", 56, 8, false, 0.5, -20.0, true},
};
// 0x456 BMS_CELL_T_6: Cell temperature sensors cell_t_48 ... cell_t_55 (frame 6), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_6[] = {
    {"cell_t_48", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_49", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_50", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_51", 24, 8, false, 0.5, -20.0, true},
    {"cell_t_52", 32, 8, false, 0.5, -20.0, true},
    {"cell_t_53", 40, 8, false, 0.5, -20.0, true},
    {"cell_t_54", 48, 8, false, 0.5, -20.0, true},
    {"cell_t_55", 56, 8, false, 0.5, -20.0, true},
};
// 0x457 BMS_CELL_T_7: Cell temperature sensors cell_t_56 ... cell_t_59 (frame 7), 0.5 degC steps from -20 degC.
constexpr SignalDef SIGNALS_BMS_CELL_T_7[] = {
    {"cell_t_56", 0, 8, false, 0.5, -20.0, true},
    {"cell_t_57", 8, 8, false, 0.5, -20.0, true},
    {"cell_t_58", 16, 8, false, 0.5, -20.0, true},
    {"cell_t_59", 24, 8, false, 0.5, -20.0, true},
};
// 0x460 COOLING: Cooling loop temperatures, flow and actuator duty cycles.
constexpr SignalDef SIGNALS_COOLING[] = {
    {"cool_temp_in", 0, 16, true, 0.1, 0.0, true},
    {"cool_temp_out", 16, 16, true, 0.1, 0.0, true},
    {"cool_flow", 32, 16, false, 0.01, 0.0, true},
    {"pump_duty", 48, 8, false, 0.5, 0.0, true},
    {"fan_duty", 56, 8, false, 0.5, 0.0, true},
};
// 0x470 SAFETY: Shutdown circuit and tractive-system safety flags (1 = OK / closed), TSAL, IMD insulation.
constexpr SignalDef SIGNALS_SAFETY[] = {
    {"sdc_closed", 0, 1, false, 1.0, 0.0, false},
    {"imd_ok", 1, 1, false, 1.0, 0.0, false},
    {"ams_ok", 2, 1, false, 1.0, 0.0, false},
    {"bspd_ok", 3, 1, false, 1.0, 0.0, false},
    {"apps_plaus_ok", 4, 1, false, 1.0, 0.0, false},
    {"air_pos_closed", 5, 1, false, 1.0, 0.0, false},
    {"air_neg_closed", 6, 1, false, 1.0, 0.0, false},
    {"precharge_done", 7, 1, false, 1.0, 0.0, false},
    {"tsal_state", 8, 8, false, 1.0, 0.0, true},
    {"imd_iso_kohm", 16, 16, false, 1.0, 0.0, true},
};

// ---- Message tables -----------------------------------------------------------------
constexpr MessageDef MSG_AERO_FW_TAPS_A = {ID_AERO_FW_TAPS_A, "AERO_FW_TAPS_A", 8, 20, SIGNALS_AERO_FW_TAPS_A, 4};
constexpr MessageDef MSG_AERO_FW_TAPS_B = {ID_AERO_FW_TAPS_B, "AERO_FW_TAPS_B", 8, 20, SIGNALS_AERO_FW_TAPS_B, 4};
constexpr MessageDef MSG_AERO_FW_TAPS_C = {ID_AERO_FW_TAPS_C, "AERO_FW_TAPS_C", 8, 20, SIGNALS_AERO_FW_TAPS_C, 4};
constexpr MessageDef MSG_AERO_RW_TAPS_A = {ID_AERO_RW_TAPS_A, "AERO_RW_TAPS_A", 8, 20, SIGNALS_AERO_RW_TAPS_A, 4};
constexpr MessageDef MSG_AERO_RW_TAPS_B = {ID_AERO_RW_TAPS_B, "AERO_RW_TAPS_B", 8, 20, SIGNALS_AERO_RW_TAPS_B, 4};
constexpr MessageDef MSG_AERO_RW_TAPS_C = {ID_AERO_RW_TAPS_C, "AERO_RW_TAPS_C", 8, 20, SIGNALS_AERO_RW_TAPS_C, 4};
constexpr MessageDef MSG_AERO_UT_TAPS_A = {ID_AERO_UT_TAPS_A, "AERO_UT_TAPS_A", 8, 20, SIGNALS_AERO_UT_TAPS_A, 4};
constexpr MessageDef MSG_AERO_UT_TAPS_B = {ID_AERO_UT_TAPS_B, "AERO_UT_TAPS_B", 8, 20, SIGNALS_AERO_UT_TAPS_B, 4};
constexpr MessageDef MSG_AERO_AIR = {ID_AERO_AIR, "AERO_AIR", 8, 20, SIGNALS_AERO_AIR, 4};
constexpr MessageDef MSG_AERO_PROBE = {ID_AERO_PROBE, "AERO_PROBE", 8, 20, SIGNALS_AERO_PROBE, 4};
constexpr MessageDef MSG_AERO_WING_LOADS = {ID_AERO_WING_LOADS, "AERO_WING_LOADS", 8, 20, SIGNALS_AERO_WING_LOADS, 2};
constexpr MessageDef MSG_SUSP_DAMPERS = {ID_SUSP_DAMPERS, "SUSP_DAMPERS", 8, 10, SIGNALS_SUSP_DAMPERS, 4};
constexpr MessageDef MSG_SUSP_PUSHRODS = {ID_SUSP_PUSHRODS, "SUSP_PUSHRODS", 8, 10, SIGNALS_SUSP_PUSHRODS, 4};
constexpr MessageDef MSG_IMU_ACCEL = {ID_IMU_ACCEL, "IMU_ACCEL", 8, 10, SIGNALS_IMU_ACCEL, 3};
constexpr MessageDef MSG_IMU_GYRO = {ID_IMU_GYRO, "IMU_GYRO", 8, 10, SIGNALS_IMU_GYRO, 3};
constexpr MessageDef MSG_GPS_POS = {ID_GPS_POS, "GPS_POS", 8, 100, SIGNALS_GPS_POS, 2};
constexpr MessageDef MSG_GPS_VEL = {ID_GPS_VEL, "GPS_VEL", 8, 100, SIGNALS_GPS_VEL, 2};
constexpr MessageDef MSG_WHEEL_SPEEDS = {ID_WHEEL_SPEEDS, "WHEEL_SPEEDS", 8, 20, SIGNALS_WHEEL_SPEEDS, 4};
constexpr MessageDef MSG_DRIVER = {ID_DRIVER, "DRIVER", 8, 20, SIGNALS_DRIVER, 5};
constexpr MessageDef MSG_INV_STATUS = {ID_INV_STATUS, "INV_STATUS", 8, 10, SIGNALS_INV_STATUS, 4};
constexpr MessageDef MSG_INV_TEMPS = {ID_INV_TEMPS, "INV_TEMPS", 8, 100, SIGNALS_INV_TEMPS, 5};
constexpr MessageDef MSG_BMS_PACK = {ID_BMS_PACK, "BMS_PACK", 8, 10, SIGNALS_BMS_PACK, 5};
constexpr MessageDef MSG_BMS_CELL_V_00 = {ID_BMS_CELL_V_00, "BMS_CELL_V_00", 8, 100, SIGNALS_BMS_CELL_V_00, 4};
constexpr MessageDef MSG_BMS_CELL_V_01 = {ID_BMS_CELL_V_01, "BMS_CELL_V_01", 8, 100, SIGNALS_BMS_CELL_V_01, 4};
constexpr MessageDef MSG_BMS_CELL_V_02 = {ID_BMS_CELL_V_02, "BMS_CELL_V_02", 8, 100, SIGNALS_BMS_CELL_V_02, 4};
constexpr MessageDef MSG_BMS_CELL_V_03 = {ID_BMS_CELL_V_03, "BMS_CELL_V_03", 8, 100, SIGNALS_BMS_CELL_V_03, 4};
constexpr MessageDef MSG_BMS_CELL_V_04 = {ID_BMS_CELL_V_04, "BMS_CELL_V_04", 8, 100, SIGNALS_BMS_CELL_V_04, 4};
constexpr MessageDef MSG_BMS_CELL_V_05 = {ID_BMS_CELL_V_05, "BMS_CELL_V_05", 8, 100, SIGNALS_BMS_CELL_V_05, 4};
constexpr MessageDef MSG_BMS_CELL_V_06 = {ID_BMS_CELL_V_06, "BMS_CELL_V_06", 8, 100, SIGNALS_BMS_CELL_V_06, 4};
constexpr MessageDef MSG_BMS_CELL_V_07 = {ID_BMS_CELL_V_07, "BMS_CELL_V_07", 8, 100, SIGNALS_BMS_CELL_V_07, 4};
constexpr MessageDef MSG_BMS_CELL_V_08 = {ID_BMS_CELL_V_08, "BMS_CELL_V_08", 8, 100, SIGNALS_BMS_CELL_V_08, 4};
constexpr MessageDef MSG_BMS_CELL_V_09 = {ID_BMS_CELL_V_09, "BMS_CELL_V_09", 8, 100, SIGNALS_BMS_CELL_V_09, 4};
constexpr MessageDef MSG_BMS_CELL_V_10 = {ID_BMS_CELL_V_10, "BMS_CELL_V_10", 8, 100, SIGNALS_BMS_CELL_V_10, 4};
constexpr MessageDef MSG_BMS_CELL_V_11 = {ID_BMS_CELL_V_11, "BMS_CELL_V_11", 8, 100, SIGNALS_BMS_CELL_V_11, 4};
constexpr MessageDef MSG_BMS_CELL_V_12 = {ID_BMS_CELL_V_12, "BMS_CELL_V_12", 8, 100, SIGNALS_BMS_CELL_V_12, 4};
constexpr MessageDef MSG_BMS_CELL_V_13 = {ID_BMS_CELL_V_13, "BMS_CELL_V_13", 8, 100, SIGNALS_BMS_CELL_V_13, 4};
constexpr MessageDef MSG_BMS_CELL_V_14 = {ID_BMS_CELL_V_14, "BMS_CELL_V_14", 8, 100, SIGNALS_BMS_CELL_V_14, 4};
constexpr MessageDef MSG_BMS_CELL_V_15 = {ID_BMS_CELL_V_15, "BMS_CELL_V_15", 8, 100, SIGNALS_BMS_CELL_V_15, 4};
constexpr MessageDef MSG_BMS_CELL_V_16 = {ID_BMS_CELL_V_16, "BMS_CELL_V_16", 8, 100, SIGNALS_BMS_CELL_V_16, 4};
constexpr MessageDef MSG_BMS_CELL_V_17 = {ID_BMS_CELL_V_17, "BMS_CELL_V_17", 8, 100, SIGNALS_BMS_CELL_V_17, 4};
constexpr MessageDef MSG_BMS_CELL_V_18 = {ID_BMS_CELL_V_18, "BMS_CELL_V_18", 8, 100, SIGNALS_BMS_CELL_V_18, 4};
constexpr MessageDef MSG_BMS_CELL_V_19 = {ID_BMS_CELL_V_19, "BMS_CELL_V_19", 8, 100, SIGNALS_BMS_CELL_V_19, 4};
constexpr MessageDef MSG_BMS_CELL_V_20 = {ID_BMS_CELL_V_20, "BMS_CELL_V_20", 8, 100, SIGNALS_BMS_CELL_V_20, 4};
constexpr MessageDef MSG_BMS_CELL_V_21 = {ID_BMS_CELL_V_21, "BMS_CELL_V_21", 8, 100, SIGNALS_BMS_CELL_V_21, 4};
constexpr MessageDef MSG_BMS_CELL_V_22 = {ID_BMS_CELL_V_22, "BMS_CELL_V_22", 8, 100, SIGNALS_BMS_CELL_V_22, 4};
constexpr MessageDef MSG_BMS_CELL_V_23 = {ID_BMS_CELL_V_23, "BMS_CELL_V_23", 8, 100, SIGNALS_BMS_CELL_V_23, 4};
constexpr MessageDef MSG_BMS_CELL_V_24 = {ID_BMS_CELL_V_24, "BMS_CELL_V_24", 8, 100, SIGNALS_BMS_CELL_V_24, 4};
constexpr MessageDef MSG_BMS_CELL_V_25 = {ID_BMS_CELL_V_25, "BMS_CELL_V_25", 8, 100, SIGNALS_BMS_CELL_V_25, 4};
constexpr MessageDef MSG_BMS_CELL_V_26 = {ID_BMS_CELL_V_26, "BMS_CELL_V_26", 8, 100, SIGNALS_BMS_CELL_V_26, 4};
constexpr MessageDef MSG_BMS_CELL_V_27 = {ID_BMS_CELL_V_27, "BMS_CELL_V_27", 8, 100, SIGNALS_BMS_CELL_V_27, 4};
constexpr MessageDef MSG_BMS_CELL_V_28 = {ID_BMS_CELL_V_28, "BMS_CELL_V_28", 8, 100, SIGNALS_BMS_CELL_V_28, 4};
constexpr MessageDef MSG_BMS_CELL_V_29 = {ID_BMS_CELL_V_29, "BMS_CELL_V_29", 8, 100, SIGNALS_BMS_CELL_V_29, 4};
constexpr MessageDef MSG_BMS_CELL_V_30 = {ID_BMS_CELL_V_30, "BMS_CELL_V_30", 8, 100, SIGNALS_BMS_CELL_V_30, 4};
constexpr MessageDef MSG_BMS_CELL_V_31 = {ID_BMS_CELL_V_31, "BMS_CELL_V_31", 8, 100, SIGNALS_BMS_CELL_V_31, 4};
constexpr MessageDef MSG_BMS_CELL_V_32 = {ID_BMS_CELL_V_32, "BMS_CELL_V_32", 8, 100, SIGNALS_BMS_CELL_V_32, 4};
constexpr MessageDef MSG_BMS_CELL_V_33 = {ID_BMS_CELL_V_33, "BMS_CELL_V_33", 8, 100, SIGNALS_BMS_CELL_V_33, 4};
constexpr MessageDef MSG_BMS_CELL_V_34 = {ID_BMS_CELL_V_34, "BMS_CELL_V_34", 8, 100, SIGNALS_BMS_CELL_V_34, 4};
constexpr MessageDef MSG_BMS_CELL_T_0 = {ID_BMS_CELL_T_0, "BMS_CELL_T_0", 8, 500, SIGNALS_BMS_CELL_T_0, 8};
constexpr MessageDef MSG_BMS_CELL_T_1 = {ID_BMS_CELL_T_1, "BMS_CELL_T_1", 8, 500, SIGNALS_BMS_CELL_T_1, 8};
constexpr MessageDef MSG_BMS_CELL_T_2 = {ID_BMS_CELL_T_2, "BMS_CELL_T_2", 8, 500, SIGNALS_BMS_CELL_T_2, 8};
constexpr MessageDef MSG_BMS_CELL_T_3 = {ID_BMS_CELL_T_3, "BMS_CELL_T_3", 8, 500, SIGNALS_BMS_CELL_T_3, 8};
constexpr MessageDef MSG_BMS_CELL_T_4 = {ID_BMS_CELL_T_4, "BMS_CELL_T_4", 8, 500, SIGNALS_BMS_CELL_T_4, 8};
constexpr MessageDef MSG_BMS_CELL_T_5 = {ID_BMS_CELL_T_5, "BMS_CELL_T_5", 8, 500, SIGNALS_BMS_CELL_T_5, 8};
constexpr MessageDef MSG_BMS_CELL_T_6 = {ID_BMS_CELL_T_6, "BMS_CELL_T_6", 8, 500, SIGNALS_BMS_CELL_T_6, 8};
constexpr MessageDef MSG_BMS_CELL_T_7 = {ID_BMS_CELL_T_7, "BMS_CELL_T_7", 8, 500, SIGNALS_BMS_CELL_T_7, 4};
constexpr MessageDef MSG_COOLING = {ID_COOLING, "COOLING", 8, 100, SIGNALS_COOLING, 5};
constexpr MessageDef MSG_SAFETY = {ID_SAFETY, "SAFETY", 8, 50, SIGNALS_SAFETY, 10};

constexpr MessageDef MESSAGES[] = {
    MSG_AERO_FW_TAPS_A,
    MSG_AERO_FW_TAPS_B,
    MSG_AERO_FW_TAPS_C,
    MSG_AERO_RW_TAPS_A,
    MSG_AERO_RW_TAPS_B,
    MSG_AERO_RW_TAPS_C,
    MSG_AERO_UT_TAPS_A,
    MSG_AERO_UT_TAPS_B,
    MSG_AERO_AIR,
    MSG_AERO_PROBE,
    MSG_AERO_WING_LOADS,
    MSG_SUSP_DAMPERS,
    MSG_SUSP_PUSHRODS,
    MSG_IMU_ACCEL,
    MSG_IMU_GYRO,
    MSG_GPS_POS,
    MSG_GPS_VEL,
    MSG_WHEEL_SPEEDS,
    MSG_DRIVER,
    MSG_INV_STATUS,
    MSG_INV_TEMPS,
    MSG_BMS_PACK,
    MSG_BMS_CELL_V_00,
    MSG_BMS_CELL_V_01,
    MSG_BMS_CELL_V_02,
    MSG_BMS_CELL_V_03,
    MSG_BMS_CELL_V_04,
    MSG_BMS_CELL_V_05,
    MSG_BMS_CELL_V_06,
    MSG_BMS_CELL_V_07,
    MSG_BMS_CELL_V_08,
    MSG_BMS_CELL_V_09,
    MSG_BMS_CELL_V_10,
    MSG_BMS_CELL_V_11,
    MSG_BMS_CELL_V_12,
    MSG_BMS_CELL_V_13,
    MSG_BMS_CELL_V_14,
    MSG_BMS_CELL_V_15,
    MSG_BMS_CELL_V_16,
    MSG_BMS_CELL_V_17,
    MSG_BMS_CELL_V_18,
    MSG_BMS_CELL_V_19,
    MSG_BMS_CELL_V_20,
    MSG_BMS_CELL_V_21,
    MSG_BMS_CELL_V_22,
    MSG_BMS_CELL_V_23,
    MSG_BMS_CELL_V_24,
    MSG_BMS_CELL_V_25,
    MSG_BMS_CELL_V_26,
    MSG_BMS_CELL_V_27,
    MSG_BMS_CELL_V_28,
    MSG_BMS_CELL_V_29,
    MSG_BMS_CELL_V_30,
    MSG_BMS_CELL_V_31,
    MSG_BMS_CELL_V_32,
    MSG_BMS_CELL_V_33,
    MSG_BMS_CELL_V_34,
    MSG_BMS_CELL_T_0,
    MSG_BMS_CELL_T_1,
    MSG_BMS_CELL_T_2,
    MSG_BMS_CELL_T_3,
    MSG_BMS_CELL_T_4,
    MSG_BMS_CELL_T_5,
    MSG_BMS_CELL_T_6,
    MSG_BMS_CELL_T_7,
    MSG_COOLING,
    MSG_SAFETY,
};
constexpr size_t MESSAGE_COUNT = 67;
constexpr size_t SIGNAL_COUNT = 298;
static_assert(sizeof(MESSAGES) / sizeof(MESSAGES[0]) == MESSAGE_COUNT, "message table size");

// ---- Helpers ------------------------------------------------------------------------

/// Raw SNA code of a signal (only meaningful when has_sna).
constexpr int64_t sna_raw(const SignalDef& s) {
    return s.is_signed ? -(int64_t(1) << (s.length - 1)) : (int64_t(1) << s.length) - 1;
}

/// Smallest raw value that encodes a valid reading.
constexpr int64_t raw_min(const SignalDef& s) {
    return s.is_signed ? -(int64_t(1) << (s.length - 1)) + (s.has_sna ? 1 : 0) : 0;
}

/// Largest raw value that encodes a valid reading.
constexpr int64_t raw_max(const SignalDef& s) {
    return s.is_signed ? (int64_t(1) << (s.length - 1)) - 1
                       : (int64_t(1) << s.length) - 1 - (s.has_sna ? 1 : 0);
}

/// True if a decoded (sign-extended) raw value is the SNA code.
constexpr bool is_sna(const SignalDef& s, int64_t raw) {
    return s.has_sna && raw == sna_raw(s);
}

constexpr bool str_equal(const char* a, const char* b) {
    return (*a == *b) && (*a == '\0' || str_equal(a + 1, b + 1));
}

/// Message with the given CAN id, or nullptr.
constexpr const MessageDef* find_message(uint32_t id) {
    for (size_t i = 0; i < MESSAGE_COUNT; ++i) {
        if (MESSAGES[i].id == id) return &MESSAGES[i];
    }
    return nullptr;
}

/// Message with the given name (e.g. "AERO_FW_TAPS_A"), or nullptr.
constexpr const MessageDef* find_message_by_name(const char* name) {
    for (size_t i = 0; i < MESSAGE_COUNT; ++i) {
        if (str_equal(MESSAGES[i].name, name)) return &MESSAGES[i];
    }
    return nullptr;
}

/// Signal of a message by channel id, or nullptr.
constexpr const SignalDef* find_signal(const MessageDef& msg, const char* channel) {
    for (uint8_t i = 0; i < msg.signal_count; ++i) {
        if (str_equal(msg.signals[i].name, channel)) return &msg.signals[i];
    }
    return nullptr;
}

/// Where a channel lives on the bus.
struct SignalRef {
    const MessageDef* message;
    const SignalDef* signal;
    uint8_t index;  // position of the signal inside the message
};

/// Look a channel id up across all messages; {nullptr, nullptr, 0} if unknown.
constexpr SignalRef find_channel(const char* channel) {
    for (size_t m = 0; m < MESSAGE_COUNT; ++m) {
        for (uint8_t i = 0; i < MESSAGES[m].signal_count; ++i) {
            if (str_equal(MESSAGES[m].signals[i].name, channel)) {
                return SignalRef{&MESSAGES[m], &MESSAGES[m].signals[i], i};
            }
        }
    }
    return SignalRef{nullptr, nullptr, 0};
}

static_assert(find_message(ID_AERO_FW_TAPS_A)->id == ID_AERO_FW_TAPS_A, "lookup by id");
static_assert(find_channel("fw_p03").index == 2, "lookup by channel");

}  // namespace can
}  // namespace aerovolt
