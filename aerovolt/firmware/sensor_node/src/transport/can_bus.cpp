// CAN output for Teensy 4.x (FlexCAN_T4) and ESP32 (TWAI). See can_bus.h.
#include "can_bus.h"

#include "node_config.h"

#if AV_USE_CAN

#include <Arduino.h>
#include <string.h>

#if defined(__IMXRT1062__)
// ------------------------------------------------------------------ Teensy 4.0 / 4.1
#include <FlexCAN_T4.h>

static FlexCAN_T4<CAN1, RX_SIZE_16, TX_SIZE_32> can1;

bool can_bus_begin(uint32_t bitrate) {
    can1.begin();
    can1.setBaudRate(bitrate);
    return true;
}

bool can_bus_send(uint32_t id, const uint8_t data[8]) {
    CAN_message_t msg;
    msg.id = id;
    msg.flags.extended = 0;  // 11-bit identifier
    msg.len = 8;
    memcpy(msg.buf, data, 8);
    return can1.write(msg) == 1;  // 1 = queued, 0 = no free mailbox / queue full
}

void can_bus_poll(uint32_t now_ms) {
    (void)now_ms;  // FlexCAN recovers from bus-off by itself (automatic recovery)
}

#elif defined(ESP32)
// ------------------------------------------------------------------ ESP32 (TWAI)
#include "driver/twai.h"

static bool g_twai_running = false;
static uint32_t g_next_check_ms = 0;

bool can_bus_begin(uint32_t bitrate) {
    twai_general_config_t general = TWAI_GENERAL_CONFIG_DEFAULT(
        static_cast<gpio_num_t>(node_config::PIN_CAN_TX), static_cast<gpio_num_t>(node_config::PIN_CAN_RX),
        TWAI_MODE_NORMAL);
    general.tx_queue_len = 32;
    // Bit timing presets from the ESP-IDF (80 MHz APB clock).
    const twai_timing_config_t timing_1m = TWAI_TIMING_CONFIG_1MBITS();
    const twai_timing_config_t timing_500k = TWAI_TIMING_CONFIG_500KBITS();
    const twai_timing_config_t timing_250k = TWAI_TIMING_CONFIG_250KBITS();
    const twai_timing_config_t* timing = &timing_1m;
    if (bitrate == 500000) timing = &timing_500k;
    if (bitrate == 250000) timing = &timing_250k;
    const twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
    if (twai_driver_install(&general, timing, &filter) != ESP_OK) return false;
    g_twai_running = twai_start() == ESP_OK;
    return g_twai_running;
}

bool can_bus_send(uint32_t id, const uint8_t data[8]) {
    if (!g_twai_running) return false;
    twai_message_t msg = {};
    msg.identifier = id;
    msg.extd = 0;  // 11-bit identifier
    msg.data_length_code = 8;
    memcpy(msg.data, data, 8);
    return twai_transmit(&msg, 0) == ESP_OK;  // never block the loop
}

void can_bus_poll(uint32_t now_ms) {
    if (static_cast<int32_t>(now_ms - g_next_check_ms) < 0) return;
    g_next_check_ms = now_ms + 100;
    twai_status_info_t status;
    if (twai_get_status_info(&status) != ESP_OK) return;
    if (status.state == TWAI_STATE_BUS_OFF) {
        g_twai_running = false;
        twai_initiate_recovery();  // waits for 128 x 11 recessive bits, then STOPPED
    } else if (status.state == TWAI_STATE_STOPPED) {
        g_twai_running = twai_start() == ESP_OK;
    }
}

#else
#error "AV_USE_CAN=1 needs a Teensy 4.x (FlexCAN_T4) or an ESP32 (TWAI); use AV_USE_CAN=0 on this board"
#endif

#endif  // AV_USE_CAN
