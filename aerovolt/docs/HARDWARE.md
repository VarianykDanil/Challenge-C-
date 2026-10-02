# AeroVolt hardware guide — Phase 2: connect real sensors

This guide takes you from the simulator to real sensors in three steps:

| Phase | What runs | Hardware |
|---|---|---|
| 1. Demo | `python -m aerovolt` — the virtual car, every channel simulated | none |
| **2. Bench** | one real pressure sensor drives **one tap of the 3D car** (front wing tap 3, `fw_p03`); everything else stays simulated | Arduino Nano + 1 SDP sensor + BME280, about £50–75 |
| 3. Car | a front aero node on the car's CAN bus (`config/car_can.yaml`) | Teensy 4.1 or ESP32 + 9 SDP sensors + mux + CAN transceiver |

Everything the firmware does is in `firmware/sensor_node/` (PlatformIO). The sensors and
channels of a node are listed in **`firmware/sensor_node/include/node_config.h`** — the
only firmware file you normally edit.

> **No hardware yet?** `python tools/fake_sensor_node.py --pty` emulates the bench node on a
> virtual serial port and prints the exact command that starts AeroVolt with it.

---

## 1. Safety first (read this before touching the car)

* **AeroVolt is read-only with respect to the tractive system (TS).** Its sensor nodes are
  low-voltage (GLV) devices. They never connect to anything on the high-voltage side: cell
  voltages, pack current and temperatures reach AeroVolt **only** through the BMS and the
  inverter, which provide the galvanic isolation, over the CAN bus.
* **Never put an AeroVolt node in the shutdown circuit (SDC)**, never let it drive a relay,
  an AIR, a precharge circuit or anything that can enable the TS. If AeroVolt crashes, the
  car must not notice.
* On the CAN bus the node only **transmits its own aero IDs** (0x300–0x312). It must never
  use an ID of a safety-relevant controller (BMS, inverter, VCU) — check your car's master
  DBC — and must be tested on the bench at the right bit rate first: a node with the wrong
  bit rate floods the bus with error frames and can disturb the whole car.
* Follow the **Formula Student rules** (the EV / tractive-system sections) and your
  **team's HV procedures**: only people authorised by your ESO (Electrical System Officer)
  work near the accumulator or the TS; check the TSAL and use lock-out / tag-out before any
  work; wear the specified PPE.
* Route sensor cables and tubes away from HV cables, motor phases and the inverter (they
  are noisy and get hot), and never through the accumulator container.
* On the bench, power everything from USB or a current-limited bench supply.

---

## 2. Bill of materials

Prices are **approximate** UK prices (GBP, incl. VAT, 2025–26, from the usual distributors
such as Farnell, RS, Mouser, DigiKey, The Pi Hut, Pimoroni, and marketplaces) and change
often — treat them as a budget guide, not a quote. Sponsors and university stores are often
cheaper.

### 2.1 Phase-2 bench kit (Arduino Nano, one tap)

| Qty | Part | Notes | Approx. £ |
|---|---|---|---|
| 1 | Arduino Nano (ATmega328P), or a clone | the classic Nano, not the Nano Every | 5 (clone) – 22 |
| 1 | Sensirion **SDP810-500Pa** (or SDP31) differential pressure sensor | ±500 Pa, I²C, CRC-checked, essentially drift-free | 30 – 40 |
| 1 | BME280 breakout, **5 V-safe** (on-board regulator + level shifter) | ambient T, p, RH for air density | 5 – 18 |
| 1 | I²C level shifter (BSS138, 4-channel) | only if the SDP/BME boards are 3.3 V-only | 2 – 4 |
| 2 | 4.7 kΩ resistors | I²C pull-ups (if the boards have none) | < 1 |
| 1 m | silicone tube, ~1–1.5 mm inner diameter (1/16") | sensor ports are ~4–5 mm barbs: use a short adapter sleeve | 3 – 8 |
| 1 | breadboard + jumper wires + USB cable (data, not charge-only!) | | 8 – 12 |
| 1 | 10–20 ml syringe | leak tests, controlled "blowing" | 1 – 2 |
| | **Total** | | **≈ £50 – 75** |

### 2.2 Front aero node (car, CAN)

| Qty | Part | Notes | Approx. £ |
|---|---|---|---|
| 1 | Teensy 4.1 (or ESP32 DevKitC) | CAN controller on board (FlexCAN / TWAI) | 35 – 42 (ESP32: 8 – 12) |
| 8 | SDP810-500Pa | front-wing taps fw_p01…fw_p08 (see §4 for higher-range parts) | 240 – 320 |
| 1 | SDP31 (address 0x21) or higher-range part for the pitot | see §4 | 30 – 40 |
| 1 | TCA9548A I²C multiplexer breakout | eight sensors share address 0x25 | 3 – 8 |
| 1 | BME280 breakout (3.3 V) | | 5 – 15 |
| 1 | SN65HVD230 CAN transceiver breakout (3.3 V) | | 3 – 6 |
| 2 | 120 Ω resistors (if your bus has no terminations yet) | one at each **end** of the bus | < 1 |
| 1 | Prandtl (pitot-static) tube | drone/model-aircraft airspeed pitot is fine | 15 – 40 |
| 1 | HX711 board + 50 kg S-beam load cell (optional, `fw_load`) | wing-mount load | 25 – 45 |
| 2 | 75 mm linear potentiometers (optional, `damper_fl/fr`) | hobby grade; motorsport damper pots cost £100+ each | 40 – 80 |
| | twisted-pair cable, automotive connectors (e.g. Deutsch DTM), heat-shrink, enclosure | | 30 – 60 |
| | stainless hypodermic tube 1.0–1.5 mm OD for the taps, 5 m silicone tube | | 10 – 20 |
| 1 | USB-CAN adapter for the PC (candleLight / CANable, gs_usb or slcan) | bench testing and the pit laptop | 15 – 35 |
| | **Total** (without optional parts) | | **≈ £400 – 550** |

---

## 3. Wiring

### 3.1 Phase-2 bench node (Arduino Nano, `BENCH_ONE_TAP`)

The Nano is a **5 V** board. The SDP and BME280 are 3.3 V parts: use 5 V-safe breakouts
(regulator + level shifter on the board) or a BSS138 level shifter between the Nano and the
sensors. **Never** connect a bare 3.3 V sensor's SDA/SCL to 5 V pull-ups.

```
   Arduino Nano                  level shifter (if needed)            3.3 V side
  +------------+                +-------------------------+
  |        5V  |----------------| HV                   LV |---------- 3.3 V  (Nano 3V3 pin
  |       3V3  |-------------+--|                         |              or the BME board's
  |       GND  |-------+-----|--| GND                 GND |--+          regulator output)
  |  A4 (SDA)  |-------|-----|--| HV1                 LV1 |--|---+---------------+--- SDA
  |  A5 (SCL)  |-------|-----|--| HV2                 LV2 |--|---|---+-----------|-+- SCL
  |   USB  ====|=== to PC     |  +-------------------------+  |   |   |           | |
  +------------+       |     |                               |  [4.7k] [4.7k]     | |
                       |     +-------------------------------|---+---+ (to 3.3 V) | |
                       |                                     |                    | |
                       |      +--------------------+         |   +-------------+  | |
                       |      | SDP810  (0x25)     |         |   | BME280      |  | |
                       |      |  VDD  <- 3.3 V     |         |   |  VIN <- 3.3V|  | |
                       +------|  GND               |---------+---|  GND        |  | |
                              |  SDA  -------------|-------------|--SDA -------|--+ |
                              |  SCL  -------------|-------------|--SCL -------|----+
                              |  port "+" <- tube to the tap     |  SDO -> GND | (address 0x76)
                              |  port "-" <- reference / open    +-------------+
                              +--------------------+
```

* The firmware finds the SDP by itself (it tries 0x25, 0x21, 0x26, 0x22, 0x23).
* `+` port = tap side, `-` port = reference: blowing into `+` gives a **positive** reading.
* Keep I²C wires short (< 30 cm on a breadboard).

### 3.2 Front aero node (Teensy 4.1 / ESP32, `AERO_FRONT`)

Eight SDP810s share the fixed address 0x25, so each one sits on its own channel of a
**TCA9548A** multiplexer (address 0x70). The firmware enables exactly one channel before
each read. The pitot sensor (an SDP31 at 0x21) and the BME280 (0x76) are on the main bus.

```
 Teensy 4.1 (3.3 V logic!)                     TCA9548A (0x70, A0..A2 = GND)
 +----------------+   SDA 18 / SCL 19         +-----------------------------+
 |  3V3 ----------|---------+-----------------| VIN                    SD0/SC0 |-- SDP810 fw_p01 (0x25)
 |  GND ----------|-------+-|-----------------| GND                    SD1/SC1 |-- SDP810 fw_p02
 |  18 (SDA) -----|-----+-|-|-----------------| SDA                    SD2/SC2 |-- SDP810 fw_p03
 |  19 (SCL) -----|---+-|-|-|-----------------| SCL                      ...   |   ...
 |                |   | | | |   [4.7k] x2     | RST -> 3V3             SD7/SC7 |-- SDP810 fw_p08
 |  22 (CTX1) ----|-+ | | | +--- pull-ups ----|                              |   (4.7k pull-ups to
 |  23 (CRX1) ----|-|+| | |                   +------------------------------+    3V3 on EVERY
 |  14 (A0)  <----|-||+-|-|-- damper_fl pot wiper (100k pull-down)                downstream channel)
 |  15 (A1)  <----|-|||-|-|-- damper_fr pot wiper (100k pull-down)
 |   2 <- DOUT ---|-|||-|-|-- HX711 (fw_load), 3 -> SCK, RATE pin high (80 Hz)
 +----------------+ ||| | |
                    ||| | +---- SDP31 pitot_dp (0x21) on the main bus
                    ||| +------ BME280 (0x76) on the main bus
                    |||
          +---------+||          SN65HVD230 CAN transceiver
          |  +-------+|         +-------------------------+
          |  |        +---------| D  (TXD)          CANH  |=====+==== CAN_H  (twisted pair
          |  +------------------| R  (RXD)          CANL  |=====|=+== CAN_L   to the car bus)
          |      3V3 -----------| VCC                     |     | |
          |      GND -----------| GND                     |    [120 Ω] only if this node is
          |      GND -----------| Rs (pin 8: low = 1 Mbit/s slope) |    at one END of the bus
          +---------------------+-------------------------+     | |
```

ESP32 DevKitC: SDA = GPIO21, SCL = GPIO22, CAN TX = GPIO5, CAN RX = GPIO4, damper pots on
GPIO36/39 (ADC1 — ADC2 stops working when Wi-Fi is on), HX711 on GPIO16/17. The ESP32 ADC is
noticeably non-linear: always calibrate pots with two points (`av::linear_pot_two_point`).

**I²C over distance.** I²C is an on-board bus: at 400 kHz the total bus capacitance must
stay under 400 pF (roughly 1–2 m of cable). Put **all the pressure sensors on one small board
in the nose next to the mux** and run *tubes* to the taps, not I²C wires. If you must run
I²C further, drop to 100 kHz (`I2C_CLOCK_HZ` in `node_config.h`), use 2.2 kΩ pull-ups and
twisted pairs (SDA+GND, SCL+GND).

### 3.3 CAN bus rules

```
   node A            node B (AeroVolt)        node C (BMS)         node D (PC adapter)
  [120 Ω]               |                        |                    [120 Ω]
 ===+=====================+========================+======================+===  CAN_H
 ===+=====================+========================+======================+===  CAN_L
   end of bus        short stub (< 30 cm)                            end of bus
```

* **Exactly two 120 Ω terminations, at the two physical ends.** Check with the power off:
  the resistance between CAN_H and CAN_L must be **≈ 60 Ω** (two 120 Ω in parallel).
  120 Ω = one termination missing; 40 Ω = one too many (many breakout boards have a 120 Ω
  resistor fitted — remove it or open its jumper when the node is not at a bus end).
* Twisted pair (about one twist per 2–3 cm), a common ground, short stubs.
* **One bit rate for everybody: 1 Mbit/s** (`CAN_BITRATE`, `config/car_can.yaml`).
* **The layout is code.** `config/can_layout.yaml` is the single source of truth;
  `python tools/gen_can.py` regenerates `can/aerovolt.dbc` and the firmware header
  `include/aerovolt_can.h`. Never hand-edit either; commit them together; `gen_can.py --check`
  fails when they are stale.
* One sender per ID. **Lower IDs win arbitration**: if your car's BMS/inverter/VCU use IDs
  above 0x300, move the AeroVolt block in `can_layout.yaml` above them and regenerate —
  telemetry must never delay safety-relevant traffic.
* Keep the bus load below ~30–40 %. The complete AeroVolt layout (67 frames) uses about
  **23 %** of 1 Mbit/s (worst-case stuffed 8-byte frames).
* "Signal not available" (SNA): a node that owns only part of a frame sends the rest as SNA
  (0x8000 signed / 0xFFFF unsigned), and receivers never overwrite real values with it.
  The bench node does exactly that: it owns `fw_p03` of `AERO_FW_TAPS_A` and sends
  `fw_p01/02/04` as SNA. A sensor that fails is also sent as SNA, never as a frozen number.
* A node alone on a bus gets no ACK and keeps retrying: connect the PC adapter (it ACKs) when
  testing. The firmware reports this as `$AVS warn "CAN: n frames not sent ..."`.

---

## 4. Which pressure sensor where (range!)

Tap pressure = Cp × q, with q = ½ ρ v² (ρ ≈ 1.2 kg/m³):

| car speed | 15 m/s (54 km/h) | 20 m/s | 25 m/s (90 km/h) | 28.9 m/s (104 km/h) | 33 m/s (120 km/h) |
|---|---|---|---|---|---|
| q | 135 Pa | 240 Pa | 375 Pa | 500 Pa | 665 Pa |

| location | typical Cp | p at 25 m/s | ±500 Pa SDP OK up to | recommendation |
|---|---|---|---|---|
| wing pressure side | +0.3 … +0.8 | +110 … +300 Pa | 32 m/s and more | SDP810-500Pa |
| wing suction side, aft (x/c ≥ 0.45) | −0.8 … −1.6 | −300 … −600 Pa | 23–32 m/s | SDP810-500Pa (saturates near top speed) |
| front-wing suction peak (x/c 0.05–0.2) | −2.6 … −3.5 | −1000 … −1300 Pa | 15–18 m/s | ±2.5 kPa or ±1 psi part |
| **undertray throat / diffuser tunnels** | −1.5 … −2.5 | −560 … −940 Pa | 18–24 m/s | **±2.5 kPa or ±1 psi part** |
| pitot (q) | +1.0 | +375 Pa | 28.9 m/s (104 km/h) | SDP31 for low speed; ±1 psi part for full speed |

Higher-range options (approximate prices): TE **MS4525DO** ±1 psi (±6.9 kPa) differential,
I²C — the standard drone airspeed sensor (£25–40); Honeywell **ABP2/TruStability** ±2.5 kPa
differential (£30–50); NXP **MPXV7002DP** ±2 kPa analog (£10–20, noisy, needs an ADC and its
own zero calibration). They have larger zero errors than the SDP, so the zero calibration in
§7 matters even more. The catalogue range of every tap is ±3200 Pa (`config/sensors.yaml`).

**Saturation is reported, not hidden:** when an SDP reaches the end of its range the firmware
sends "not available" (`nan` / SNA) and `$AVS warn "fw_p01: over range (> 500 Pa)"` — a clipped
value would give a wrong Cp, which is worse than no Cp.

---

## 5. Pressure taps and tubing

```
        flow --->                                  wing skin (lower = suction surface)
   ________________________________________________________________________
   ////////////////////////////|  |//////////////////////////////////////////   <- flush, square,
                               |  |  <- tap hole 0.5–1.0 mm, drilled            deburred edge,
                               |  |     PERPENDICULAR to the surface            no burr, no dimple
                              _|  |_
                             | stainless hypodermic tube, 1.0–1.5 mm OD, epoxied flush
                             |______|
                               ||
                               ||  silicone tube ~1–1.5 mm ID, SHORT and ALL THE SAME LENGTH
                               ||
                        [SDP "+" port]      [SDP "-" port] <---- reference manifold
```

* **Flush and square.** The tap must not disturb the flow it measures: drill perpendicular
  to the skin, deburr, fill any dimple; a raised burr reads a stagnation pressure, a
  countersink reads suction.
* **Short, equal tubes.** Every tube is a pneumatic low-pass filter. Its time constant is
  τ ≈ R·C with the Poiseuille resistance R = 128 μ L / (π d⁴) and the capacitance
  C = V / p of the air volume V:
  * 0.5 m of 1 mm tube (+ 0.1 ml sensor volume): τ ≈ 2 ms;
  * 2 m of 1 mm tube: τ ≈ 25 ms (τ grows with L², because R *and* V grow with L).
  At 50 Hz this is fine for aero maps, **if all taps have the same tube length** — otherwise
  they lag differently and a transient (braking, a gust) shows up as a fake Cp change. The
  simulator models this lag (`lag_s` in `sensors.yaml`).
* **Flow-through sensors.** The SDP works thermally: a tiny flow passes *through* the sensor.
  Long, thin tubes therefore cause a small gain error, not only lag — keep them short and
  check one channel against a reference manometer (Sensirion publishes an application note
  on tube-length compensation).
* **Reference ("static") port.** Every tap is measured against the **freestream static
  pressure**, so `Cp = tap / q` directly (SPEC §2.1). Take it from the static ring of the
  pitot-static (Prandtl) tube, into a small manifold, and connect all SDP `-` ports to it with
  equal tubes. A reference in the cockpit or the sidepod gives every tap a speed-dependent
  offset — avoid.
* **Hydrostatic head.** A tap 0.6 m above the reference sees ρ g Δh ≈ 7 Pa of offset at
  standstill. It is constant, so the zero calibration (§7) removes it — run the calibration
  with the car on its wheels, tubes in their final position.
* **Leak test** (every tap, before every event): disconnect the tube at the sensor, push a
  syringe onto it, seal the tap on the wing with tape, press the plunger a few mm and let go:
  it must spring back fully. Then the **blow test**: blow gently on each tap in turn (or use
  the syringe with a soft rubber cup) and check that the *right* channel responds on the
  dashboard — swapped tubes are the most common mistake. A leaking tap reads a fraction of
  its neighbours; AeroVolt's anomaly detector flags it as a **sensor** fault
  (`sensor_tap_anomaly`), not an aero problem (the simulator's `tap_leak` fault shows this).
* **Pitot** (`pitot_dp` = total − static = q): on a boom ahead of the nose and above it
  (vehicle.yaml: x = 0.95 m, z = 0.45 m), out of the car's own pressure field, aligned with
  the car's x axis. Cover it (tape, cap) whenever the car is parked, especially during the
  zero calibration — wind on a parked car is enough to fake an offset.

```
   Prandtl tube, pointing forward
   =====================(o)<-- total pressure hole (front)  ---- tube ---> SDP31 "+"
         ||    ||   <-- static ring holes (side)            ---- tube ---> SDP31 "-" and the
                                                                            tap reference manifold
```

---

## 6. Firmware

```
firmware/sensor_node/
  platformio.ini            envs teensy41, esp32dev, nano_serial
  include/node_config.h     WHAT IS CONNECTED WHERE  (edit this)
  include/aerovolt_can.h    CAN layout - GENERATED by tools/gen_can.py (do not edit)
  lib/avcore/               portable C++17 core, no Arduino: CAN packing (bit-exact with
                            cantools), $AV lines + NMEA checksum, Sensirion CRC + SDP
                            conversion, BME280 compensation, pot/HX711 calibration, filters,
                            cycle scheduler
  src/main.cpp, node.cpp    the application: read sensors, publish serial lines + CAN frames
  src/drivers/              our own drivers: SDP3x/SDP8xx, TCA9548A, BME280, HX711, I2C helpers
  src/transport/            $AV serial output, CAN (FlexCAN_T4 on Teensy, TWAI on ESP32)
  test/host/                PC tests (make test) and the firmware-in-the-loop simulator
```

Build and upload (install PlatformIO: `pip install platformio`, or the VS Code extension):

```
cd firmware/sensor_node
pio run -e nano_serial -t upload        # bench node
pio run -e teensy41 -t upload           # front node, CAN + USB
pio device monitor -b 115200            # watch the lines; Ctrl+C to quit
```

What the node prints (SPEC §7.1, checksum = XOR of the bytes between `$` and `*`):

```
$AVH,BENCH,1.0.0,fw_p03,amb_temp,amb_press,amb_rh*51          hello: at boot and every 5 s
$AVS,BENCH,29,ok,boot: 1/1 pressure sensors, ambient ok*1A     status (ok | warn | error)
$AV,BENCH,52,fw_p03=-412.5*7F                                   data, 50 Hz
$AV,BENCH,132,fw_p03=-411.9,amb_temp=25.08,amb_press=100653,amb_rh=55.0*28   ambient at 1 Hz
```

Sensor errors are reported, retried every second and cleared automatically:
`$AVS,...,error,fw_p03: stopped answering` → values `nan` / SNA → `$AVS,...,ok,fw_p03: recovered`.

**Testing without a board.** `make -C firmware/sensor_node/test/host test` runs the avcore unit
tests and then the *real firmware* (`setup()`/`loop()`) on the PC against emulated sensors
(SDPs behind a mux, BME280, HX711) — including unplugging a sensor and checking the error,
`nan`/SNA and recovery. `tests/test_firmware_cross.py` checks that the firmware's CAN bytes
equal cantools' encoding of the DBC for thousands of random values (bit for bit), and that the
Python parser accepts every line the firmware prints.

---

## 7. Phase-2 bench demo, step by step

1. **Wire** the Nano, the SDP810 and the BME280 as in §3.1. Put ~20 cm of silicone tube on
   the SDP `+` port; leave `-` open to the room.
2. **Upload**: `cd firmware/sensor_node && pio run -e nano_serial -t upload`.
3. **Check**: `pio device monitor -b 115200`. You should see the `$AVH` hello, an `$AVS ... ok,boot`
   line and 50 `$AV` lines per second; blow gently into the tube and `fw_p03` goes up, suck
   and it goes negative. **Close the monitor** — only one program can open the port.
4. **Zero**: with no airflow (tube end covered, no fans) run
   `python tools/calibrate_taps.py --port auto` (or `--port /dev/ttyUSB0`, `COM5`). It averages
   10 s, prints mean and standard deviation, **refuses** if the air is moving, and writes
   `fw_p03: {offset: ...}` into `config/calibration.yaml`.
5. **Run AeroVolt**: `python -m aerovolt --config config/hybrid_serial.yaml --open`
   (`port: auto` finds the node by its hello; or put the port name in the file).
6. **Show it**: the header badge says **HYBRID**; the *Sensors* tab shows `fw_p03` owned by
   `serial`; on the *Aero* tab, front-wing tap 3 (left station, suction side) on the 3D car
   follows your breath — blowing makes it red (pressure), sucking blue (suction) — and its Cp
   and the section Cl react, while the virtual car keeps lapping.
7. **Pull the USB cable**: within 1 s the simulated value takes over again and the source
   shows `waiting`; plug it back in and it reconnects within 2 s. That is the priority rule of
   the source manager (later sources win while they are alive).

No hardware? `python tools/fake_sensor_node.py --pty` does steps 1–3 in software: it prints the
pseudo-terminal path and the exact `python -m aerovolt --config ...` command (a copy of
`hybrid_serial.yaml` pointing at that port); press Enter to "blow". Other patterns: `steady`,
`sweep`, `drive` (a lap-like speed trace, every tap = Cp × ½ρv²), `--offset fw_p03=3.4`
(a sensor zero error for `calibrate_taps.py` to find), `--fail-at 20` (sensor drop-out), and
`--can vcan0` (CAN frames instead of serial; create vcan0 with
`sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 up`).

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing in the serial monitor | wrong baud; charge-only USB cable; wrong board selected | 115200 baud; a data cable; `pio device list` |
| Upload fails "not in sync" (Nano) | old bootloader clone | `board = nanoatmega328` in `platformio.ini` |
| AeroVolt source `waiting: port ... not found` | wrong port name; another program has the port open | close the serial monitor / Arduino IDE; check `pio device list` |
| `Permission denied: /dev/ttyUSB0` (Linux) | user not in the `dialout` group | `sudo usermod -aG dialout $USER`, log out and in |
| `$AVS error fw_p03: no SDP sensor at 0x25/0x21/...` | SDA/SCL swapped; no pull-ups; no power; 3.3 V/5 V mismatch | check wiring with §3.1; run an I²C scanner sketch |
| `$AVS error ...: CRC errors` | long or unshielded I²C wires, weak pull-ups, too fast | shorter wires; 2.2–4.7 kΩ pull-ups; `I2C_CLOCK_HZ 100000` |
| `$AVS error ... (mux channel n)` only for some taps | that channel's wiring or pull-ups | swap the sensor to another channel to tell sensor from wiring |
| `$AVS error TCA9548A I2C mux not found at 0x70` | mux address pins, RST floating | A0–A2 to GND, RST to 3V3 |
| `$AVS warn ...: over range (> 500 Pa)` | real pressure beyond the sensor | higher-range sensor at that location (§4) |
| Tap reads the opposite sign | tubes on `+`/`-` swapped | swap the tubes (`+` = tap) |
| Tap reads a fraction of its neighbours, sluggish | leak, kinked or water-blocked tube | leak test (§5); dashboard flags `sensor_tap_anomaly` |
| Two taps look swapped on the 3D car | tubes swapped between sensors | blow test, tap by tap (§5) |
| Offset of a few Pa at standstill | sensor zero, tube heights, wind | `tools/calibrate_taps.py`; cover the pitot |
| `calibrate_taps.py` says REFUSED | air moving, vibration, loose tube | close doors, stop fans, wait, retry |
| `amb_temp` 2–3 °C too high | BME280 heated by the electronics or the sun | mount it away from the board, shaded and ventilated |
| PC sees no CAN frames | termination, bit rate, CANH/CANL swapped, transceiver unpowered, Rs pin high | measure 60 Ω; 1 Mbit/s everywhere; Rs (pin 8) to GND |
| `$AVS warn CAN: n frames not sent` | the node is alone on the bus (no ACK) | connect the PC adapter or another node |
| CAN error frames / bus-off | bit-rate mismatch, missing/extra termination, two senders on one ID | fix the bus; the ESP32 firmware recovers from bus-off automatically |
| `$AVS error fw_load: no data from HX711` | DOUT/SCK pins, no power, RATE pin | check pins in `node_config.h`; RATE high = 80 Hz |
| `$AVS error fw_load: HX711 saturated` | bridge wire open (E±/A±) or overload | check the 4 load-cell wires |
| `$AVS error damper_fl: reading ... outside ...` | pot wire broken (wiper pulled to 0 V) or shorted | check the connector; recalibrate the two points |
| Dashboard still shows the simulated value | the serial source's `channels` list does not include it, or the node stopped | `hybrid_serial.yaml` → `channels`; *Sensors* tab shows the owner |
