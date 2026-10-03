/**
 * @file Car3D - a procedurally built Formula Student electric car in three.js with a live
 * surface-pressure map (System 1, the Aero tab's centrepiece).
 *
 * What is drawn
 * -------------
 * * The car is generated from `app.meta.vehicle` (config/vehicle.yaml): wheelbase, track
 *   widths, wheel radius, front/rear wing leading-edge x, chord, height and span, undertray
 *   extents, pitot position. No external model files.
 * * Coordinates: vehicle frame ISO 8855 (origin on the ground at the front axle, x forward,
 *   y left, z up, metres) mapped to three.js as `three.X = car.x, three.Y = car.z,
 *   three.Z = −car.y` (SPEC §0). Helper {@link carV} does the mapping.
 * * Wings are **inverted** multi-element aerofoils (front: main plane + flap, rear: main plane
 *   + 2 flaps). The section is a NACA 4-digit cambered aerofoil mirrored top-to-bottom, so the
 *   convex **suction surface is underneath** and the flaps sit above and behind the main
 *   plane's trailing edge (the slot feeds high-energy air from the pressure side onto the
 *   flap's suction side). The pressure taps of SPEC §2.1 are on the main planes.
 *
 * Live pressure map
 * -----------------
 * Every vertex of the instrumented surfaces (wing main planes, undertray underside) carries
 * its chord fraction x/c (or floor fraction) and span position y, and is coloured at ≤ 20 Hz
 * from the live pressure coefficients `calc_cp_<tap>` (Cp = p_tap / q):
 * * chordwise within a station: piecewise-linear through the taps, with the same end
 *   conditions as `core/physics.section_cl` - Cp = 1 at the leading edge (stagnation) and the
 *   mean of the last suction and pressure values at the trailing edge (Kutta condition);
 * * spanwise: linear between the two stations, holding the nearest station outboard;
 * * undertray: the centreline profile (held at both ends) plus the measured tunnel offset
 *   `Cp_tunnel − Cp_centre(0.8)`, blended in towards the diffuser tunnels.
 * Colours come from `lib/colormap` (two-slope diverging map, Cp −3.5 … +1, blue = suction).
 * Taps that are missing or stale are grey; a tap flagged by `sensor_tap_anomaly` is left out
 * of the surface interpolation (like the section-Cl integration) and ringed in amber. Taps
 * whose value comes from real hardware (`app.owner` = serial / can) get a pulsing ring that
 * shows through the car - in the Phase-2 bench demo the real sensor lights up on the wing.
 *
 * Physics overlays
 * ----------------
 * * Front/rear axle downforce arrows (calc_downforce_f/_r) and a drag arrow (calc_drag),
 *   length ∝ force.
 * * Flow streaks: instanced streak particles in a potential-flow model of the car - uniform
 *   stream at the measured airspeed and flow yaw, a Rankine source/sink pair for the body,
 *   and a bound vortex per wing whose circulation comes from the live section Cl via
 *   Kutta-Joukowski (Γ = ½·V·c·Cl), each mirrored in the ground (method of images). Streaks
 *   under the floor move at the Bernoulli speed from the live floor Cp, V_local = V·√(1 − Cp).
 * * Ride height and pitch from rh_front / rh_rear (optionally exaggerated ×5), wheels spin
 *   from the wheel speeds ws_* and the front wheels steer from `steer` / steering ratio.
 *   Flow and wheel spin run in slow motion ({@link SLOW_MOTION}) so the eye can follow them.
 *
 * Rendering: one WebGLRenderer, rendered only from `update()` (which main.js calls only while
 * the Aero tab is visible), device-pixel-ratio aware (capped at 2), resized with a
 * ResizeObserver. A mirrored copy of the car under a translucent floor gives a showroom
 * reflection, which also shows the coloured suction surfaces from the default camera angle.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { colorbar, diverging, divergingPosition, MISSING_RGB } from '../lib/colormap.js';
import { escapeHtml, formatNumber, isNum } from '../lib/format.js';

/* ================================================================== constants */

/** Cp range of the colour scale (two-slope diverging map, neutral at Cp = 0). */
export const CP_RANGE = Object.freeze({ min: -3.5, max: 1.0 });

/** Below this dynamic pressure [Pa] the analysis reports Cp = null (SPEC §6, aero.py). */
export const Q_MIN_CP = 60;

/** Flow streaks and wheel spin run at this fraction of real time so they can be followed. */
export const SLOW_MOTION = 1 / 15;

/** Ride-height / pitch exaggeration factor of the "RH ×5" toggle. */
export const RIDE_EXAGGERATION = 5;

/** Downforce / drag arrow length per newton [m/N] (1000 N → 0.35 m). */
const ARROW_M_PER_N = 0.00035;

/** Pressure-map recolouring period [ms] (≤ 20 Hz). */
const COLOR_PERIOD_MS = 50;

/** Screen size of a tap marker [CSS px]. */
const TAP_PX = 11;

/** Underside inset: aspect ratio and width (fraction of the view, capped in px). */
const PIP_ASPECT = 2.1;
const PIP_FRACTION = 0.3;
const PIP_MAX_PX = 380;

/** Floor fraction where the diffuser ramp starts, and the ramp angle [deg]. */
export const DIFFUSER_START = 0.62;
const DIFFUSER_DEG = 11;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** Camera presets in the *car* frame (position and look-at target, metres). */
export const VIEWS = Object.freeze({
  iso: { label: 'Iso', pos: [2.75, 3.25, 1.8], target: [-0.8, 0, 0.32] },
  side: { label: 'Side', pos: [-0.85, 4.9, 1.05], target: [-0.85, 0, 0.58] },
  top: { label: 'Top', pos: [-0.8, -0.03, 6.0], target: [-0.8, 0, 0.3] },
  under: { label: 'Underside', pos: [-0.8, 0.03, -4.9], target: [-0.8, 0, 0.06] },
  front: { label: 'Front', pos: [4.6, 0.0, 0.6], target: [0, 0, 0.45] },
});

/** Aspect ratio the view distances were tuned for; narrower canvases move the camera back. */
const VIEW_ASPECT = 1.75;

/** Car frame (x fwd, y left, z up) → three.js vector. */
export function carV(x, y, z) {
  return new THREE.Vector3(x, z, -y);
}

/* ================================================================== aerofoil geometry */

/**
 * Inverted NACA 4-digit aerofoil, cosine-spaced (points crowd at the leading and trailing
 * edges where the curvature is). A conventional aerofoil has its suction side on top; an
 * inverted race-car wing is the same section mirrored top-to-bottom, so here the **suction
 * surface has negative w** (below the chord line).
 *
 * Camber line yc = m/p²·(2px − x²) for x < p, m/(1−p)²·(1 − 2p + 2px − x²) after; thickness
 * yt = 5t·(0.2969√x − 0.1260x − 0.3516x² + 0.2843x³ − 0.1036x⁴) (closed trailing edge);
 * surfaces offset ±yt normal to the camber line.
 * @param {number} [n=34]   points per surface (including both edges)
 * @param {number} [m=0.07] maximum camber (fraction of chord)
 * @param {number} [p=0.4]  chordwise position of maximum camber
 * @param {number} [t=0.10] maximum thickness
 * @returns {{suction: number[][], pressure: number[][]}} `[u, w]` pairs (chord units), LE → TE
 */
export function airfoilProfile(n = 34, m = 0.07, p = 0.4, t = 0.10) {
  const suction = [];
  const pressure = [];
  for (let i = 0; i < n; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / (n - 1)));
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const before = x < p;
    const k = before ? m / (p * p) : m / ((1 - p) * (1 - p));
    const yc = before ? k * (2 * p * x - x * x) : k * (1 - 2 * p + 2 * p * x - x * x);
    const th = Math.atan(2 * k * (p - x));
    // conventional upper (suction) surface, mirrored: w = −z
    suction.push([x - yt * Math.sin(th), -(yc + yt * Math.cos(th))]);
    pressure.push([x + yt * Math.sin(th), -(yc - yt * Math.cos(th))]);
  }
  return { suction, pressure };
}

/** w of a surface (`[u, w]` list, u ascending) at chord fraction u (linear interpolation). */
function surfaceW(surface, u) {
  for (let i = 1; i < surface.length; i++) {
    if (u <= surface[i][0]) {
      const [u0, w0] = surface[i - 1];
      const [u1, w1] = surface[i];
      return u1 > u0 ? w0 + ((w1 - w0) * (u - u0)) / (u1 - u0) : w1;
    }
  }
  return surface[surface.length - 1][1];
}

/**
 * One wing element placed in the car's x-z plane.
 *
 * Local coordinates: u along the chord (0 = leading edge, 1 = trailing edge), w normal to it
 * (chord units). The chord runs rearwards and *up* at angle of attack α (an inverted wing is
 * nose-down), so with d = (−cos α, sin α) and n = (sin α, cos α):
 * `P(u, w) = LE + c·(u·d + w·n)`.
 */
class WingElement {
  /**
   * @param {{xle: number, zle: number, chord: number, aoaDeg: number, profile: ReturnType<typeof airfoilProfile>}} o
   */
  constructor({ xle, zle, chord, aoaDeg, profile }) {
    this.xle = xle;
    this.zle = zle;
    this.c = chord;
    this.a = (aoaDeg * Math.PI) / 180;
    this.profile = profile;
  }

  /** Car-frame [x, z] of local point (u, w). */
  point(u, w) {
    const ca = Math.cos(this.a), sa = Math.sin(this.a);
    return [this.xle + this.c * (-u * ca + w * sa), this.zle + this.c * (u * sa + w * ca)];
  }

  /** Trailing-edge point (end of the chord line). */
  te() { return this.point(1, 0); }

  /** Closed contour (suction TE → LE → pressure TE) as `[u, w, surface]`, 0 = suction. */
  contour() {
    const { suction: S, pressure: P } = this.profile;
    const c = [];
    for (let i = S.length - 1; i >= 0; i--) c.push([S[i][0], S[i][1], 0]);
    for (let i = 1; i < P.length; i++) c.push([P[i][0], P[i][1], 1]);
    return c;
  }

  /** Car-frame [x, z] on a surface at chord fraction u. @param {'suction'|'pressure'} surface */
  surfacePoint(surface, u) {
    return this.point(u, surfaceW(this.profile[surface], u));
  }

  /** Bounding box of the section in the x-z plane. */
  bounds() {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [u, w] of this.contour()) {
      const [x, z] = this.point(u, w);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return { x0, x1, z0, z1 };
  }
}

/**
 * The element stack of a wing from its vehicle.yaml entry. The instrumented main plane has the
 * configured chord and leading edge; it is placed so that its suction surface at 30 % chord is
 * at `z_m` (the height vehicle.yaml and the tap positions use). Each flap's leading edge sits
 * `overlap` (fraction of the previous chord) ahead of and `gap` above the previous trailing edge.
 * @param {{chord_m: number, le_x_m: number, z_m: number}} wing
 * @param {{aoa: number, flaps: {chord: number, aoa: number, overlap: number, gap: number}[]}} design
 * @returns {WingElement[]}
 */
export function wingElements(wing, design) {
  const profile = airfoilProfile();
  const c = Number(wing.chord_m);
  const a = (design.aoa * Math.PI) / 180;
  const w30 = surfaceW(profile.suction, 0.3);
  const zle = Number(wing.z_m) - c * (0.3 * Math.sin(a) + w30 * Math.cos(a));
  const els = [new WingElement({ xle: Number(wing.le_x_m), zle, chord: c, aoaDeg: design.aoa, profile })];
  for (const f of design.flaps) {
    const prev = els[els.length - 1];
    const [tx, tz] = prev.te();
    els.push(new WingElement({
      xle: tx + f.overlap * prev.c, zle: tz + f.gap * prev.c, chord: f.chord * c, aoaDeg: f.aoa,
      profile: airfoilProfile(30, 0.08, 0.4, 0.11),
    }));
  }
  return els;
}

/** Element design (angles in degrees, flap chord as a fraction of the main chord). */
const FRONT_WING_DESIGN = { aoa: 3, flaps: [{ chord: 0.55, aoa: 27, overlap: 0.06, gap: 0.03 }] };
const REAR_WING_DESIGN = {
  aoa: 6,
  flaps: [
    { chord: 0.5, aoa: 29, overlap: 0.06, gap: 0.03 },
    { chord: 0.32, aoa: 50, overlap: 0.08, gap: 0.045 },
  ],
};

/* ================================================================== Cp interpolation (pure) */

/**
 * Chordwise Cp profiles of one wing station, with the end conditions of
 * `core/physics.section_cl`: both surfaces start at Cp = 1 at x/c = 0 (stagnation point) and
 * end at the mean of their last measured values at x/c = 1 (Kutta condition). Taps with a
 * missing value (NaN) are skipped; a surface without any valid tap has no profile (null).
 * @param {[number, number][]} suction   `[x_c, Cp]` pairs
 * @param {[number, number][]} pressure  `[x_c, Cp]` pairs
 * @returns {{suction: number[][]|null, pressure: number[][]|null}}
 */
export function stationProfiles(suction, pressure) {
  const s = suction.filter(([, c]) => isNum(c)).sort((a, b) => a[0] - b[0]);
  const p = pressure.filter(([, c]) => isNum(c)).sort((a, b) => a[0] - b[0]);
  const lastS = s.length ? s[s.length - 1][1] : NaN;
  const lastP = p.length ? p[p.length - 1][1] : NaN;
  let te = NaN;
  if (isNum(lastS) && isNum(lastP)) te = 0.5 * (lastS + lastP);
  else te = isNum(lastS) ? lastS : lastP;
  const build = (pts) => (pts.length ? [[0, 1], ...pts.map(([x, c]) => [x, c]), [1, te]] : null);
  return { suction: build(s), pressure: build(p) };
}

/**
 * Piecewise-linear interpolation of a profile `[[x, Cp], ...]` (x ascending), holding the end
 * values outside its range. Returns NaN for a null profile.
 * @param {number[][]|null} prof
 * @param {number} x
 * @returns {number}
 */
export function interpProfile(prof, x) {
  if (!prof || !prof.length) return NaN;
  if (x <= prof[0][0]) return prof[0][1];
  for (let i = 1; i < prof.length; i++) {
    if (x <= prof[i][0]) {
      const [x0, y0] = prof[i - 1];
      const [x1, y1] = prof[i];
      return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
    }
  }
  return prof[prof.length - 1][1];
}

/**
 * Spanwise weight of the left station for a point at span position y: 1 outboard of the left
 * station, 0 outboard of the right one, linear in between ("hold nearest station outboard").
 * @param {number} y   span position [m], + = left
 * @param {number} yL  left station y
 * @param {number} yR  right station y (yR < yL)
 */
export function spanWeight(y, yL, yR) {
  if (y >= yL) return 1;
  if (y <= yR) return 0;
  return (y - yR) / (yL - yR);
}

/** Blend two station values with the left weight; a missing side falls back to the other. */
export function blendStations(cpL, cpR, wL) {
  if (isNum(cpL) && isNum(cpR)) return cpL * wL + cpR * (1 - wL);
  return isNum(cpL) ? cpL : cpR;
}

/** Cubic smoothstep 0 → 1 between e0 and e1. */
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Floor fraction from which the diffuser tunnel taps influence the map (ramp start). */
const TUNNEL_BLEND = [0.6, 0.8];

/**
 * Undertray Cp at floor fraction f and span y: the centreline profile plus the measured
 * tunnel offset, blended in towards the tunnels (|y| → tunnel y) and along the diffuser.
 * @param {number[][]|null} centre  centreline profile `[[f, Cp], ...]`
 * @param {number} f
 * @param {number} y
 * @param {{dL: number, dR: number, yTunnel: number}} tunnels  offsets Cp_tunnel − Cp_centre(f_tunnel)
 */
export function floorCp(centre, f, y, tunnels) {
  const base = interpProfile(centre, f);
  if (!isNum(base)) return NaN;
  const d = y >= 0 ? tunnels.dL : tunnels.dR;
  if (!isNum(d)) return base;
  const wy = Math.min(1, Math.abs(y) / tunnels.yTunnel);
  return base + smoothstep(TUNNEL_BLEND[0], TUNNEL_BLEND[1], f) * wy * d;
}

/* ================================================================== colour LUT (linear light) */

/** sRGB-encoded → linear-light component (three.js vertex colours are linear). */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const LUT_N = 512;
/** Cp colour map sampled in the two-slope position t (0 … 1), linear-light RGB. */
const CP_LUT = (() => {
  const lut = new Float32Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    const v = t <= 0.5 ? CP_RANGE.min * (1 - 2 * t) : CP_RANGE.max * (2 * t - 1);
    const c = diverging(v, CP_RANGE.min, CP_RANGE.max);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = srgbToLinear(c[k]);
  }
  return lut;
})();
const MISSING_LIN = MISSING_RGB.map(srgbToLinear);

/** Write the linear-light Cp colour of `cp` into `out[o…o+2]` (grey when missing). */
function cpColorInto(out, o, cp) {
  if (!isNum(cp)) {
    out[o] = MISSING_LIN[0]; out[o + 1] = MISSING_LIN[1]; out[o + 2] = MISSING_LIN[2];
    return;
  }
  const t = divergingPosition(cp, CP_RANGE.min, CP_RANGE.max, 0);
  const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_N - 1)) * 3;
  out[o] = CP_LUT[i]; out[o + 1] = CP_LUT[i + 1]; out[o + 2] = CP_LUT[i + 2];
}

/* ================================================================== geometry helpers */

/** Indexed grid of `rows × cols` vertices (row-major) → triangle indices. */
function gridIndex(rows, cols) {
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = j * cols + k, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return idx;
}

/** Reverse the winding of every triangle of an indexed geometry. */
function flipWinding(geo) {
  const ix = geo.index.array;
  for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  geo.index.needsUpdate = true;
}

/**
 * Make sure the normal at vertex `v` points along `dir` (three.js axis vector); flips the
 * winding (and recomputes normals) if it does not. Used for the procedurally indexed surfaces.
 */
function orientNormals(geo, v, dir) {
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const dot = n.getX(v) * dir.x + n.getY(v) * dir.y + n.getZ(v) * dir.z;
  if (dot < 0) {
    flipWinding(geo);
    geo.computeVertexNormals();
  }
}

/** Sorted unique numbers (merged with a tolerance of 1 mm). */
function uniqueSorted(values) {
  const s = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > 1e-3) out.push(v);
  return out;
}

/** n evenly spaced values from a to b (inclusive). */
function linspace(a, b, n) {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/**
 * Mesh of a wing element extruded along the span samples `ys`.
 * With `data`, per-vertex chord fraction, surface flag and left-station weight are returned
 * for the pressure map, plus a colour attribute.
 */
function elementGeometry(el, ys, data) {
  const cont = el.contour();
  const nc = cont.length, ns = ys.length;
  const pos = new Float32Array(nc * ns * 3);
  const u = data ? new Float32Array(nc * ns) : null;
  const surf = data ? new Uint8Array(nc * ns) : null;
  const wL = data ? new Float32Array(nc * ns) : null;
  for (let j = 0; j < ns; j++) {
    for (let k = 0; k < nc; k++) {
      const [cu, cw, s] = cont[k];
      const [x, z] = el.point(cu, cw);
      const v = j * nc + k;
      pos[v * 3] = x; pos[v * 3 + 1] = z; pos[v * 3 + 2] = -ys[j];
      if (data) {
        u[v] = Math.max(0, cu);
        surf[v] = s;
        wL[v] = spanWeight(ys[j], data.yL, data.yR);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(gridIndex(ns, nc));
  // a vertex on the suction (lower) surface at mid-chord, mid-span must face down
  const kMid = Math.floor(nc / 4);
  orientNormals(geo, Math.floor(ns / 2) * nc + kMid, new THREE.Vector3(0, -1, 0));
  if (data) {
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nc * ns * 3), 3));
    geo.userData.cp = { u, surf, wL, element: data.element };
  }
  return geo;
}

/** Flat cap closing an element's section at span position y (both faces visible). */
function elementCap(el, y) {
  const pts = el.contour().slice(0, -1).map(([u, w]) => {
    const [x, z] = el.point(u, w);
    return new THREE.Vector2(x, z);
  });
  const faces = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = -y; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(faces.flat());
  geo.computeVertexNormals();
  return geo;
}

/**
 * Endplate outline (car x-z) around a wing's elements: from `bottom` up to just above the
 * element stack, with the top edge following the stack (low at the main plane's leading
 * edge, high over the last flap) and rounded corners.
 */
function endplateShape(els, bottom, margin = 0.025) {
  const b0 = els[0].bounds();
  let x0 = Infinity, z1 = -Infinity;
  for (const e of els) {
    const b = e.bounds();
    x0 = Math.min(x0, b.x0); z1 = Math.max(z1, b.z1);
  }
  const front = b0.x1 + margin, rear = x0 - margin;
  const top = z1 + margin, frontTop = b0.z1 + margin * 1.6;
  const r = 0.02;
  const s = new THREE.Shape();
  s.moveTo(front - r, bottom);
  s.lineTo(rear + r, bottom);
  s.quadraticCurveTo(rear, bottom, rear, bottom + r);
  s.lineTo(rear, top - r);
  s.quadraticCurveTo(rear, top, rear + r * 1.5, top);
  s.quadraticCurveTo(rear + (front - rear) * 0.55, top, front, frontTop);
  s.lineTo(front, bottom + r);
  s.quadraticCurveTo(front, bottom, front - r, bottom);
  return s;
}

/** Extrude a car-x/z shape into a plate of thickness `t` centred on car y. */
function plateFromShape(shape, y, t, mat) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: t, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1, curveSegments: 6,
  });
  geo.translate(0, 0, -y - t / 2);
  return new THREE.Mesh(geo, mat);
}

/**
 * Lofted body: superellipse cross-sections (half-width hw, half-height hh, centre height zc,
 * exponent n: 2 = ellipse, larger = boxier) interpolated with a Catmull-Rom spline along x
 * and closed with fans at both ends.
 * @param {{x: number, hw: number, hh: number, zc: number, n: number}[]} sections  x descending
 */
function loftGeometry(sections, samples = 64, ring = 40) {
  const keys = ['x', 'hw', 'hh', 'zc', 'n'];
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const rows = [];
  const segs = sections.length - 1;
  for (let i = 0; i <= samples; i++) {
    const g = (i / samples) * segs;
    const k = Math.min(segs - 1, Math.floor(g));
    const t = g - k;
    const P = (o) => sections[Math.max(0, Math.min(segs, k + o))];
    const s = {};
    for (const key of keys) s[key] = cr(P(-1)[key], P(0)[key], P(1)[key], P(2)[key], t);
    rows.push(s);
  }
  const pos = [];
  for (const s of rows) {
    for (let k = 0; k < ring; k++) {
      const th = (k / ring) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      const e = 2 / s.n;
      const y = s.hw * Math.sign(c) * Math.abs(c) ** e;
      const z = s.zc + s.hh * Math.sign(sn) * Math.abs(sn) ** e;
      pos.push(s.x, z, -y);
    }
  }
  const idx = [];
  for (let j = 0; j < rows.length - 1; j++) {
    for (let k = 0; k < ring; k++) {
      const a = j * ring + k, b = j * ring + ((k + 1) % ring), c = a + ring, d = b + ring;
      idx.push(a, c, b, b, c, d);
    }
  }
  // end caps
  const capF = pos.length / 3;
  pos.push(rows[0].x + 0.004, rows[0].zc, 0);
  const capR = pos.length / 3;
  pos.push(rows[rows.length - 1].x - 0.004, rows[rows.length - 1].zc, 0);
  const last = (rows.length - 1) * ring;
  for (let k = 0; k < ring; k++) {
    const k1 = (k + 1) % ring;
    idx.push(capF, k, k1);
    idx.push(capR, last + k1, last + k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // the vertex at angle 90° (top) of the middle row must face up
  orientNormals(geo, Math.floor(rows.length / 2) * ring + Math.floor(ring / 4), new THREE.Vector3(0, 1, 0));
  geo.userData.rows = rows;
  return geo;
}

/** Height of the loft's top surface at car x (from its sampled rows). */
function loftTopAt(rows, x) {
  for (let i = 1; i < rows.length; i++) {
    if (x >= rows[i].x) {
      const a = rows[i - 1], b = rows[i];
      const f = (x - a.x) / (b.x - a.x);
      return a.zc + a.hh + f * (b.zc + b.hh - a.zc - a.hh);
    }
  }
  const r = rows[rows.length - 1];
  return r.zc + r.hh;
}

/** Half-width of the loft at car x. */
function loftHalfWidthAt(rows, x) {
  for (let i = 1; i < rows.length; i++) {
    if (x >= rows[i].x) {
      const a = rows[i - 1], b = rows[i];
      const f = (x - a.x) / (b.x - a.x);
      return a.hw + f * (b.hw - a.hw);
    }
  }
  return rows[rows.length - 1].hw;
}

/** Quad strip between two polylines (three.js vectors), double-sided material expected. */
function stripGeometry(a, b) {
  const pos = new Float32Array(a.length * 2 * 3);
  a.forEach((p, i) => { pos.set([p.x, p.y, p.z], i * 6); pos.set([b[i].x, b[i].y, b[i].z], i * 6 + 3); });
  const idx = [];
  for (let i = 0; i < a.length - 1; i++) {
    const p = i * 2;
    idx.push(p, p + 1, p + 2, p + 2, p + 1, p + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Merge the static meshes of `group` that share a material into one mesh per material (fewer
 * draw calls: the car is ~150 parts). Meshes in `keep` stay separate. Geometries are baked
 * into the group's frame and de-indexed; missing uv attributes are zero-filled.
 * @param {THREE.Group} group
 * @param {Set<THREE.Object3D>} keep
 */
function mergeStatic(group, keep) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map();
  for (const m of [...group.children]) {
    if (!m.isMesh || keep.has(m) || m.children.length) continue;
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(m);
  }
  const rel = new THREE.Matrix4();
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((m) => {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
      if (!g.attributes.normal) g.computeVertexNormals();
      return g;
    });
    const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    let o = 0;
    for (const g of parts) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += n;
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    for (const m of meshes) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(new THREE.Mesh(merged, mat));
  }
}

/** A canvas texture drawn by `draw(ctx, size)`. */
function canvasTexture(size, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(cv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ================================================================== links (suspension) */

/** A cylinder that can be stretched between two points every frame (tubes, links, shafts). */
class Link {
  /**
   * @param {THREE.BufferGeometry} geo  unit-height cylinder along Y
   * @param {THREE.Material} mat
   * @param {THREE.Object3D} parent
   */
  constructor(geo, mat, parent) {
    this.mesh = new THREE.Mesh(geo, mat);
    parent.add(this.mesh);
    this._d = new THREE.Vector3();
  }

  /** Place between a and b (three.js vectors in the parent's frame). */
  set(a, b) {
    const d = this._d.subVectors(b, a);
    const len = d.length();
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    if (len > 1e-6) this.mesh.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / len));
    this.mesh.scale.set(1, Math.max(len, 1e-4), 1);
  }
}

/* ================================================================== flow streaks */

/**
 * Streak particles in a potential-flow model of the car (car frame, m/s).
 *
 * u(p) = U∞ + Σ sources (3D) + Σ bound vortices (2D in the x-z plane, spanwise lines)
 * * U∞ = V·(−cos ψ, −sin ψ, 0): the air moves rearwards past the car; ψ = flow yaw (+ = from
 *   the left).
 * * Body: Rankine source at the nose and an equal sink at the tail, strength m = V·π·R², which
 *   closes a streamline body of radius ≈ R around the car.
 * * Wings: bound vortex at the quarter chord with Γ = −½·V·c·Cl (Kutta-Joukowski,
 *   L' = ρ·V·Γ; negative = clockwise seen from the left, i.e. downforce), tapered towards the
 *   tips; a Lamb-Oseen-like core avoids the singularity.
 * * Ground: every singularity has a mirror image below z = 0 (sources same sign, vortices
 *   opposite sign), so the ground plane is a streamline - ground effect.
 * Floor particles follow the floor underside at the Bernoulli speed V·√(1 − Cp) from the live
 * floor Cp, then leave the diffuser as free particles.
 */
class FlowStreaks {
  constructor(count, parent) {
    this.n = count;
    this.p = new Float32Array(count * 3);
    this.v = new Float32Array(count * 3);
    this.kind = new Uint8Array(count); // 0 free, 1 under-floor
    this.f = new Float32Array(count);
    this.age = new Float32Array(count);
    const geo = new THREE.BoxGeometry(1, 0.0045, 0.0045);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.setColorAt(0, new THREE.Color(0, 0, 0));
    parent.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._c = new THREE.Color();
    this._u = { x: 0, y: 0, z: 0 };
    this.seeded = false;
  }

  /** Spawn particle i; `spread` distributes it along the whole domain (first fill). */
  spawn(i, ctx, spread) {
    const r = Math.random;
    const o = i * 3;
    this.age[i] = 0;
    if (r() < 0.22) {
      this.kind[i] = 1;
      this.f[i] = spread ? r() : 0;
      this.p[o + 1] = (r() * 2 - 1) * (ctx.floorHalfW - 0.03);
      this.placeFloor(i, ctx);
      return;
    }
    this.kind[i] = 0;
    // lanes concentrated where the flow is interesting: just under / over each wing, and
    // around the body; the far field adds nothing but clutter
    const lane = r();
    const side = r() < 0.5 ? 1 : -1;
    let y, z;
    if (lane < 0.4) { // front wing: under the main plane (ground effect) or over the flaps
      y = side * (0.22 + r() * (ctx.fwHalfSpan - 0.24));
      z = r() < 0.5 ? 0.015 + r() * 0.04 : ctx.fwTop + 0.01 + r() * 0.12;
    } else if (lane < 0.72) { // rear wing
      y = side * r() * (ctx.rwHalfSpan - 0.03);
      z = r() < 0.5 ? ctx.rwBottom - 0.16 + r() * 0.13 : ctx.rwTop + 0.01 + r() * 0.15;
    } else { // around the body
      y = side * r() * 0.8;
      z = 0.1 + r() * 0.9;
    }
    // rear-wing lanes start behind the cockpit, so they do not clutter the view ahead of the car
    const x0 = lane >= 0.4 && lane < 0.72 ? -0.9 : 1.25;
    const x = spread ? -3.1 + r() * (x0 + 3.1) : x0 + r() * 0.3;
    // seed upwind of the car when the flow is yawed
    y += Math.tan(ctx.psi) * (x - -0.75);
    this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z;
  }

  /** Position of an under-floor particle from its floor fraction (mid-gap). */
  placeFloor(i, ctx) {
    const o = i * 3;
    const f = this.f[i];
    const x = ctx.floorX0 + f * (ctx.floorX1 - ctx.floorX0);
    this.p[o] = x;
    this.p[o + 2] = 0.5 * (ctx.floorZ(f) + ctx.dzAt(x));
  }

  /** Velocity at car-frame point (x, y, z) → this._u. */
  field(x, y, z, ctx) {
    const u = this._u;
    u.x = ctx.Ux; u.y = ctx.Uy; u.z = 0;
    for (const s of ctx.sources) {
      for (let img = 0; img < 2; img++) {
        const sz = img ? -s.z : s.z;
        const dx = x - s.x, dy = y - s.y, dz = z - sz;
        const r2 = dx * dx + dy * dy + dz * dz + 0.02;
        const k = s.m / (4 * Math.PI * r2 * Math.sqrt(r2));
        u.x += k * dx; u.y += k * dy; u.z += k * dz;
      }
    }
    for (const w of ctx.vortices) {
      const ay = Math.abs(y);
      if (ay >= w.halfSpan) continue;
      const taper = Math.sqrt(1 - (ay / w.halfSpan) ** 4);
      const g = (y >= 0 ? w.gL : w.gR) * taper;
      if (!g) continue;
      for (let img = 0; img < 2; img++) {
        const zv = img ? -w.z : w.z;
        const gi = img ? -g : g;
        const dx = x - w.x, dz = z - zv;
        const r2 = dx * dx + dz * dz + 0.0064;
        const k = gi / (2 * Math.PI * r2);
        u.x += -k * dz; u.z += k * dx;
      }
    }
    return u;
  }

  /**
   * Advance by dt (wall seconds) and rebuild the instance matrices.
   * @param {number} dt
   * @param {object} ctx  flow context built by Car3D (speeds in m/s, car frame)
   */
  step(dt, ctx) {
    if (!this.seeded) {
      for (let i = 0; i < this.n; i++) this.spawn(i, ctx, true);
      this.seeded = true;
    }
    const k = SLOW_MOTION;
    const V = Math.max(ctx.V, 1e-3);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      this.age[i] += dt;
      let vx, vy, vz;
      if (this.kind[i] === 1) {
        const f = this.f[i];
        const y = this.p[o + 1];
        const cp = ctx.floorCpAt(f, y);
        const speed = V * Math.sqrt(Math.max(0.05, 1 - (isNum(cp) ? cp : 0)));
        const L = ctx.floorX0 - ctx.floorX1;
        const nf = f + (speed * k * dt) / L;
        // direction from the floor slope
        const dzdf = (ctx.floorZ(Math.min(1, f + 0.01)) - ctx.floorZ(f)) / 0.01;
        const slope = (0.5 * dzdf) / L;
        vx = -speed; vy = 0; vz = speed * slope;
        if (nf >= 1) {
          this.kind[i] = 0;
          this.p[o] = ctx.floorX1;
        } else {
          this.f[i] = nf;
          this.placeFloor(i, ctx);
        }
      } else {
        const u = this.field(this.p[o], this.p[o + 1], this.p[o + 2], ctx);
        vx = u.x; vy = u.y; vz = u.z;
        this.p[o] += vx * k * dt;
        this.p[o + 1] += vy * k * dt;
        this.p[o + 2] += vz * k * dt;
        const x = this.p[o], y = this.p[o + 1], z = this.p[o + 2];
        if (x < -3.3 || x > 2.3 || Math.abs(y) > 2.0 || z < 0.004 || z > 2.3 || ctx.inside(x, y, z)) {
          this.spawn(i, ctx, false);
        }
      }
      this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
    }
    // instance matrices + colours
    const m = this._m, q = this._q, s = this._s, t = this._t, dir = this._dir, c = this._c;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const vx = this.v[o], vy = this.v[o + 1], vz = this.v[o + 2];
      const sp = Math.hypot(vx, vy, vz);
      if (sp < 1e-6) {
        m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, m);
        continue;
      }
      dir.set(vx / sp, vz / sp, -vy / sp);
      const len = Math.min(0.4, Math.max(0.02, sp * k * 0.16));
      t.set(this.p[o], this.p[o + 2], -this.p[o + 1]).addScaledVector(dir, -len / 2);
      q.setFromUnitVectors(X_AXIS, dir);
      s.set(len, 1, 1);
      m.compose(t, q, s);
      this.mesh.setMatrixAt(i, m);
      // brightness follows the local speed ratio (fast = bright): reads like a velocity map
      const ratio = sp / V;
      const fade = Math.min(1, this.age[i] / 0.35);
      const b = Math.min(1, Math.max(0.18, 0.25 + 0.75 * (ratio - 0.7) / 0.9)) * fade;
      c.setRGB(0.45 * b, 0.72 * b, 1.0 * b);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

/* ================================================================== arrows */

/** Force arrow (shaft + cone) along local −Y, scalable by length. */
class Arrow {
  constructor(color, parent) {
    this.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.4 });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 1, 12), mat);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 16), mat);
    this.head.rotation.x = Math.PI; // cone tip points −Y
    this.group.add(this.shaft, this.head);
    parent.add(this.group);
    this.mat = mat;
  }

  /** Arrow with its tip at `tip`, pointing along unit vector `dir` (three.js), length L. */
  set(tip, dir, L) {
    const len = Math.max(0.12, L);
    this.group.position.copy(tip);
    this.group.quaternion.setFromUnitVectors(DOWN, dir);
    this.head.position.set(0, 0.05, 0);
    this.shaft.scale.set(1, len - 0.1, 1);
    this.shaft.position.set(0, 0.1 + (len - 0.1) / 2, 0);
  }

  dispose() {
    this.shaft.geometry.dispose();
    this.head.geometry.dispose();
    this.mat.dispose();
  }
}

/* ================================================================== Car3D */

/**
 * @typedef {object} Car3DOptions
 * @property {keyof VIEWS} [view='iso']
 * @property {boolean} [streaks=true]     flow streak particles
 * @property {boolean} [labels=true]      force / station labels
 * @property {boolean} [exaggerate=false] ride height and pitch ×5
 * @property {boolean} [inset=true]       underside inset (floor and wing suction surfaces)
 * @property {number} [maxPixelRatio=2]
 */

export class Car3D {
  /**
   * @param {HTMLElement} container  element the canvas fills (needs a CSS size)
   * @param {object} app             the dashboard app (app.meta must be set)
   * @param {Car3DOptions} [opts]
   */
  constructor(container, app, opts = {}) {
    this.container = container;
    this.opts = { view: 'iso', streaks: true, labels: true, exaggerate: false, inset: true, maxPixelRatio: 2, ...opts };
    this.vehicle = (app.meta && app.meta.vehicle) || {};
    this.failed = false;
    this.disposed = false;
    container.classList.add('c3');
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      this.failed = true;
      const msg = document.createElement('div');
      msg.className = 'c3-fallback';
      msg.textContent = `3D view unavailable: WebGL could not start (${err && err.message ? err.message : err}).`;
      container.append(msg);
      return;
    }
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping; // keep the Cp colours faithful to the colour bar
    r.domElement.className = 'c3-canvas';
    container.append(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1.6, 0.05, 80);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 14;
    this.controls.screenSpacePanning = true;

    this._buildLights();
    this._buildEnvironment();
    this._buildGround();
    this._buildCar();
    this._buildMirror();
    this._buildOverlays(app);
    this._buildHud();

    this.flow = new FlowStreaks(380, this.scene);
    this.flow.mesh.visible = this.opts.streaks;

    // state
    this.view = null;
    this.tween = null;
    this.pointer = null;
    this.colorAcc = COLOR_PERIOD_MS;
    this.lastColorT = NaN;
    this.time = 0;
    this.smooth = { dzf: 0, dzr: 0, steer: 0, init: false };
    this.spin = [0, 0, 0, 0];
    this.meta = app.meta;
    this.suspects = new Set();
    this.lowQ = false;

    this._onMove = (e) => {
      const b = r.domElement.getBoundingClientRect();
      this.pointer = { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    this._onLeave = () => { this.pointer = null; };
    r.domElement.addEventListener('pointermove', this._onMove);
    r.domElement.addEventListener('pointerleave', this._onLeave);
    this._onStart = () => { this.tween = null; };
    this.controls.addEventListener('start', this._onStart);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
    this.setView(this.opts.view, true);
  }

  /* ---------------------------------------------------------------- scene setup */

  _buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xdfe9f7, 0x1a1d22, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3, 6, -4); // above, front-left
    s.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7);
    fill.position.set(-4, 2.5, 5);
    s.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.0);
    rim.position.set(-6, 3, -2);
    s.add(rim);
    const under = new THREE.DirectionalLight(0xffffff, 1.1); // lights the underside view
    under.position.set(0.5, -6, 0.5);
    s.add(under);
  }

  /** Small procedural "studio" for image-based reflections (soft boxes on a dark room). */
  _buildEnvironment() {
    const env = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 30), new THREE.MeshBasicMaterial({ color: 0x1b1f26, side: THREE.BackSide }));
    room.position.y = 5;
    env.add(room);
    const panel = (w, h, x, y, z, rx, ry, c) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      env.add(m);
    };
    panel(12, 3, 0, 11, 0, Math.PI / 2, 0, 0xffffff);
    panel(6, 4, 9, 4, -6, 0, -Math.PI / 4, 0x9fb9e6);
    panel(6, 4, -10, 3, 5, 0, Math.PI / 3, 0x6c7e99);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(env, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }

  _buildGround() {
    const g = new THREE.Group();
    // translucent floor: lets the mirrored car show through as a reflection
    // alphaMap reads the green channel: grey levels = floor opacity (more see-through near the car)
    const fade = canvasTexture(256, (ctx, n) => {
      const grd = ctx.createRadialGradient(n / 2, n / 2, n * 0.05, n / 2, n / 2, n / 2);
      grd.addColorStop(0, 'rgb(212,212,212)');
      grd.addColorStop(0.35, 'rgb(226,226,226)');
      grd.addColorStop(1, 'rgb(255,255,255)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, n, n);
    }, false);
    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x0f1318, roughness: 0.92, metalness: 0, transparent: true, alphaMap: fade, depthWrite: false,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 72), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(-0.8, 0, 0);
    ground.renderOrder = 1;
    g.add(ground);
    const grid = new THREE.GridHelper(12, 24, 0x3a4553, 0x232a33);
    grid.position.set(-0.8, 0.0008, 0);
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    grid.material.depthWrite = false;
    grid.renderOrder = 2;
    g.add(grid);
    // contact shadow (soft rounded footprint of the car)
    const shadowTex = canvasTexture(256, (ctx, n) => {
      ctx.filter = 'blur(18px)';
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      ctx.roundRect(n * 0.12, n * 0.3, n * 0.76, n * 0.4, n * 0.12);
      ctx.fill();
    }, false);
    // the drawn footprint fills 76 % × 40 % of the texture: car ≈ 3.4 m × 1.45 m
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.4 / 0.76, 1.45 / 0.4), new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: shadowTex, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(-0.78, 0.0015, 0);
    shadow.renderOrder = 3;
    g.add(shadow);
    this.ground = g;
    this.scene.add(g);
  }

  /** Materials shared by the car (and its mirror image). */
  _materials() {
    const std = (color, roughness, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    const grill = canvasTexture(64, (ctx, n) => {
      ctx.fillStyle = '#07090b';
      ctx.fillRect(0, 0, n, n);
      ctx.strokeStyle = '#2a3038';
      ctx.lineWidth = 2;
      for (let i = 0; i <= n; i += 8) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, n); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(n, i); ctx.stroke();
      }
    });
    grill.wrapS = grill.wrapT = THREE.RepeatWrapping;
    grill.repeat.set(5, 6);
    const hv = canvasTexture(128, (ctx, n) => {
      ctx.fillStyle = '#f2c230';
      ctx.beginPath(); ctx.moveTo(n / 2, n * 0.08); ctx.lineTo(n * 0.95, n * 0.88); ctx.lineTo(n * 0.05, n * 0.88); ctx.closePath(); ctx.fill();
      ctx.lineWidth = n * 0.05; ctx.strokeStyle = '#111'; ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(n * 0.55, n * 0.3); ctx.lineTo(n * 0.4, n * 0.6); ctx.lineTo(n * 0.52, n * 0.6);
      ctx.lineTo(n * 0.45, n * 0.82); ctx.lineTo(n * 0.63, n * 0.5); ctx.lineTo(n * 0.51, n * 0.5); ctx.closePath(); ctx.fill();
    });
    this.textures = [grill, hv];
    return {
      paint: std(0x46505e, 0.28, 0.55),
      accent: std(0x9bd63a, 0.45, 0.1),
      carbon: std(0x22262c, 0.34, 0.35),
      carbonDS: std(0x22262c, 0.34, 0.35, { side: THREE.DoubleSide }),
      dark: std(0x08090b, 0.95, 0),
      cockpit: std(0x050607, 1, 0, { side: THREE.DoubleSide }),
      grill: std(0xffffff, 0.8, 0.2, { map: grill }),
      metal: std(0xa7b0ba, 0.32, 0.85),
      tube: std(0x7d8792, 0.4, 0.7),
      tyre: std(0x141517, 0.88, 0),
      tyreMark: std(0xd9b437, 0.6, 0),
      rim: std(0x464d57, 0.32, 0.85),
      disc: std(0x7a8088, 0.45, 0.9),
      hub: std(0xc2402f, 0.4, 0.5),
      helmet: std(0xeef1f5, 0.28, 0.1),
      visor: std(0x0b1622, 0.08, 0.7),
      suit: std(0x22272f, 0.85, 0),
      battery: std(0x3a3f47, 0.55, 0.3),
      hv: std(0xffffff, 0.6, 0, { map: hv, transparent: true }),
      data: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0, side: THREE.FrontSide }),
      dataFloor: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0 }),
    };
  }

  /** Read the geometry parameters (with SPEC §3 defaults). */
  _dims() {
    const v = this.vehicle;
    const a = v.aero || {};
    const num = (x, d) => (isNum(Number(x)) ? Number(x) : d);
    const fw = a.front_wing || {};
    const rw = a.rear_wing || {};
    const ut = a.undertray || {};
    const susp = v.suspension || {};
    const rh = susp.static_ride_height_mm || {};
    return {
      L: num(v.wheelbase_m, 1.53),
      tf: num(v.track_front_m, 1.22),
      tr: num(v.track_rear_m, 1.18),
      r: num(v.wheel_radius_m, 0.228),
      fw: {
        chord_m: num(fw.chord_m, 0.36), span_m: num(fw.span_m, 1.4), le_x_m: num(fw.le_x_m, 0.8), z_m: num(fw.z_m, 0.07),
        station_y_m: Array.isArray(fw.station_y_m) ? fw.station_y_m.map(Number) : [0.55, -0.55],
      },
      rw: {
        chord_m: num(rw.chord_m, 0.48), span_m: num(rw.span_m, 1.1), le_x_m: num(rw.le_x_m, -1.7), z_m: num(rw.z_m, 1.05),
        station_y_m: Array.isArray(rw.station_y_m) ? rw.station_y_m.map(Number) : [0.25, -0.25],
      },
      ut: { x0: num(ut.x_start_m, 0.15), x1: num(ut.x_end_m, -1.95), w: num(ut.width_m, 0.9), z: num(ut.z_m, 0.03) },
      pitot: { x: num((a.pitot || {}).x_m, 0.95), z: num((a.pitot || {}).z_m, 0.45) },
      rhStatic: { f: num(rh.front, 30), r: num(rh.rear, 35) },
      steerRatio: num((v.steering || {}).ratio, 5),
    };
  }

  /** A stretchable cylinder of radius r (geometries shared per radius). */
  _link(r, mat, parent) {
    this.linkGeos = this.linkGeos || new Map();
    if (!this.linkGeos.has(r)) this.linkGeos.set(r, new THREE.CylinderGeometry(r, r, 1, 8, 1));
    return new Link(this.linkGeos.get(r), mat, parent);
  }

  _buildCar() {
    this.dims = this._dims();
    this.mats = this._materials();
    this.carRoot = new THREE.Group();
    this.scene.add(this.carRoot);
    this.body = new THREE.Group(); // sprung mass (moves with ride height / pitch)
    this.carRoot.add(this.body);
    this.dataMeshes = [];
    this._buildTub();
    this._buildFloor();
    this._buildWings();
    this._buildSidepodsAndRear();
    this._buildDriverAndHoops();
    this._buildWheels();
    this._buildSuspension();
    mergeStatic(this.body, new Set(this.dataMeshes));
  }

  /** Monocoque + nose (lofted), cockpit opening, pitot probe. */
  _buildTub() {
    const M = this.mats, d = this.dims;
    const nose = d.fw.le_x_m - 0.05;
    const sections = [
      // the nose stays above the front wing main plane (bottom ≥ 0.16 m) and drops to the
      // floor behind the flaps (front bulkhead)
      { x: nose, hw: 0.035, hh: 0.035, zc: 0.235, n: 2.2 },
      { x: nose - 0.08, hw: 0.085, hh: 0.07, zc: 0.245, n: 2.4 },
      { x: nose - 0.22, hw: 0.13, hh: 0.1, zc: 0.27, n: 2.6 },
      { x: 0.36, hw: 0.165, hh: 0.13, zc: 0.29, n: 2.9 },
      { x: 0.18, hw: 0.19, hh: 0.22, zc: 0.27, n: 3.2 },
      { x: -0.12, hw: 0.215, hh: 0.245, zc: 0.29, n: 3.4 },
      { x: -0.38, hw: 0.25, hh: 0.215, zc: 0.26, n: 3.6 },
      { x: -0.68, hw: 0.27, hh: 0.21, zc: 0.255, n: 3.8 },
      { x: -0.9, hw: 0.255, hh: 0.21, zc: 0.255, n: 3.6 },
      { x: -1.0, hw: 0.22, hh: 0.19, zc: 0.25, n: 3.2 },
    ];
    const geo = loftGeometry(sections);
    this.tubRows = geo.userData.rows;
    this.body.add(new THREE.Mesh(geo, M.paint));

    // cockpit opening: dark inset following the top surface
    const xs = linspace(-0.12, -0.84, 28);
    const halfW = (x) => 0.175 * Math.sqrt(Math.max(0, 1 - ((x + 0.48) / 0.37) ** 8));
    const left = xs.map((x) => carV(x, halfW(x), loftTopAt(this.tubRows, x) + 0.003));
    const right = xs.map((x) => carV(x, -halfW(x), loftTopAt(this.tubRows, x) + 0.003));
    this.body.add(new THREE.Mesh(stripGeometry(left, right), M.cockpit));

    // accent stripes along the nose
    for (const side of [1, -1]) {
      const sx = linspace(nose - 0.06, -0.1, 24);
      const top = sx.map((x) => carV(x, side * (loftHalfWidthAt(this.tubRows, x) * 0.62), loftTopAt(this.tubRows, x) - 0.012 + 0.004));
      const bot = sx.map((x) => carV(x, side * (loftHalfWidthAt(this.tubRows, x) * 0.62 + 0.018), loftTopAt(this.tubRows, x) - 0.03));
      this.body.add(new THREE.Mesh(stripGeometry(top, bot), M.accent));
    }

    // pitot-static probe (vehicle.aero.pitot): stalk from the nose to the probe
    const xs0 = nose - 0.2;
    const base = carV(xs0, 0, loftTopAt(this.tubRows, xs0) - 0.005);
    const elbow = carV(d.pitot.x - 0.18, 0, d.pitot.z);
    const tip = carV(d.pitot.x, 0, d.pitot.z);
    for (const [a, b, r] of [[base, elbow, 0.007], [elbow, tip, 0.005]]) this._link(r, M.metal, this.body).set(a, b);
    const probe = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), M.metal);
    probe.position.copy(tip);
    this.body.add(probe);
  }

  /** Floor surface height (underside) at floor fraction f: inlet lip, venturi, diffuser ramp. */
  floorZ(f) {
    const u = this.dims.ut;
    const L = u.x0 - u.x1;
    let z = u.z;
    if (f < 0.06) z += 0.012 * (1 - f / 0.06) ** 2; // rounded inlet lip
    const fv = Math.min(f, DIFFUSER_START);
    z += 0.006 * ((fv - 0.4) / 0.4) ** 2; // gentle venturi: throat (lowest point) at 40 %
    if (f > DIFFUSER_START) z += (f - DIFFUSER_START) * L * Math.tan((DIFFUSER_DEG * Math.PI) / 180);
    return z;
  }

  /** Undertray: coloured underside grid, carbon top, tunnel fences and side skirts. */
  _buildFloor() {
    const M = this.mats, u = this.dims.ut;
    const half = u.w / 2;
    const tapF = [0.05, 0.2, 0.4, 0.6, 0.8, 0.97, DIFFUSER_START];
    const fs = uniqueSorted([...linspace(0, 1, 64), ...tapF]);
    const ys = uniqueSorted([...linspace(-half, half, 25), 0.3, -0.3, 0.15, -0.15]);
    const nf = fs.length, ny = ys.length;
    const xOf = (f) => u.x0 + f * (u.x1 - u.x0);
    const pos = new Float32Array(nf * ny * 3);
    const top = new Float32Array(nf * ny * 3);
    const fArr = new Float32Array(nf * ny), yArr = new Float32Array(nf * ny);
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < ny; j++) {
        const v = i * ny + j;
        const x = xOf(fs[i]), z = this.floorZ(fs[i]);
        pos.set([x, z, -ys[j]], v * 3);
        top.set([x, z + 0.005, -ys[j]], v * 3);
        fArr[v] = fs[i]; yArr[v] = ys[j];
      }
    }
    const under = new THREE.BufferGeometry();
    under.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    under.setIndex(gridIndex(nf, ny));
    orientNormals(under, Math.floor(nf / 2) * ny + Math.floor(ny / 2), new THREE.Vector3(0, -1, 0));
    under.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nf * ny * 3), 3));
    under.userData.floor = { f: fArr, y: yArr };
    const underMesh = new THREE.Mesh(under, M.dataFloor);
    this.body.add(underMesh);
    this.dataMeshes.push(underMesh);
    const upper = new THREE.BufferGeometry();
    upper.setAttribute('position', new THREE.BufferAttribute(top, 3));
    upper.setIndex(gridIndex(nf, ny));
    orientNormals(upper, Math.floor(nf / 2) * ny + Math.floor(ny / 2), new THREE.Vector3(0, 1, 0));
    this.body.add(new THREE.Mesh(upper, M.carbon));
    // edges (front lip and sides) so the plate has thickness
    const edge = (pts) => this.body.add(new THREE.Mesh(stripGeometry(pts.map((p) => carV(p[0], p[1], p[2])), pts.map((p) => carV(p[0], p[1], p[2] + 0.005))), M.carbonDS));
    for (const side of [1, -1]) edge(fs.map((f) => [xOf(f), side * half, this.floorZ(f)]));
    edge(ys.map((y) => [u.x0, y, this.floorZ(0)]));
    edge(ys.map((y) => [u.x1, y, this.floorZ(1)]));
    // diffuser tunnel fences (inner) and full-length side skirts (outer)
    const fd = fs.filter((f) => f >= DIFFUSER_START);
    for (const side of [1, -1]) {
      const yIn = side * 0.15;
      this.body.add(new THREE.Mesh(stripGeometry(fd.map((f) => carV(xOf(f), yIn, this.floorZ(f))), fd.map((f) => carV(xOf(f), yIn, u.z + 0.002))), M.carbonDS));
      const yOut = side * (half - 0.002);
      this.body.add(new THREE.Mesh(stripGeometry(fs.map((f) => carV(xOf(f), yOut, this.floorZ(f))), fs.map((f) => carV(xOf(f), yOut, Math.max(0.014, u.z - 0.012)))), M.carbonDS));
    }
  }

  /** Front wing (main + split flap, endplates, pylons) and rear wing (3 elements, endplates, mounts). */
  _buildWings() {
    const M = this.mats, d = this.dims;
    this.wings = {};
    const build = (key, wing, design, opts) => {
      const els = wingElements(wing, design);
      const half = wing.span_m / 2;
      const [yL, yR] = wing.station_y_m;
      const spanYs = uniqueSorted([...linspace(-half, half, 31), yL, yR]);
      const main = new THREE.Mesh(elementGeometry(els[0], spanYs, { yL, yR, element: key }), M.data);
      this.body.add(main);
      this.dataMeshes.push(main);
      for (const y of [half, -half]) this.body.add(new THREE.Mesh(elementCap(els[0], y), M.carbonDS));
      els.slice(1).forEach((el) => {
        for (const [y0, y1] of opts.flapSpans) {
          const ys = linspace(y0, y1, 12);
          this.body.add(new THREE.Mesh(elementGeometry(el, ys, null), M.carbon));
          this.body.add(new THREE.Mesh(elementCap(el, y0), M.carbonDS));
          this.body.add(new THREE.Mesh(elementCap(el, y1), M.carbonDS));
        }
      });
      const shape = endplateShape(els, opts.endplateBottom(els));
      for (const s of [1, -1]) this.body.add(plateFromShape(shape, s * (half + 0.005), 0.008, M.carbon));
      this.wings[key] = { els, half, yL, yR, chord: wing.chord_m };
      return els;
    };
    const fwHalf = d.fw.span_m / 2;
    const nose = 0.15; // flaps are split around the nose
    const fwEls = build('fw', d.fw, FRONT_WING_DESIGN, {
      flapSpans: [[nose + 0.03, fwHalf - 0.004], [-(fwHalf - 0.004), -(nose + 0.03)]],
      endplateBottom: (els) => Math.max(0.03, els[0].bounds().z0 - 0.035),
    });
    build('rw', d.rw, REAR_WING_DESIGN, {
      flapSpans: [[-(d.rw.span_m / 2 - 0.004), d.rw.span_m / 2 - 0.004]],
      endplateBottom: (els) => els[0].bounds().z0 - 0.1,
    });
    // front wing pylons: nose underside → main plane top
    const main = fwEls[0];
    for (const s of [1, -1]) {
      const xa = main.xle - 0.12, xb = main.xle - 0.24;
      const zTop = (x) => {
        let best = 0;
        for (const row of this.tubRows) if (Math.abs(row.x - x) < 0.08) best = Math.max(best, row.zc - row.hh);
        return best || 0.15;
      };
      const pz = (x) => main.surfacePoint('pressure', (main.xle - x) / main.c)[1];
      const shape = new THREE.Shape();
      shape.moveTo(xa, pz(xa)); shape.lineTo(xb, pz(xb)); shape.lineTo(xb - 0.02, zTop(xb) + 0.02); shape.lineTo(xa + 0.03, zTop(xa) + 0.02); shape.closePath();
      this.body.add(plateFromShape(shape, s * 0.07, 0.008, M.carbon));
    }
    // rear wing swan-neck mounts: rear frame → main plane underside
    const rmain = this.wings.rw.els[0];
    for (const s of [1, -1]) {
      const [xu, zu] = rmain.surfacePoint('suction', 0.35);
      const shape = new THREE.Shape();
      shape.moveTo(-1.6, 0.42);
      shape.lineTo(-1.66, 0.42);
      shape.quadraticCurveTo(xu - 0.02, 0.8, xu - 0.04, zu + 0.005);
      shape.lineTo(xu + 0.07, zu + 0.015);
      shape.quadraticCurveTo(xu + 0.02, 0.75, -1.6, 0.42);
      this.body.add(plateFromShape(shape, s * 0.18, 0.008, M.carbon));
    }
  }

  /** Sidepods (radiator inlets), accumulator container, rear frame, motor. */
  _buildSidepodsAndRear() {
    const M = this.mats;
    // sidepod side profile (car x, z), extruded outward
    const pod = new THREE.Shape();
    pod.moveTo(-0.3, 0.06);
    pod.lineTo(-0.38, 0.36);
    pod.quadraticCurveTo(-0.42, 0.405, -0.5, 0.405);
    pod.lineTo(-0.95, 0.38);
    pod.quadraticCurveTo(-1.2, 0.33, -1.25, 0.2);
    pod.lineTo(-1.25, 0.06);
    pod.closePath();
    for (const s of [1, -1]) {
      const geo = new THREE.ExtrudeGeometry(pod, { depth: 0.17, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 10 });
      geo.translate(0, 0, s > 0 ? -0.45 + 0.02 : 0.28 + 0.0);
      this.body.add(new THREE.Mesh(geo, M.paint));
      // radiator inlet on the raked front face
      const a = carV(-0.305, s * 0.365, 0.075), b = carV(-0.375, s * 0.365, 0.345);
      const len = a.distanceTo(b);
      const grill = new THREE.Mesh(new THREE.PlaneGeometry(0.15, len), M.grill);
      // plane basis: width across the car (three Z), height up the raked face, normal forward
      const yAx = b.clone().sub(a).normalize();
      const xAx = new THREE.Vector3(0, 0, 1);
      const zAx = new THREE.Vector3().crossVectors(xAx, yAx).normalize();
      grill.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAx, yAx, zAx));
      grill.position.copy(a).add(b).multiplyScalar(0.5).addScaledVector(zAx, 0.024);
      this.body.add(grill);
    }
    // accumulator container (behind the main hoop) with HV warning label
    const acc = new THREE.Shape();
    acc.moveTo(-0.86, 0.09); acc.lineTo(-0.86, 0.5); acc.lineTo(-1.3, 0.47); acc.lineTo(-1.32, 0.09); acc.closePath();
    const ag = new THREE.ExtrudeGeometry(acc, { depth: 0.44, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 });
    ag.translate(0, 0, -0.22);
    this.body.add(new THREE.Mesh(ag, M.battery));
    for (const s of [1, -1]) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), M.hv);
      label.position.copy(carV(-1.08, s * 0.24, 0.43));
      label.rotation.y = s > 0 ? Math.PI : 0;
      this.body.add(label);
    }
    // rear frame (steel tubes) around the motor
    const T = (a, b, r = 0.0095) => this._link(r, M.tube, this.body).set(carV(...a), carV(...b));
    for (const s of [1, -1]) {
      T([-1.28, s * 0.21, 0.46], [-1.8, s * 0.2, 0.42]);
      T([-1.3, s * 0.21, 0.2], [-1.8, s * 0.2, 0.2]);
      T([-1.8, s * 0.2, 0.2], [-1.8, s * 0.2, 0.42]);
      T([-1.55, s * 0.21, 0.2], [-1.6, s * 0.2, 0.44]);
    }
    T([-1.8, 0.2, 0.42], [-1.8, -0.2, 0.42]);
    T([-1.8, 0.2, 0.2], [-1.8, -0.2, 0.2]);
    // motor + gearbox on the rear axle
    const L = this.dims.L, r = this.dims.r;
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.26, 28), M.metal);
    motor.rotation.x = Math.PI / 2;
    motor.position.copy(carV(-L, 0, r));
    this.body.add(motor);
    const gear = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 20), M.carbon);
    gear.rotation.x = Math.PI / 2;
    gear.position.copy(carV(-L, 0, r));
    this.body.add(gear);
  }

  /** Main and front roll hoops (with braces), driver (helmet, torso, arms), steering wheel. */
  _buildDriverAndHoops() {
    const M = this.mats;
    const tube = (pts, r = 0.0125) => {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => carV(...p)));
      this.body.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 10), M.tube));
    };
    tube([[-0.78, 0.25, 0.42], [-0.79, 0.245, 0.75], [-0.8, 0.19, 1.05], [-0.81, 0.08, 1.12], [-0.81, -0.08, 1.12], [-0.8, -0.19, 1.05], [-0.79, -0.245, 0.75], [-0.78, -0.25, 0.42]]);
    for (const s of [1, -1]) tube([[-0.81, s * 0.14, 1.09], [-1.05, s * 0.18, 0.8], [-1.28, s * 0.21, 0.46]], 0.0095);
    tube([[-0.17, 0.21, 0.5], [-0.17, 0.18, 0.6], [-0.17, 0.08, 0.645], [-0.17, -0.08, 0.645], [-0.17, -0.18, 0.6], [-0.17, -0.21, 0.5]]);
    // driver
    const hx = -0.6;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 32, 24), M.helmet);
    helmet.position.copy(carV(hx, 0, 0.775));
    helmet.scale.set(1.08, 0.98, 0.95);
    this.body.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.128, 28, 12, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.2), M.visor);
    visor.rotation.y = Math.PI; // the band is centred on −X; turn it to face +X (forward)
    visor.position.copy(helmet.position);
    visor.scale.copy(helmet.scale);
    this.body.add(visor);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.124, 0.012, 8, 40, Math.PI), M.accent);
    stripe.position.copy(helmet.position); // half torus in the x-z plane: front → over the top → back
    stripe.scale.copy(helmet.scale);
    this.body.add(stripe);
    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.18, 4, 12), M.suit);
    neck.position.copy(carV(hx - 0.04, 0, 0.58));
    this.body.add(neck);
    const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.27, 4, 12), M.suit);
    shoulders.rotation.x = Math.PI / 2;
    shoulders.position.copy(carV(hx - 0.06, 0, 0.5));
    this.body.add(shoulders);
    const wheelPos = carV(-0.3, 0, 0.52);
    for (const s of [1, -1]) this._link(0.035, M.suit, this.body).set(carV(hx - 0.04, s * 0.17, 0.5), carV(-0.33, s * 0.1, 0.5));
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.014, 10, 32), M.carbon);
    sw.position.copy(wheelPos);
    sw.rotation.y = Math.PI / 2;
    sw.rotateX(-0.35);
    this.body.add(sw);
    // headrest behind the helmet
    const hr = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.12, 4, 12), M.dark);
    hr.rotation.x = Math.PI / 2;
    hr.position.copy(carV(-0.76, 0, 0.66));
    this.body.add(hr);
  }

  /** Four wheels: tyre (lathe), rim with spokes, disc, hub nut; steer and spin nodes. */
  _buildWheels() {
    const M = this.mats, d = this.dims;
    const r = d.r, w = 0.19, rr = 0.128;
    // tyre cross-section (radius, axial) revolved around the axle
    const prof = [];
    const sh = 0.035;
    prof.push(new THREE.Vector2(rr + 0.004, -w / 2 + 0.006));
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(r - sh + sh * Math.cos(a), -w / 2 + sh + sh * Math.sin(a))); }
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push(new THREE.Vector2(r - sh + sh * Math.cos(a), w / 2 - sh + sh * Math.sin(a))); }
    prof.push(new THREE.Vector2(rr + 0.004, w / 2 - 0.006));
    const tyreGeo = new THREE.LatheGeometry(prof, 56);
    tyreGeo.rotateX(Math.PI / 2); // lathe axis Y → axle along three Z
    const barrel = new THREE.CylinderGeometry(rr, rr, w - 0.03, 32, 1, true);
    barrel.rotateX(Math.PI / 2);
    const face = new THREE.Shape();
    face.absarc(0, 0, rr, 0, Math.PI * 2, false);
    for (let k = 0; k < 5; k++) {
      const a0 = (k / 5) * Math.PI * 2 + 0.22, a1 = a0 + (Math.PI * 2) / 5 - 0.44;
      const hole = new THREE.Path();
      hole.absarc(0, 0, rr - 0.018, a0, a1, false);
      hole.absarc(0, 0, 0.045, a1, a0, true);
      face.holes.push(hole);
    }
    const faceGeo = new THREE.ExtrudeGeometry(face, { depth: 0.012, bevelEnabled: false, curveSegments: 18 });
    faceGeo.translate(0, 0, w / 2 - 0.05);
    const discGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.008, 28);
    discGeo.rotateX(Math.PI / 2);
    const nutGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.03, 6);
    nutGeo.rotateX(Math.PI / 2);
    const markGeo = new THREE.RingGeometry(r - 0.06, r - 0.045, 16, 1, 0, 0.7);
    const uprightGeo = new THREE.BoxGeometry(0.07, 0.24, 0.05);
    this.corners = [];
    const L = d.L;
    for (const [key, xa, side, track] of [['fl', 0, 1, d.tf], ['fr', 0, -1, d.tf], ['rl', -L, 1, d.tr], ['rr', -L, -1, d.tr]]) {
      const root = new THREE.Group();
      root.position.copy(carV(xa, side * track / 2, r));
      const steer = new THREE.Group();
      const mirror = new THREE.Group();
      mirror.scale.z = side > 0 ? -1 : 1; // outer face towards the outside of the car
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(tyreGeo, M.tyre));
      spin.add(new THREE.Mesh(barrel, M.rim));
      spin.add(new THREE.Mesh(faceGeo, M.rim));
      const nut = new THREE.Mesh(nutGeo, M.hub);
      nut.position.z = w / 2 - 0.03;
      spin.add(nut);
      for (const a of [0, Math.PI]) {
        const mark = new THREE.Mesh(markGeo, M.tyreMark);
        mark.position.z = w / 2 + 0.001;
        mark.rotation.z = a;
        spin.add(mark);
      }
      const disc = new THREE.Mesh(discGeo, M.disc);
      disc.position.z = -0.02;
      mirror.add(spin, disc);
      const upright = new THREE.Mesh(uprightGeo, M.carbon);
      upright.position.z = -0.075;
      mirror.add(upright);
      steer.add(mirror);
      root.add(steer);
      this.carRoot.add(root);
      this.corners.push({ key, xa, side, track, root, steer, spin, front: xa === 0 });
    }
  }

  /** Double wishbones, pushrods, tie rods and drive shafts (re-stretched every frame). */
  _buildSuspension() {
    const M = this.mats;
    this.links = [];
    for (const c of this.corners) {
      const t = c.track / 2, s = c.side, xa = c.xa;
      const out = (dx, dy, z) => ({ x: xa + dx, y: s * (t - dy), z }); // unsprung (upright)
      const inb = (dx, y, z) => ({ x: xa + dx, y: s * y, z }); // sprung (chassis)
      const lbj = out(0, 0.075, 0.11), ubj = out(-0.01, 0.09, 0.335);
      // inboard pickups: on the monocoque at the front, on the rear frame rails at the rear
      const zl = c.front ? 0.1 : 0.2, zu = c.front ? 0.3 : 0.42;
      const list = [
        [inb(0.13, 0.17, zl), lbj, 0.0085], [inb(-0.13, 0.17, zl - 0.005), lbj, 0.0085],
        [inb(0.12, 0.2, zu), ubj, 0.0085], [inb(-0.12, 0.2, zu + 0.01), ubj, 0.0085],
        // pushrod: lower wishbone near the upright → rocker on the chassis
        [out(0.0, 0.12, 0.135), c.front ? inb(-0.02, 0.16, 0.44) : inb(0.05, 0.17, 0.42), 0.0095],
      ];
      if (c.front) list.push([inb(0.07, 0.16, 0.2), out(0.07, 0.08, 0.2), 0.0065]); // tie rod
      else list.push([inb(0, 0.13, this.dims.r), out(0, 0.1, this.dims.r), 0.016]); // drive shaft
      for (const [a, b, r] of list) {
        const link = this._link(r, r > 0.012 ? M.metal : M.tube, this.carRoot);
        this.links.push({ corner: c, inb: a, out: b, link });
      }
      // rocker blocks on the chassis
      const rk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.035), M.metal);
      const rp = c.front ? inb(-0.02, 0.16, 0.44) : inb(0.05, 0.17, 0.42);
      rk.position.copy(carV(rp.x, rp.y, rp.z));
      this.body.add(rk);
    }
    this._va = new THREE.Vector3();
    this._vb = new THREE.Vector3();
  }

  /** Mirrored copy of the car below the translucent floor (shares geometry and materials). */
  _buildMirror() {
    this.mirror = this.carRoot.clone(true);
    this.mirror.scale.y = -1;
    this.scene.add(this.mirror);
    this.mirrorPairs = [];
    const walk = (a, b) => {
      for (let i = 0; i < a.children.length; i++) {
        this.mirrorPairs.push([a.children[i], b.children[i]]);
        walk(a.children[i], b.children[i]);
      }
    };
    walk(this.carRoot, this.mirror);
  }

  /** Tap markers, rings, arrows (follow the sprung body but are not mirrored). */
  _buildOverlays(app) {
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    const dot = canvasTexture(64, (ctx, n) => {
      ctx.beginPath(); ctx.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = n * 0.09; ctx.strokeStyle = '#0b0e12'; ctx.stroke();
    });
    const hollow = canvasTexture(64, (ctx, n) => {
      ctx.beginPath(); ctx.arc(n / 2, n / 2, n * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(11,14,18,0.85)'; ctx.fill();
      ctx.lineWidth = n * 0.1; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    });
    const ring = canvasTexture(128, (ctx, n) => {
      ctx.beginPath(); ctx.arc(n / 2, n / 2, n * 0.42, 0, Math.PI * 2);
      ctx.lineWidth = n * 0.07; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    });
    this.spriteTex = { dot, hollow, ring };
    this.taps = [];
    this._initTaps(app);
    // arrows
    this.arrows = {
      front: new Arrow(0x2fbf8a, this.overlay),
      rear: new Arrow(0x2fbf8a, this.overlay),
      drag: new Arrow(0xe2703f, this.overlay),
    };
  }

  /** (Re)build the tap list from the channel catalogue (meta.element/station/surface/x_c). */
  _initTaps(app) {
    for (const t of this.taps) {
      this.overlay.remove(t.sprite, t.ring);
      t.sprite.material.dispose();
      t.ring.material.dispose();
    }
    this.taps = [];
    const defs = [...app.channels.values()].filter((c) => c.group === 'aero.taps' && c.meta && c.meta.element);
    for (const def of defs) {
      const m = def.meta;
      const p = this._tapSurfacePoint(m);
      if (!p) continue;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.spriteTex.dot, sizeAttenuation: false, depthTest: true, transparent: true,
      }));
      sprite.position.copy(p.pos);
      sprite.renderOrder = 6;
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.spriteTex.ring, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true,
      }));
      ring.position.copy(p.pos);
      ring.renderOrder = 12;
      ring.visible = false;
      this.overlay.add(sprite, ring);
      this.taps.push({
        id: def.id, cpId: `calc_cp_${def.id}`, def, element: m.element, station: m.station, surface: m.surface,
        xc: Number(m.x_c), y: isNum(Number(m.y)) ? Number(m.y) : Array.isArray(m.pos) ? Number(m.pos[1]) : 0,
        pos: p.pos, normal: p.normal, sprite, ring, cp: NaN, held: NaN, state: 'missing', owner: '', suspect: false,
        world: new THREE.Vector3(),
      });
    }
  }

  /**
   * Marker position of a tap on the modelled surface: the tap's x/c on the main plane (or
   * floor fraction), its station y from `meta.pos`, offset 3 mm out of the surface. The
   * catalogue's `meta.pos` is the flat-plate reference of the same point (within ≈ 2 cm).
   */
  _tapSurfacePoint(m) {
    const xc = Number(m.x_c);
    if (m.element === 'fw' || m.element === 'rw') {
      const w = this.wings[m.element];
      if (!w) return null;
      const el = w.els[0];
      const y = Array.isArray(m.pos) ? Number(m.pos[1]) : m.station === 'L' ? w.yL : w.yR;
      const surf = m.surface === 'pressure' ? 'pressure' : 'suction';
      const [x, z] = el.surfacePoint(surf, xc);
      const nz = surf === 'pressure' ? 1 : -1;
      return { pos: carV(x, y, z + nz * 0.003), normal: new THREE.Vector3(0, nz, 0) };
    }
    if (m.element === 'ut') {
      const u = this.dims.ut;
      const x = u.x0 + xc * (u.x1 - u.x0);
      const y = isNum(Number(m.y)) ? Number(m.y) : 0;
      return { pos: carV(x, y, this.floorZ(xc) - 0.003), normal: new THREE.Vector3(0, -1, 0) };
    }
    return null;
  }

  /** HTML overlays: labels, tooltip, colour bar, status chips. */
  _buildHud() {
    const c = this.container;
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'c3-labels';
    this.tip = document.createElement('div');
    this.tip.className = 'c3-tip';
    this.tip.hidden = true;
    const legend = document.createElement('div');
    legend.className = 'c3-legend';
    const cb = document.createElement('div');
    this.colorbar = colorbar(cb, {
      kind: 'diverging', vmin: CP_RANGE.min, vmax: CP_RANGE.max, label: 'Pressure coefficient Cp',
      ticks: [-3.5, -2, -1, 0, 1], lowLabel: 'suction', highLabel: 'pressure',
    });
    const keys = document.createElement('div');
    keys.className = 'c3-keys';
    keys.innerHTML = `
      <span><i class="c3-k dot"></i>tap</span>
      <span><i class="c3-k hollow"></i>missing / stale</span>
      <span><i class="c3-k ring real"></i>real sensor</span>
      <span><i class="c3-k ring suspect"></i>suspect tap</span>`;
    legend.append(cb, keys);
    this.chips = document.createElement('div');
    this.chips.className = 'c3-chips';
    // underside inset: an orthographic camera under the car, looking up (nose right, car
    // right side at the top)
    this.pipFrame = document.createElement('div');
    this.pipFrame.className = 'c3-pip';
    this.pipFrame.innerHTML = '<span class="c3-pip-title">Underside · suction surfaces</span><span class="c3-pip-side r">R</span><span class="c3-pip-side l">L</span><span class="c3-pip-nose">nose ▸</span>';
    c.append(this.labelLayer, legend, this.chips, this.pipFrame, this.tip);
    const u = this.dims.ut;
    this.pipSpan = { x0: this.dims.fw.le_x_m + 0.12, x1: Math.min(u.x1, this.wings.rw.els[this.wings.rw.els.length - 1].bounds().x0) - 0.1 };
    const half = (this.pipSpan.x0 - this.pipSpan.x1) / 2;
    this.pipCam = new THREE.OrthographicCamera(-half, half, half / PIP_ASPECT, -half / PIP_ASPECT, 0.1, 20);
    this.pipCam.up.set(0, 0, 1);
    this.pipCam.position.copy(carV((this.pipSpan.x0 + this.pipSpan.x1) / 2, 0, -3));
    this.pipCam.lookAt(carV((this.pipSpan.x0 + this.pipSpan.x1) / 2, 0, 0));
    this.labels = new Map();
  }

  /* ---------------------------------------------------------------- public API */

  /**
   * Move the camera to a preset view with a smooth orbit (or instantly).
   * @param {keyof VIEWS} name
   * @param {boolean} [instant=false]
   */
  setView(name, instant = false) {
    if (this.failed || !VIEWS[name]) return;
    this.view = name;
    const v = VIEWS[name];
    const target = carV(...v.target);
    const off = carV(...v.pos).sub(target).multiplyScalar(this._distScale());
    const to = { target, sph: new THREE.Spherical().setFromVector3(off) };
    if (instant) {
      this._applyCam(to.target, to.sph);
      this.tween = null;
      return;
    }
    const from = {
      target: this.controls.target.clone(),
      sph: new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)),
    };
    let dth = to.sph.theta - from.sph.theta;
    dth = ((((dth + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    to.sph.theta = from.sph.theta + dth;
    this.tween = { from, to, t: 0, dur: 0.95 };
  }

  /**
   * Show a short status next to a wing-station label (e.g. the section-Cl change against a
   * baseline, "−51 %") with a level ('', 'warning', 'critical') that colours the label.
   * @param {'fw-L'|'fw-R'|'rw-L'|'rw-R'} key
   * @param {string} text
   * @param {string} level
   */
  setStationStatus(key, text, level) {
    this.stationStatus = this.stationStatus || {};
    this.stationStatus[key] = { text, level };
  }

  /**
   * Change display options.
   * @param {{streaks?: boolean, labels?: boolean, exaggerate?: boolean, inset?: boolean}} o
   */
  set(o) {
    Object.assign(this.opts, o);
    if (this.failed) return;
    this.flow.mesh.visible = !!this.opts.streaks;
    this.labelLayer.hidden = !this.opts.labels;
    if (!this.opts.inset) this.pipFrame.hidden = true;
  }

  /** Re-read the canvas size and device-pixel ratio. */
  resize() {
    if (this.failed) return;
    const b = this.container.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return; // hidden tab: keep the last size and camera
    const w = Math.round(b.width), h = Math.round(b.height);
    const dpr = Math.min(this.opts.maxPixelRatio, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const aspectChanged = this.w && Math.abs(w / h - this.w / this.h) > 0.05;
    this.w = w; this.h = h; this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const k = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h; // sprite scale per px
    this.spritePx = k;
    for (const t of this.taps) t.sprite.scale.setScalar(TAP_PX * k);
    if (aspectChanged && this.view && !this.tween) this.setView(this.view, true);
  }

  /** Free every GPU resource and DOM node. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.failed) { this.container.replaceChildren(); return; }
    this._ro.disconnect();
    this.renderer.domElement.removeEventListener('pointermove', this._onMove);
    this.renderer.domElement.removeEventListener('pointerleave', this._onLeave);
    this.controls.removeEventListener('start', this._onStart);
    this.controls.dispose();
    this.flow.dispose();
    for (const a of Object.values(this.arrows)) a.dispose();
    const geos = new Set(), mats = new Set();
    this.scene.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    for (const t of [...this.textures, ...Object.values(this.spriteTex)]) t.dispose();
    this.envRT.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.container.replaceChildren();
    this.container.classList.remove('c3');
  }

  /* ---------------------------------------------------------------- per frame */

  /**
   * Advance animation, recolour (≤ 20 Hz) and render one frame.
   * @param {object} app
   * @param {number} dtMs  wall time since the previous frame
   */
  update(app, dtMs) {
    if (this.failed || this.disposed || document.hidden) return;
    if (!(this.w >= 2 && this.h >= 2)) { this.resize(); return; }
    if ((window.devicePixelRatio || 1) !== this.dpr && this.dpr < this.opts.maxPixelRatio) this.resize();
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
    this.time += dt;
    if (app.meta !== this.meta) { // new session / reconnect: catalogue may differ
      this.meta = app.meta;
      this._initTaps(app);
      this.resize();
      for (const t of this.taps) t.sprite.scale.setScalar(TAP_PX * this.spritePx);
    }
    this._animateCamera(dt);
    this._pose(app, dt);
    this.colorAcc += dtMs;
    if (this.colorAcc >= COLOR_PERIOD_MS) {
      this.colorAcc = 0;
      this._readTaps(app);
      this._recolor();
      this._updateTapSprites();
    }
    this._pulse();
    if (this.opts.streaks) this.flow.step(dt, this._flowContext(app));
    this._syncMirror();
    const below = this.camera.position.y < 0;
    this.ground.visible = !below;
    this.mirror.visible = !below;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._renderInset(below);
    this._updateLabels(app);
    this._hover();
  }

  /**
   * Underside inset in the bottom-right corner: a second render of the same scene through an
   * orthographic camera below the car (scissored viewport). Ground, reflection, streaks and
   * arrows are hidden for it; tap sprites are rescaled to keep their pixel size.
   */
  _renderInset(below) {
    const show = this.opts.inset && !below && this.view !== 'under' && this.w > 520;
    this.pipFrame.hidden = !show;
    if (!show) return;
    const r = this.renderer;
    const pw = Math.round(Math.min(this.w * PIP_FRACTION, PIP_MAX_PX));
    const ph = Math.round(pw / PIP_ASPECT);
    const x = this.w - pw - 12, yb = 12;
    const fs = this.pipFrame.style;
    const geom = `${pw}x${ph}`;
    if (this.pipFrame._geom !== geom) {
      this.pipFrame._geom = geom;
      fs.width = `${pw}px`; fs.height = `${ph}px`;
    }
    const hidden = [this.ground, this.mirror, this.flow.mesh, ...Object.values(this.arrows).map((a) => a.group)];
    const was = hidden.map((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    // sprites keep their pixel size: ortho px = scale · H / (top − bottom)
    const k = (this.pipCam.top - this.pipCam.bottom) / ph / (this.spritePx || 1);
    for (const t of this.taps) { t.sprite.scale.multiplyScalar(k); t.ring.scale.multiplyScalar(k); }
    r.setScissorTest(true);
    r.setScissor(x, yb, pw, ph);
    r.setViewport(x, yb, pw, ph);
    r.setClearColor(0x0b0e12, 0.94);
    r.render(this.scene, this.pipCam);
    r.setClearColor(0x000000, 0);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.w, this.h);
    for (const t of this.taps) { t.sprite.scale.multiplyScalar(1 / k); t.ring.scale.multiplyScalar(1 / k); }
    hidden.forEach((o, i) => { o.visible = was[i]; });
  }

  _distScale() {
    const aspect = this.w && this.h ? this.w / this.h : VIEW_ASPECT;
    return Math.max(1, VIEW_ASPECT / aspect) ** 0.85;
  }

  _applyCam(target, sph) {
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(sph).add(target);
    this.camera.lookAt(target);
  }

  _animateCamera(dt) {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2; // ease in-out cubic
    const target = tw.from.target.clone().lerp(tw.to.target, e);
    const sph = new THREE.Spherical(
      tw.from.sph.radius + (tw.to.sph.radius - tw.from.sph.radius) * e,
      tw.from.sph.phi + (tw.to.sph.phi - tw.from.sph.phi) * e,
      tw.from.sph.theta + (tw.to.sph.theta - tw.from.sph.theta) * e,
    );
    this._applyCam(target, sph);
    if (tw.t >= 1) this.tween = null;
  }

  /**
   * Sprung-body pose from the ride heights, wheel spin and steer, suspension links.
   *
   * Heave/pitch: the change of ride height from static, Δf at the front axle (x = 0) and Δr at
   * the rear axle (x = −L), is applied as a rigid motion of the sprung mass: dz(x) = Δf +
   * x·(Δf − Δr)/L, i.e. translation Δf and a rotation about the front axle with
   * sin φ = (Δf − Δr)/L. When exaggerated (×5) the motion is limited so nothing sinks below
   * the ground.
   */
  _pose(app, dt) {
    const d = this.dims, sm = this.smooth;
    const k = this.opts.exaggerate ? RIDE_EXAGGERATION : 1;
    const rf = app.val('rh_front'), rr = app.val('rh_rear');
    let dzf = isNum(rf) ? (k * (rf - d.rhStatic.f)) / 1000 : 0;
    let dzr = isNum(rr) ? (k * (rr - d.rhStatic.r)) / 1000 : 0;
    // keep the lowest sprung points (endplate feet, floor lip, floor edge) above the ground
    const dzAt = (x) => dzf + (x * (dzf - dzr)) / d.L;
    if (!this._groundChecks) {
      const fwFoot = this.wings.fw.els[0].bounds();
      this._groundChecks = [[d.fw.le_x_m + 0.03, Math.max(0.03, fwFoot.z0 - 0.035)], [d.ut.x0, d.ut.z], [d.ut.x0 + 0.4 * (d.ut.x1 - d.ut.x0), d.ut.z - 0.012]];
    }
    const checks = this._groundChecks;
    let lift = 0;
    for (const [x, z] of checks) lift = Math.max(lift, 0.004 - (z + dzAt(x)));
    dzf += lift; dzr += lift;
    const a = 1 - Math.exp(-dt / 0.12); // low-pass (sensor noise × 5 would jitter)
    if (!sm.init) { sm.dzf = dzf; sm.dzr = dzr; sm.init = true; }
    sm.dzf += (dzf - sm.dzf) * a;
    sm.dzr += (dzr - sm.dzr) * a;
    this.body.position.set(0, sm.dzf, 0);
    this.body.rotation.set(0, 0, Math.asin(Math.max(-0.2, Math.min(0.2, (sm.dzf - sm.dzr) / d.L))));
    this.body.updateMatrix();
    this.body.updateMatrixWorld(true);
    this.overlay.position.copy(this.body.position);
    this.overlay.rotation.copy(this.body.rotation);
    this.dzAt = (x) => sm.dzf + (x * (sm.dzf - sm.dzr)) / d.L;

    // steer: road-wheel angle = steering-wheel angle / ratio (+ = left)
    const steer = app.val('steer');
    const delta = isNum(steer) ? ((steer / d.steerRatio) * Math.PI) / 180 : 0;
    sm.steer += (delta - sm.steer) * (1 - Math.exp(-dt / 0.08));
    const ws = ['ws_fl', 'ws_fr', 'ws_rl', 'ws_rr'];
    this.corners.forEach((c, i) => {
      if (c.front) c.steer.rotation.y = sm.steer;
      const v = app.val(ws[i]);
      // rolling forward: the top of the tyre moves +x → negative rotation about three Z
      if (isNum(v)) this.spin[i] -= (v / d.r) * dt * SLOW_MOTION;
      c.spin.rotation.z = this.spin[i];
    });
    // links: inboard end on the sprung body, outboard end on the (steered) upright
    const va = this._va, vb = this._vb;
    for (const l of this.links) {
      va.copy(carV(l.inb.x, l.inb.y, l.inb.z)).applyMatrix4(this.body.matrix);
      let ox = l.out.x, oy = l.out.y;
      if (l.corner.front && sm.steer) {
        const hx = l.corner.xa, hy = (l.corner.side * l.corner.track) / 2;
        const c = Math.cos(sm.steer), s = Math.sin(sm.steer);
        const dx = ox - hx, dy = oy - hy;
        ox = hx + dx * c - dy * s;
        oy = hy + dx * s + dy * c;
      }
      vb.copy(carV(ox, oy, l.out.z));
      l.link.set(va, vb);
    }
  }

  /** Read every tap's Cp, status, owner and anomaly flag. */
  _readTaps(app) {
    const q = app.val('calc_q');
    this.lowQ = !(q >= Q_MIN_CP);
    this.suspects = new Set();
    const anomaly = app.alerts.get('sensor_tap_anomaly');
    if (anomaly && anomaly.active !== false) {
      for (const ch of anomaly.channels || []) this.suspects.add(ch.replace(/^calc_cp_/, ''));
    }
    let held = 0;
    for (const t of this.taps) {
      const raw = app.status(t.id);
      const cp = app.val(t.cpId);
      t.owner = app.owner.get(t.id) || '';
      t.suspect = this.suspects.has(t.id);
      t.raw = app.val(t.id);
      if (raw !== 'live') { t.cp = NaN; t.state = raw; }
      else if (isNum(cp)) { t.cp = cp; t.held = cp; t.state = 'live'; }
      else if (this.lowQ && isNum(t.held)) { t.cp = t.held; t.state = 'held'; held++; }
      else { t.cp = NaN; t.state = this.lowQ ? 'lowq' : 'nocp'; }
    }
    this.heldCount = held;
  }

  /** Station profiles from the current tap values (suspect taps left out). */
  _profiles() {
    const P = { fw: {}, rw: {} };
    for (const el of ['fw', 'rw']) {
      for (const st of ['L', 'R']) {
        const sel = (surf) => this.taps.filter((t) => t.element === el && t.station === st && t.surface === surf && !t.suspect).map((t) => [t.xc, t.cp]);
        P[el][st] = stationProfiles(sel('suction'), sel('pressure'));
      }
    }
    const ut = this.taps.filter((t) => t.element === 'ut' && !t.suspect);
    const centre = ut.filter((t) => t.station === 'C' && isNum(t.cp)).map((t) => [t.xc, t.cp]).sort((a, b) => a[0] - b[0]);
    const cProf = centre.length ? centre : null;
    const tun = (st) => {
      const t = ut.find((x) => x.station === st);
      return t && isNum(t.cp) && cProf ? t.cp - interpProfile(cProf, t.xc) : NaN;
    };
    const tL = ut.find((x) => x.station === 'L');
    P.ut = { centre: cProf, tunnels: { dL: tun('L'), dR: tun('R'), yTunnel: tL ? Math.abs(tL.y) || 0.3 : 0.3 } };
    return P;
  }

  /** Recolour the instrumented surfaces from the live Cp (vertex colours). */
  _recolor() {
    const P = this._profiles();
    this.profiles = P;
    for (const mesh of this.dataMeshes) {
      const geo = mesh.geometry;
      const col = geo.attributes.color.array;
      if (geo.userData.cp) {
        const { u, surf, wL, element } = geo.userData.cp;
        const L = P[element].L, R = P[element].R;
        const profL = [L.suction, L.pressure], profR = [R.suction, R.pressure];
        for (let v = 0; v < u.length; v++) {
          const s = surf[v];
          const cp = blendStations(interpProfile(profL[s], u[v]), interpProfile(profR[s], u[v]), wL[v]);
          cpColorInto(col, v * 3, cp);
        }
      } else if (geo.userData.floor) {
        const { f, y } = geo.userData.floor;
        for (let v = 0; v < f.length; v++) cpColorInto(col, v * 3, floorCp(P.ut.centre, f[v], y[v], P.ut.tunnels));
      }
      geo.attributes.color.needsUpdate = true;
    }
  }

  _updateTapSprites() {
    const c = new THREE.Color();
    const tmp = [0, 0, 0];
    for (const t of this.taps) {
      const m = t.sprite.material;
      const missing = !isNum(t.cp);
      m.map = missing ? this.spriteTex.hollow : this.spriteTex.dot;
      cpColorInto(tmp, 0, t.cp);
      m.color.setRGB(tmp[0], tmp[1], tmp[2]); // already linear
      m.opacity = t.state === 'held' ? 0.6 : 1;
      if (missing) m.color.setRGB(0.55, 0.58, 0.62);
      const real = t.owner === 'serial' || t.owner === 'can';
      t.ring.visible = real || t.suspect;
      if (t.ring.visible) {
        c.set(t.suspect ? 0xfab219 : t.owner === 'can' ? 0x2fd29a : 0xa99cff);
        t.ring.material.color.copy(c);
      }
    }
  }

  /** Pulsing rings: radar-ping scale/opacity cycle. */
  _pulse() {
    const k = this.spritePx || 0.001;
    const ph = (this.time * 0.9) % 1;
    for (const t of this.taps) {
      if (!t.ring.visible) continue;
      t.ring.scale.setScalar(TAP_PX * k * (1.6 + 2.2 * ph));
      t.ring.material.opacity = 0.95 * (1 - ph) ** 1.3 + 0.05;
    }
  }

  /** Flow context for the streaks (car frame, m/s). */
  _flowContext(app) {
    let V = app.val('calc_airspeed');
    if (!isNum(V)) V = app.val('gps_speed');
    if (!isNum(V)) V = 0;
    let yaw = app.val('calc_yaw');
    if (!isNum(yaw)) yaw = app.val('probe_yaw');
    const psi = isNum(yaw) ? (Math.max(-25, Math.min(25, yaw)) * Math.PI) / 180 : 0;
    const d = this.dims, fw = this.wings.fw, rw = this.wings.rw;
    const cl = (id, fallback) => { const v = app.val(id); return isNum(v) ? v : fallback; };
    // bound vortex of each wing at ¼ of the element stack's overall chord
    const vortexOf = (w, idL, idR) => {
      const b0 = w.els[0].bounds(), b1 = w.els[w.els.length - 1].bounds();
      const xLE = b0.x1, xTE = Math.min(b0.x0, b1.x0);
      const c = xLE - xTE;
      const g = (clv) => -0.5 * V * c * Math.max(0, clv) * 1.15; // flaps add to the main-plane Cl
      return { x: xLE - 0.3 * c, z: (b0.z0 + b1.z1) / 2 + this.dzAt(xLE - 0.3 * c), halfSpan: w.half, gL: g(cl(idL, 1.5)), gR: g(cl(idR, 1.5)) };
    };
    const m = V * Math.PI * 0.34 * 0.34;
    if (!this._flowStatic) {
      this._flowStatic = {
        fwHalfSpan: fw.half, rwHalfSpan: rw.half,
        fwTop: fw.els[fw.els.length - 1].bounds().z1, rwTop: rw.els[rw.els.length - 1].bounds().z1, rwBottom: rw.els[0].bounds().z0,
        floorX0: d.ut.x0, floorX1: d.ut.x1, floorHalfW: d.ut.w / 2,
        floorZ: (f) => this.floorZ(f),
      };
    }
    const P = this.profiles || this._profiles();
    const dzAt = this.dzAt || (() => 0);
    return {
      ...this._flowStatic,
      V, psi, Ux: -V * Math.cos(psi), Uy: -V * Math.sin(psi),
      sources: [{ x: d.fw.le_x_m - 0.1, y: 0, z: 0.3, m }, { x: -d.L - 0.05, y: 0, z: 0.42, m: -m }],
      vortices: V > 0.5 ? [vortexOf(fw, 'calc_cl_fw_l', 'calc_cl_fw_r'), vortexOf(rw, 'calc_cl_rw_l', 'calc_cl_rw_r')] : [],
      dzAt,
      floorCpAt: (f, y) => floorCp(P.ut.centre, f, y, P.ut.tunnels),
      inside: (x, y, z) => this._inside(x, y, z),
    };
  }

  /** Coarse solid test of the car (car frame) used to retire streaks that hit it. */
  _inside(x, y, z) {
    const d = this.dims;
    const ay = Math.abs(y);
    if (x < this.tubRows[0].x && x > this.tubRows[this.tubRows.length - 1].x && ay < loftHalfWidthAt(this.tubRows, x) + 0.01 && z < loftTopAt(this.tubRows, x) + 0.01) return true; // tub + nose
    if (x < -0.84 && x > -1.82 && ay < 0.25 && z < 0.53) return true; // accumulator, rear frame, motor
    if (x < -0.28 && x > -1.27 && ay < 0.48 && z < 0.43) return true; // sidepods
    if (x < -0.42 && x > -0.82 && ay < 0.2 && z < 0.95) return true; // driver
    for (const [xa, t] of [[0, d.tf], [-d.L, d.tr]]) {
      if (Math.abs(ay - t / 2) < 0.11 && (x - xa) ** 2 + (z - d.r) ** 2 < d.r * d.r) return true;
    }
    for (const w of Object.values(this.wings)) {
      if (ay > w.half + 0.01) continue;
      for (const el of w.els) {
        // distance to the chord line, in chord units
        const dx = x - el.xle, dz = z - (el.zle + this.dzAt(x));
        const u = (-dx * Math.cos(el.a) + dz * Math.sin(el.a)) / el.c;
        const wv = (dx * Math.sin(el.a) + dz * Math.cos(el.a)) / el.c;
        if (u > -0.02 && u < 1.02 && wv > -0.13 && wv < 0.05) return true;
      }
    }
    if (x < d.ut.x0 && x > d.ut.x1 && ay < d.ut.w / 2) {
      const f = (d.ut.x0 - x) / (d.ut.x0 - d.ut.x1);
      const zf = this.floorZ(f) + this.dzAt(x);
      if (z > zf - 0.004 && z < zf + 0.05) return true;
    }
    return false;
  }

  _syncMirror() {
    for (const [a, b] of this.mirrorPairs) {
      b.position.copy(a.position);
      b.quaternion.copy(a.quaternion);
      b.scale.copy(a.scale);
      b.visible = a.visible;
    }
  }

  /* ---------------------------------------------------------------- labels / tooltip */

  _label(key, cls) {
    let el = this.labels.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `c3-label ${cls || ''}`;
      this.labelLayer.append(el);
      this.labels.set(key, el);
    }
    return el;
  }

  /** Project a three.js world point to canvas pixels (null when behind the camera). */
  _project(v) {
    const p = this._pp || (this._pp = new THREE.Vector3());
    p.copy(v).project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h };
  }

  /** Position label `key` at a world point (hidden when off screen or `show` is false). */
  _place(key, cls, worldPos, html, show = true) {
    const el = this._label(key, cls);
    const p = show ? this._project(worldPos) : null;
    if (!p || p.x < -40 || p.y < -20 || p.x > this.w + 40 || p.y > this.h + 20) { el.hidden = true; return; }
    el.hidden = false;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  }

  _updateLabels(app) {
    const d = this.dims, M = this.body.matrixWorld;
    const W = (x, y, z) => carV(x, y, z).applyMatrix4(M);
    const N = (v) => `${formatNumber(v, 0)} N`;
    const show = this.opts.labels;
    // forces
    const dfF = app.val('calc_downforce_f'), dfR = app.val('calc_downforce_r'), drag = app.val('calc_drag');
    const len = (n) => Math.min(1.1, Math.max(0, n) * ARROW_M_PER_N);
    const a = this.arrows;
    const frontTip = carV(0.02, 0, loftTopAt(this.tubRows, 0.02) + 0.03);
    const rearTip = carV(-d.L, 0, 0.62);
    a.front.group.visible = isNum(dfF) && dfF > 20;
    a.rear.group.visible = isNum(dfR) && dfR > 20;
    a.drag.group.visible = isNum(drag) && drag > 10;
    if (a.front.group.visible) a.front.set(frontTip, DOWN, len(dfF));
    if (a.rear.group.visible) a.rear.set(rearTip, DOWN, len(dfR));
    const dragTip = carV(-2.62 - len(drag), 0, 0.62);
    if (a.drag.group.visible) a.drag.set(dragTip, new THREE.Vector3(-1, 0, 0), len(drag));
    this.labelLayer.hidden = !show;
    if (!show) return;
    this._place('dff', 'force left', W(0.02, 0, loftTopAt(this.tubRows, 0.02) + 0.03 + 0.6 * len(dfF)), `<b>${N(dfF)}</b> front`, a.front.group.visible);
    this._place('dfr', 'force right', W(-d.L, 0, 0.62 + 0.6 * len(dfR)), `<b>${N(dfR)}</b> rear`, a.rear.group.visible);
    this._place('drag', 'force drag right', W(-2.62 - len(drag), 0, 0.62), `<b>${N(drag)}</b> drag`, a.drag.group.visible);
    // station labels with the live section Cl
    const cl = (id) => formatNumber(app.val(id), 2);
    const fw = this.wings.fw, rw = this.wings.rw;
    const fwTop = fw.els[fw.els.length - 1].bounds().z1 + 0.06;
    const rwTop = rw.els[rw.els.length - 1].bounds().z1 + 0.07;
    // anchored above the wing tips (outboard of the stations) so left and right never overlap
    const fx = fw.els[0].xle - 0.15, rx = rw.els[0].xle - 0.3;
    const st = this.stationStatus || {};
    const station = (key, name, id, pos) => {
      // the change vs baseline is only meaningful next to a live Cl (it is refreshed at 10 Hz)
      const s = isNum(app.val(id)) && st[key] ? st[key] : { text: '', level: '' };
      const el = this._label(key, 'station');
      if ((el.dataset.level || '') !== s.level) { if (s.level) el.dataset.level = s.level; else delete el.dataset.level; }
      this._place(key, 'station', pos, `${name} <b>Cl ${cl(id)}</b>${s.text ? ` <span class="c3-delta">${s.text}</span>` : ''}`);
    };
    station('fw-L', 'FW·L', 'calc_cl_fw_l', W(fx, fw.half, fwTop));
    station('fw-R', 'FW·R', 'calc_cl_fw_r', W(fx, -fw.half, fwTop));
    station('rw-L', 'RW·L', 'calc_cl_rw_l', W(rx, rw.half, rwTop));
    station('rw-R', 'RW·R', 'calc_cl_rw_r', W(rx, -rw.half, rwTop));
    const under = this.camera.position.y < 0;
    this._place('ut', 'station', W(d.ut.x0 + 0.55 * (d.ut.x1 - d.ut.x0), 0, under ? -0.02 : 0.02), `Floor <b>C̄p ${formatNumber(app.val('calc_cp_ut_mean'), 2)}</b>`, under);
    // taps on real hardware / suspect taps
    for (const t of this.taps) {
      const tag = t.suspect ? 'suspect' : t.owner === 'serial' || t.owner === 'can' ? t.owner : '';
      t.world.copy(t.pos).applyMatrix4(this.overlay.matrixWorld);
      const txt = t.suspect ? 'suspect tap' : t.owner === 'serial' ? 'USB-serial sensor' : 'CAN sensor';
      this._place(`tap-${t.id}`, `tapflag ${t.suspect ? 'suspect' : 'real'}`, t.world, `<span class="mono">${t.id}</span> ${txt}`, !!tag);
    }
    // status chips
    const chips = [];
    if (this.opts.exaggerate) chips.push('<span class="chip">ride height ×5</span>');
    if (this.opts.streaks) chips.push(`<span class="chip">flow streaks · ${Math.round(1 / SLOW_MOTION)}× slow motion</span>`);
    if (this.lowQ && this.heldCount) chips.push(`<span class="chip c3-warnchip">q &lt; ${Q_MIN_CP} Pa · last valid map</span>`);
    const html = chips.join('');
    if (this.chips._html !== html) { this.chips.innerHTML = html; this.chips._html = html; }
  }

  /** Tooltip for the tap nearest to the pointer (taps facing the camera, or ringed ones). */
  _hover() {
    if (!this.pointer) { this.tip.hidden = true; this.hoverTap = null; return; }
    const cam = this.camera.position;
    let best = null, bd = 16 * 16;
    const n = new THREE.Vector3(), toCam = new THREE.Vector3();
    for (const t of this.taps) {
      t.world.copy(t.pos).applyMatrix4(this.overlay.matrixWorld);
      n.copy(t.normal).transformDirection(this.overlay.matrixWorld);
      const facing = n.dot(toCam.subVectors(cam, t.world)) > 0;
      if (!facing && !t.ring.visible) continue;
      const p = this._project(t.world);
      if (!p) continue;
      const dd = (p.x - this.pointer.x) ** 2 + (p.y - this.pointer.y) ** 2;
      if (dd < bd) { bd = dd; best = { t, p }; }
    }
    this.hoverTap = best ? best.t.id : null;
    if (!best) { this.tip.hidden = true; return; }
    const t = best.t;
    const stateText = {
      live: 'live', held: `holding last valid Cp (q < ${Q_MIN_CP} Pa)`, lowq: `q < ${Q_MIN_CP} Pa: Cp undefined`,
      nocp: 'no Cp', stale: 'stale', missing: 'missing',
    }[t.state] || t.state;
    const sdot = t.state === 'live' || t.state === 'held' || t.state === 'lowq' ? 'live' : t.state === 'stale' ? 'stale' : 'missing';
    const own = t.owner === 'serial' ? '<span class="chip own-serial">USB-serial</span>' : t.owner === 'can' ? '<span class="chip own-can">CAN</span>' : `<span class="chip">${escapeHtml(t.owner || 'sim')}</span>`;
    const html = `
      <div class="c3-tip-head"><span class="mono">${escapeHtml(t.id)}</span>${own}</div>
      <div class="c3-tip-name">${escapeHtml(t.def.name)}</div>
      <div class="c3-tip-vals"><span><b>${formatNumber(t.cp, 2)}</b> Cp</span><span><b>${formatNumber(t.raw, 1)}</b> Pa</span></div>
      <div class="c3-tip-state"><span class="sdot" data-s="${sdot}"></span>${escapeHtml(stateText)}</div>
      ${t.suspect ? '<div class="c3-tip-warn">Suspected sensor fault: left out of the pressure map</div>' : ''}`;
    if (this.tip._html !== html) { this.tip.innerHTML = html; this.tip._html = html; }
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = best.p.x + 14, y = best.p.y - th / 2;
    if (x + tw > this.w - 6) x = best.p.x - 14 - tw;
    y = Math.max(6, Math.min(this.h - th - 6, y));
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

