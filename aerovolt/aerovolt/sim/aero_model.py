"""Aerodynamics of the virtual car: air, wind, element downforce and surface pressures.

Air and wind
------------
Air density follows from the weather with :func:`physics.moist_air_density`. The wind is a
mean wind (config ``wind_ms`` from ``wind_dir_deg``) plus **gusts**: speed and direction
each follow an Ornstein–Uhlenbeck process (random, mean-reverting, with a correlation time
of seconds — how turbulence in the atmospheric boundary layer behaves). The car moves
through this air, so the flow it feels is the vector difference::

    v_rel = w − v_car                 (track frame, east/north)
    airspeed V = |v_rel|,   q = ½·ρ·V²
    flow yaw ψ = atan2(lateral component from the left, head-on component)

so airspeed ≠ ground speed and a cross wind produces yaw (+ = flow from the left).

Element downforce
-----------------
The car has three downforce elements (front wing ``fw``, rear wing ``rw``, undertray ``ut``)
with reference shares of the total CL·A (``vehicle.yaml: aero``). Each element's CL·A is the
reference value times dimensionless factors:

* **Ground effect** — the front wing and the floor work better close to the ground (the
  air under them is accelerated more, so the suction grows)::

      factor = 1 + gain · (h_ref − h)        (h in mm, gain per mm from vehicle.yaml)

  and they **stall** below a critical height (flow separation, sharp loss of
  ``stall_loss``), modelled with a 1 mm-wide logistic step around the stall height. The
  floor's criterion is its minimum clearance (normally the leading edge) and it has
  **hysteresis**: once separated, the diffuser only reattaches 4 mm higher.
* **Pitch** — nose-down pitch lowers the rear wing's angle of attack:
  ``1 − pitch_gain·Δθ`` (the front wing and floor feel pitch through their ride heights).
* **Yaw** — ``1 − k·ψ²`` on each element; the *windward* station loses ``2·k·ψ²`` and the
  leeward station nothing, so outboard taps on the windward side react first.
* **Faults** — damaged left front-wing flap (left station circulation × 0.5), rear-wing
  flap stall (× 0.6, CD·A × 0.9).

Downforce ``L_e = q · CL·A_e`` acts at the element's centre of pressure; moments about the
axles split it into front and rear axle loads. Drag ``D = q · CD·A`` with an induced-drag
term (more downforce → more drag) and a yaw term.

Surface pressures (the 32 taps)
-------------------------------
Wing taps use **thin-aerofoil theory**. A cambered aerofoil at an angle of attack is replaced
by a vortex sheet on its camber line whose strength (Glauert series, first two terms) is::

    γ(x)/(2U) = a·√((1 − x)/x) + b·√(x·(1 − x))          (x = x/c)

the ``a`` term is the leading-edge (angle-of-attack) loading, the ``b`` term the camber
loading. The surface velocities are ``U·(1 + t ± λ·γ/2U)`` (``t``: thickness speed-up,
``λ``: circulation factor of the station) and Bernoulli gives::

    Cp = 1 − (u / U)²       (suction surface: +, pressure surface: −)

This produces the classic shape — a suction peak near the leading edge followed by pressure
recovery, a positive pressure surface — and Cp is bounded by 1 (stagnation) by construction.
The pressure *difference* is linear in λ, so the tap-integrated section Cl
(:func:`physics.section_cl`) scales with the element CL·A: that is the calibration the
tests check (within 10 %).

The undertray is a **venturi**: continuity (``u·h = const``) between the floor and the
diffuser exit gives ``Cp(x) = Cp_base + κ²·(1 − (h_exit/h(x))²)``, so the suction peaks at
the throat (x/L = 0.4) and recovers along the diffuser. A stalled diffuser loses its pressure
recovery (aft taps stay at a separated-flow plateau) and the whole floor's suction drops.

The **effective area** that links a station's section Cl to its element CL·A
(``CL·A = Cl_section · A_eff``) is computed from the reference distributions. For the front
wing it is ≈ the planform area; for the two-element rear wing it is larger than the main-plane
planform because the (untapped) flap carries about a third of the load; for the floor it is
smaller than the floor area because suction falls off towards the floor edges. On the real
car A_eff is calibrated against the wing-mount load cells (``fw_load``, ``rw_load``).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from aerovolt.core import physics
from aerovolt.core.model import ChannelDef
from aerovolt.sim.sensors import OrnsteinUhlenbeck

# ---------------------------------------------------------------------------- constants
#: Thin-aerofoil loading of each wing (a, b, thickness speed-up suction / pressure side).
#: Chosen so the reference suction peaks are ≈ −2.9 (front, in ground effect) and ≈ −2.5
#: (rear) and the pressure side is +0.7…+0.9 — inside the SPEC §5.4 Cp ranges.
WING_LOADING = {
    "fw": (0.16, 0.95, 0.06, 0.10),
    "rw": (0.15, 0.80, 0.05, 0.12),
}
#: Separated-flow pressure coefficient on the aft suction surface of a stalled flap.
SEPARATED_CP = -0.45
#: Taps at or behind this chord fraction lie in the separated region of a stalled rear wing.
REAR_WING_SEPARATION_XC = 0.40
#: Rear-wing CL·A and CD·A factors when the flap stalls (SPEC §5.5: −40 %, −10 %).
RW_STALL_CLA = 0.60
RW_STALL_CDA = 0.90
#: Left front-wing station circulation factor with a damaged flap (→ suction −55 %).
FW_DAMAGE_CIRCULATION = 0.50

#: Venturi model of the undertray: channel height [mm] vs floor fraction, base pressure.
FLOOR_HEIGHT_PROFILE_MM = ((0.0, 70.0), (0.4, 30.0), (0.6, 34.0), (0.8, 55.0), (1.0, 120.0))
FLOOR_BASE_CP = -0.15
FLOOR_THROAT_CP = -1.9
#: The diffuser tunnels (ut_p07/08) run with a little more suction than the centreline.
TUNNEL_SUCTION_FACTOR = 1.15
#: Separated-flow plateau in a stalled diffuser (fraction > 0.4).
FLOOR_SEPARATED_CP = -0.35
#: Throat position (fraction of the floor length) where the floor height is evaluated.
FLOOR_THROAT_FRACTION = 0.4
#: Width of the logistic stall step [mm].
STALL_WIDTH_MM = 1.0
#: Diffuser stall hysteresis [mm]: separated flow only reattaches this much above the stall
#: height (well known from wind-tunnel ride-height sweeps of ground-effect floors).
FLOOR_REATTACH_MM = 4.0

#: The quadratic yaw-loss model is fitted for moderate yaw; beyond this angle [deg] the
#: element is treated as fully yawed (only reached at walking pace in a cross wind, where
#: q ≈ 0 anyway), and no station loses more than MAX_YAW_LOSS of its load.
YAW_MODEL_LIMIT_DEG = 25.0
MAX_YAW_LOSS = 0.9
#: Induced drag: dCD·A/CD·A per unit relative change of CL·A.
INDUCED_DRAG_GAIN = 0.4
#: Extra drag in yaw (side-force and end-plate vortices): CD·A × (1 + k·sin²ψ) → ≈ +9 % at
#: 10° — more than the induced-drag saving from the yaw downforce loss.
YAW_DRAG_GAIN = 3.0

#: Gusts: turbulence intensity (σ of the speed / mean speed), floor σ [m/s], correlation
#: time [s]; direction σ [deg] and correlation time [s].
GUST_INTENSITY = 0.20
GUST_SIGMA_FLOOR_MS = 0.2
GUST_TAU_S = 4.0
GUST_DIR_SIGMA_DEG = 10.0
GUST_DIR_TAU_S = 10.0
#: Ramp time of the injected side gust [s].
SIDE_GUST_RAMP_S = 1.0


# ---------------------------------------------------------------------------- air
@dataclass(frozen=True)
class Weather:
    """Ambient conditions from the sim source config (``weather:``)."""

    temp_c: float = 18.0
    pressure_pa: float = 101325.0
    rh_pct: float = 60.0
    wind_ms: float = 0.0
    wind_dir_deg: float = 0.0  # direction the wind blows FROM (compass)

    @classmethod
    def from_config(cls, cfg: Mapping[str, float] | None) -> Weather:
        cfg = cfg or {}
        return cls(**{k: float(cfg[k]) for k in cls.__dataclass_fields__ if k in cfg})

    @property
    def rho(self) -> float:
        """Moist-air density [kg/m³]."""
        return float(physics.moist_air_density(self.temp_c, self.pressure_pa, self.rh_pct))


class AirModel:
    """Wind seen at the track: mean wind + Ornstein–Uhlenbeck gusts + an injected side gust.

    After :meth:`step`, ``wind_e`` / ``wind_n`` is the air velocity [m/s] in the track frame
    (the direction the air moves *to*), ``speed`` and ``from_deg`` its magnitude and the
    compass direction it blows *from*.
    """

    def __init__(self, weather: Weather, rng: np.random.Generator, dt: float) -> None:
        self.weather = weather
        self.rho = weather.rho
        self.dt = dt
        sigma = GUST_INTENSITY * weather.wind_ms + GUST_SIGMA_FLOOR_MS
        self._gust_speed = OrnsteinUhlenbeck(sigma, GUST_TAU_S, dt, rng)
        self._gust_dir = OrnsteinUhlenbeck(GUST_DIR_SIGMA_DEG, GUST_DIR_TAU_S, dt, rng)
        self._side: tuple[float, float, float, float] | None = None  # t0, from_deg, speed, t_end
        self.wind_e = self.wind_n = 0.0
        self.speed = weather.wind_ms
        self.from_deg = weather.wind_dir_deg
        self.step(0.0)

    def start_side_gust(self, t: float, from_deg: float, speed_ms: float, duration_s: float) -> None:
        """Superimpose a gust of ``speed_ms`` from ``from_deg`` for ``duration_s`` (1 s ramps)."""
        self._side = (t, from_deg, speed_ms, t + duration_s)

    def stop_side_gust(self, t: float) -> None:
        """End the injected gust now (it ramps down over one second)."""
        if self._side is not None:
            t0, from_deg, speed, t_end = self._side
            self._side = (t0, from_deg, speed, min(t_end, t + SIDE_GUST_RAMP_S))

    def side_gust_speed(self, t: float) -> float:
        """Current magnitude of the injected gust [m/s] (trapezoidal envelope)."""
        if self._side is None:
            return 0.0
        t0, _, speed, t_end = self._side
        if t >= t_end:
            self._side = None
            return 0.0
        ramp = min(1.0, (t - t0) / SIDE_GUST_RAMP_S, (t_end - t) / SIDE_GUST_RAMP_S)
        return speed * max(ramp, 0.0)

    def step(self, t: float) -> None:
        """Advance the gust processes one step and update the wind vector."""
        w = max(self.weather.wind_ms + self._gust_speed.step(), 0.0)
        f = math.radians(self.weather.wind_dir_deg + self._gust_dir.step())
        we, wn = -w * math.sin(f), -w * math.cos(f)  # air moves towards f + 180°
        side = self.side_gust_speed(t)
        if side > 0.0:
            fs = math.radians(self._side[1])
            we -= side * math.sin(fs)
            wn -= side * math.cos(fs)
        self.wind_e, self.wind_n = we, wn
        self.speed = math.hypot(we, wn)
        self.from_deg = math.degrees(math.atan2(-we, -wn)) % 360.0 if self.speed > 0 else 0.0


def relative_airflow(v: float, heading_deg: float, wind_e: float, wind_n: float) -> tuple[float, float, float]:
    """Airflow seen by a car at speed ``v`` [m/s] heading ``heading_deg`` (compass).

    Returns ``(airspeed, yaw_deg, u_x)``: airspeed [m/s], flow yaw [deg] (+ = air coming from
    the car's left) and the head-on component ``u_x`` [m/s] along the car's x axis.
    """
    h = math.radians(heading_deg)
    fx, fy = math.sin(h), math.cos(h)          # forward unit vector (east, north)
    rx, ry = wind_e - v * fx, wind_n - v * fy  # air velocity relative to the car
    u_x = -(rx * fx + ry * fy)                 # head-on component (+ = from ahead)
    u_left = rx * fy - ry * fx                 # from the left = air moving to −y (right)
    airspeed = math.hypot(rx, ry)
    yaw = math.degrees(math.atan2(u_left, u_x)) if airspeed > 1e-6 else 0.0
    return airspeed, yaw, u_x


# ---------------------------------------------------------------------------- aero
@dataclass
class AeroState:
    """Aerodynamic state at one instant (true values)."""

    q: float
    airspeed: float
    yaw_deg: float
    station_factor: dict[str, float]  # model circulation factor per wing station (fw_L ...)
    ut_factor: float                  # undertray CL·A factor (ground effect, stall, yaw)
    floor_stall: float                # 0 = attached … 1 = fully stalled diffuser
    cla_fw: float
    cla_rw: float
    cla_ut: float
    cla: float
    cda: float
    downforce_fw: float
    downforce_rw: float
    downforce_ut: float
    downforce_f: float  # front axle aero load [N]
    downforce_r: float  # rear axle aero load [N]
    drag: float         # aerodynamic drag (along the flow) [N]
    drag_x: float       # drag component along the car's x axis [N]
    # internal: what the tap generator needs
    tap_lambda: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    ut_tap_scale: float = 1.0
    yaw_k: float = 0.0      # k·ψ² (bounded) of the yaw-loss model
    yaw_side: float = 1.0   # +1 flow from the left, −1 from the right
    rw_stalled: bool = False


class AeroModel:
    """Element CL·A, forces and tap pressures of the virtual car (see module docstring)."""

    STATIONS = ("fw_L", "fw_R", "rw_L", "rw_R")

    def __init__(self, vehicle: Mapping, taps: Sequence[ChannelDef]) -> None:
        aero = vehicle["aero"]
        ge = aero["ground_effect"]
        self.wheelbase = float(vehicle["wheelbase_m"])
        self.cla_ref = float(aero["cla_ref"])
        self.cda_ref = float(aero["cda_ref"])
        share = aero["share"]
        self.cla_ref_e = {
            "fw": self.cla_ref * float(share["front_wing"]),
            "rw": self.cla_ref * float(share["rear_wing"]),
            "ut": self.cla_ref * float(share["undertray"]),
        }
        fw, rw, ut = aero["front_wing"], aero["rear_wing"], aero["undertray"]
        x_cp = {
            "fw": fw["le_x_m"] - 0.25 * fw["chord_m"],
            "rw": rw["le_x_m"] - 0.25 * rw["chord_m"],
            "ut": ut["x_start_m"] + ut["cop_frac"] * (ut["x_end_m"] - ut["x_start_m"]),
        }
        #: Fraction of each element's downforce that loads the front axle (moments about
        #: the rear axle): (x_cp + L) / L.
        self.front_share = {e: (float(x) + self.wheelbase) / self.wheelbase for e, x in x_cp.items()}
        self.wing_mass = {"fw": float(fw.get("mass_kg", 3.5)), "rw": float(rw.get("mass_kg", 4.5))}

        self.h_ref_f = float(ge["ref_ride_height_mm"]["front"])
        self.h_ref_r = float(ge["ref_ride_height_mm"]["rear"])
        self.fw_gain = float(ge["front_wing_gain_per_mm"])
        self.floor_gain = float(ge["floor_gain_per_mm"])
        self.fw_stall_mm = float(ge["front_wing_stall_mm"])
        self.floor_stall_mm = float(ge["floor_stall_mm"])
        self.stall_loss = float(ge["stall_loss"])
        self.pitch_gain = float(ge["pitch_gain_per_deg"])
        self.yaw_k = float(ge["yaw_loss_per_deg2"])
        x_throat = ut["x_start_m"] + FLOOR_THROAT_FRACTION * (ut["x_end_m"] - ut["x_start_m"])
        #: Where the throat and the floor's leading edge sit between the axles
        #: (0 = front axle, 1 = rear axle; the leading edge is ahead of the axle: < 0).
        self.throat_axle_frac = -float(x_throat) / self.wheelbase
        self.leading_edge_axle_frac = -float(ut["x_start_m"]) / self.wheelbase
        self.h_ref_throat = self.h_ref_f + self.throat_axle_frac * (self.h_ref_r - self.h_ref_f)

        self.fw_damage_left = False
        self.rw_stall = False
        #: Diffuser flow state (hysteresis), advanced once per physics step by
        #: :meth:`update_floor_state`.
        self.floor_separated = False
        self._build_taps(taps)

    # ------------------------------------------------------------------ tap geometry
    def _build_taps(self, taps: Sequence[ChannelDef]) -> None:
        self.tap_ids = [ch.id for ch in taps]
        n = len(taps)
        self._is_wing = np.zeros(n, dtype=bool)
        self._station = np.zeros(n, dtype=int)   # index into STATIONS (wing taps)
        self._sign = np.zeros(n)                 # +1 suction surface, −1 pressure surface
        self._g = np.zeros(n)
        self._t = np.zeros(n)
        self._separating = np.zeros(n, dtype=bool)  # rear-wing aft suction taps
        self._floor_att = np.zeros(n)
        self._floor_stall = np.zeros(n)
        self._side = np.zeros(n)                 # +1 left station/tunnel, −1 right, 0 centre
        floor_x = np.array([p[0] for p in FLOOR_HEIGHT_PROFILE_MM])
        floor_h = np.array([p[1] for p in FLOOR_HEIGHT_PROFILE_MM])
        kappa2 = (FLOOR_THROAT_CP - FLOOR_BASE_CP) / (1.0 - (floor_h[-1] / np.interp(FLOOR_THROAT_FRACTION, floor_x, floor_h)) ** 2)

        def floor_cp(x: float) -> float:
            h = float(np.interp(x, floor_x, floor_h))
            return FLOOR_BASE_CP + kappa2 * (1.0 - (floor_h[-1] / h) ** 2)

        self._xc = np.array([float(ch.meta["x_c"]) for ch in taps])
        for i, ch in enumerate(taps):
            m = ch.meta
            x = float(m["x_c"])
            station = str(m["station"])
            self._side[i] = {"L": 1.0, "R": -1.0}.get(station, 0.0)
            if m["element"] in ("fw", "rw"):
                a, b, t_s, t_p = WING_LOADING[m["element"]]
                self._is_wing[i] = True
                self._station[i] = self.STATIONS.index(f"{m['element']}_{station}")
                suction = m["surface"] == "suction"
                self._sign[i] = 1.0 if suction else -1.0
                self._g[i] = a * math.sqrt((1.0 - x) / x) + b * math.sqrt(x * (1.0 - x))
                self._t[i] = t_s if suction else t_p
                self._separating[i] = m["element"] == "rw" and suction and x >= REAR_WING_SEPARATION_XC
            else:
                cp = floor_cp(x) * (TUNNEL_SUCTION_FACTOR if station in ("L", "R") else 1.0)
                self._floor_att[i] = cp
                self._floor_stall[i] = cp if x <= FLOOR_THROAT_FRACTION else FLOOR_SEPARATED_CP

        #: tap indices (suction / pressure surface) of each station, for section_cl
        self._station_taps = {
            name: (np.flatnonzero(self._is_wing & (self._station == k) & (self._sign > 0)),
                   np.flatnonzero(self._is_wing & (self._station == k) & (self._sign < 0)))
            for k, name in enumerate(self.STATIONS)
        }
        self._station_taps["ut"] = (np.flatnonzero(~self._is_wing & (self._side == 0.0)), np.array([], int))
        # reference section Cl of every station at λ = 1 (what the taps integrate to)
        ref = self._raw_cp(np.ones(4), 1.0, 0.0, False)
        self.section_cl_ref = {e: self.station_section_cl(ref, f"{e}_L") for e in ("fw", "rw")}
        self.section_cl_ref["ut"] = self.station_section_cl(ref, "ut")
        # stalled floor: scale its suction so the section Cl drops by exactly stall_loss
        self._floor_stall *= self._solve_scale(
            lambda s: self._floor_section_cl_with(stall_scale=s),
            (1.0 - self.stall_loss) * self.section_cl_ref["ut"])
        # stalled rear wing: circulation left on the attached part, so Cl drops to 60 %
        self.rw_stall_circulation = self._solve_scale(
            lambda lam: self.station_section_cl(self._raw_cp(np.array([1, 1, lam, lam]), 1.0, 0.0, True), "rw_L"),
            RW_STALL_CLA * self.section_cl_ref["rw"])
        #: Effective area [m²] linking a station's section Cl to its element CL·A.
        self.area_eff = {e: self.cla_ref_e[e] / self.section_cl_ref[e] for e in ("fw", "rw", "ut")}

    def _floor_section_cl_with(self, stall_scale: float) -> float:
        saved = self._floor_stall.copy()
        self._floor_stall *= stall_scale
        cp = self._raw_cp(np.ones(4), 1.0, 1.0, False)
        self._floor_stall[:] = saved
        return self.station_section_cl(cp, "ut")

    @staticmethod
    def _solve_scale(f, target: float, lo: float = 0.0, hi: float = 3.0) -> float:
        """Bisection for ``f(x) = target`` (``f`` increasing on [lo, hi])."""
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            if f(mid) < target:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    def _raw_cp(self, lam4: np.ndarray, ut_scale: float, floor_stall: float, rw_stall: bool,
                yaw_k: float = 0.0, yaw_side: float = 1.0) -> np.ndarray:
        """Cp of every tap for station circulation factors ``lam4`` and floor state."""
        lam = lam4[self._station]
        u = 1.0 + self._t + self._sign * lam * self._g
        cp = 1.0 - u * u
        if rw_stall:
            cp = np.where(self._separating, SEPARATED_CP, cp)
        floor = (1.0 - floor_stall) * self._floor_att + floor_stall * self._floor_stall
        if yaw_k:
            # tunnel taps: windward side loses 2kψ², leeward nothing, relative to the centre
            floor = floor * (1.0 - yaw_k * (1.0 + yaw_side * self._side)) / (1.0 - yaw_k)
        return np.where(self._is_wing, cp, ut_scale * floor)

    # ------------------------------------------------------------------ section Cl
    def station_section_cl(self, cp: np.ndarray, station: str) -> float:
        """Integrate one station's taps with :func:`physics.section_cl`.

        ``station`` is ``fw_L``/``fw_R``/``rw_L``/``rw_R`` or ``ut`` (undertray centreline;
        its upper side is the car interior at ambient pressure: one virtual tap Cp = 0).
        """
        suction, pressure = self._station_taps[station]
        if station == "ut":
            return physics.section_cl(self._xc[suction], cp[suction], [0.5], [0.0])
        return physics.section_cl(self._xc[suction], cp[suction], self._xc[pressure], cp[pressure])

    def model_section_cl(self, state: AeroState, station: str) -> float:
        """The model's section Cl of a station (what the taps should integrate to)."""
        if station == "ut":
            return self.section_cl_ref["ut"] * state.ut_factor
        return self.section_cl_ref[station[:2]] * state.station_factor[station]

    # ------------------------------------------------------------------ evaluation
    def floor_height_mm(self, rh_front_mm: float, rh_rear_mm: float) -> float:
        """Floor height at the venturi throat, interpolated between the axle ride heights."""
        return rh_front_mm + self.throat_axle_frac * (rh_rear_mm - rh_front_mm)

    def floor_clearance_mm(self, rh_front_mm: float, rh_rear_mm: float) -> float:
        """Smallest floor clearance: the lower of the leading edge and the throat. With the
        usual nose-down rake at speed the leading edge is the lowest point — when it gets
        too close to the ground it chokes the floor's inlet and the diffuser stalls."""
        edge = rh_front_mm + self.leading_edge_axle_frac * (rh_rear_mm - rh_front_mm)
        return min(edge, self.floor_height_mm(rh_front_mm, rh_rear_mm))

    def update_floor_state(self, rh_front_mm: float, rh_rear_mm: float) -> None:
        """Advance the diffuser's attached/separated state (stall hysteresis).

        The flow separates when the floor clearance drops below the stall height and only
        reattaches once it is ``FLOOR_REATTACH_MM`` higher again, so a floor that bottoms
        out at the end of a straight stays stalled through the following braking zone.
        """
        h = self.floor_clearance_mm(rh_front_mm, rh_rear_mm)
        if h < self.floor_stall_mm:
            self.floor_separated = True
        elif h > self.floor_stall_mm + FLOOR_REATTACH_MM:
            self.floor_separated = False

    def evaluate(self, q: float, airspeed: float, yaw_deg: float, u_x: float,
                 rh_front_mm: float, rh_rear_mm: float) -> AeroState:
        """True aerodynamic state for dynamic pressure ``q`` and the ride heights."""
        psi = min(max(yaw_deg, -YAW_MODEL_LIMIT_DEG), YAW_MODEL_LIMIT_DEG)
        k_yaw = min(self.yaw_k * psi * psi, 0.5 * MAX_YAW_LOSS)
        side = math.copysign(1.0, psi)
        windward_l = 1.0 - k_yaw * (1.0 + side)   # left station when ψ > 0 (flow from left)
        windward_r = 1.0 - k_yaw * (1.0 - side)

        # front wing: ground effect + stall at low front ride height
        fw_stall = _logistic((self.fw_stall_mm - rh_front_mm) / STALL_WIDTH_MM)
        fw_phys = (1.0 + self.fw_gain * (self.h_ref_f - rh_front_mm)) * (1.0 - self.stall_loss * fw_stall)
        fw_l = fw_phys * windward_l * (FW_DAMAGE_CIRCULATION if self.fw_damage_left else 1.0)
        fw_r = fw_phys * windward_r
        # rear wing: pitch (angle of attack) + flap stall
        pitch_deg = math.degrees(((rh_rear_mm - rh_front_mm) - (self.h_ref_r - self.h_ref_f))
                                 / (1000.0 * self.wheelbase))
        rw_phys = 1.0 - self.pitch_gain * pitch_deg
        rw_model = rw_phys * (RW_STALL_CLA if self.rw_stall else 1.0)
        rw_tap = rw_phys * (self.rw_stall_circulation if self.rw_stall else 1.0)
        # undertray: ground effect at the throat + diffuser stall
        h_throat = self.floor_height_mm(rh_front_mm, rh_rear_mm)
        stall_mm = self.floor_stall_mm + (FLOOR_REATTACH_MM if self.floor_separated else 0.0)
        floor_stall = _logistic((stall_mm - self.floor_clearance_mm(rh_front_mm, rh_rear_mm)) / STALL_WIDTH_MM)
        ut_ge = 1.0 + self.floor_gain * (self.h_ref_throat - h_throat)
        ut_factor = ut_ge * (1.0 - self.stall_loss * floor_stall) * (1.0 - k_yaw)

        station = {"fw_L": fw_l, "fw_R": fw_r, "rw_L": rw_model * windward_l, "rw_R": rw_model * windward_r}
        cla_fw = self.cla_ref_e["fw"] * 0.5 * (fw_l + fw_r)
        cla_rw = self.cla_ref_e["rw"] * 0.5 * (station["rw_L"] + station["rw_R"])
        cla_ut = self.cla_ref_e["ut"] * ut_factor
        cla = cla_fw + cla_rw + cla_ut
        l_fw, l_rw, l_ut = q * cla_fw, q * cla_rw, q * cla_ut
        down_f = l_fw * self.front_share["fw"] + l_rw * self.front_share["rw"] + l_ut * self.front_share["ut"]
        sin_yaw = math.sin(math.radians(yaw_deg))
        cda = (self.cda_ref * (1.0 + INDUCED_DRAG_GAIN * (cla / self.cla_ref - 1.0))
               * (1.0 + YAW_DRAG_GAIN * sin_yaw * sin_yaw) * (RW_STALL_CDA if self.rw_stall else 1.0))
        drag = q * cda
        drag_x = drag * (u_x / airspeed) if airspeed > 1e-6 else 0.0
        return AeroState(
            q=q, airspeed=airspeed, yaw_deg=yaw_deg, station_factor=station, ut_factor=ut_factor,
            floor_stall=floor_stall, cla_fw=cla_fw, cla_rw=cla_rw, cla_ut=cla_ut, cla=cla, cda=cda,
            downforce_fw=l_fw, downforce_rw=l_rw, downforce_ut=l_ut, downforce_f=down_f,
            downforce_r=l_fw + l_rw + l_ut - down_f, drag=drag, drag_x=drag_x,
            tap_lambda=(fw_l, fw_r, rw_tap * windward_l, rw_tap * windward_r),
            ut_tap_scale=ut_ge * (1.0 - k_yaw), yaw_k=k_yaw, yaw_side=side, rw_stalled=self.rw_stall,
        )

    def tap_cp(self, state: AeroState) -> np.ndarray:
        """Noise-free Cp of every tap (catalogue tap order) for ``state``."""
        return self._raw_cp(np.asarray(state.tap_lambda), state.ut_tap_scale, state.floor_stall,
                            state.rw_stalled, state.yaw_k, state.yaw_side)

    def tap_pressures(self, state: AeroState) -> np.ndarray:
        """True tap pressures [Pa] = Cp · q (tap static − freestream static)."""
        return self.tap_cp(state) * state.q

    def wing_load(self, state: AeroState, element: str, az: float) -> float:
        """Wing-mount load cell [N, +down]: downforce plus the wing's inertia (tared at rest)."""
        downforce = state.downforce_fw if element == "fw" else state.downforce_rw
        return downforce + self.wing_mass[element] * (az - physics.G)

    def cla_at(self, rh_front_mm: float, rh_rear_mm: float) -> float:
        """Total CL·A [m²] at the given ride heights (no yaw) — e.g. for the speed profile."""
        return self.evaluate(1.0, 1.0, 0.0, 1.0, rh_front_mm, rh_rear_mm).cla


def _logistic(z: float) -> float:
    """Smooth 0 → 1 step: 1 / (1 + e^(−z)) (overflow-safe)."""
    if z >= 0.0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)
