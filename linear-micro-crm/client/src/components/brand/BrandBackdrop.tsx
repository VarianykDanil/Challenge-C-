// Owned by the Product Designer.
// Living backdrop for ink panels (login brand panel, landing hero, CTA band) and, more quietly, light surfaces.
// Two layers, both built from the brand tokens so a rebrand recolours them:
//   1. Aurora — four large soft blobs in the primary / accent / ink hues that drift and breathe on 24–40 s
//      CSS loops (transform + opacity only, compositor-driven, see `aurora-*` in index.css).
//   2. The Linear motif, exploded — dozens of parallel light streaks (the mark's three lines, leaning −14°)
//      gliding across the panel at three depths with soft heads and fading tails, on a <canvas> driven by
//      requestAnimationFrame. Streaks are pre-rendered sprites per depth and hue, so a frame is one clear and
//      ~50 drawImage calls (well under 1 ms). DPR-aware (capped at 2), capped at 60 fps, paused while the tab
//      is hidden or the panel is off-screen, resized with ResizeObserver, cleaned up on unmount.
// A faint dot grid drifts slowly behind the streaks for parallax, and a soft radial vignette behind the
// headline area keeps text contrast. With `animated={false}` or `prefers-reduced-motion: reduce` everything
// renders once and stays still. Always decorative, always aria-hidden.
import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import clsx from 'clsx';

export type BackdropIntensity = 'strong' | 'soft';
export type BackdropVariant = 'ink' | 'surface';

export interface BrandBackdropProps {
  className?: string;
  /** `strong` for a hero or brand panel, `soft` where there is a lot of text on top (CTA bands). */
  intensity?: BackdropIntensity;
  /** `ink` on the always-dark navy panels (luminous violet/ember), `surface` on light sections (subtle). */
  variant?: BackdropVariant;
  /** Set false for a still version; `prefers-reduced-motion: reduce` forces still regardless. */
  animated?: boolean;
  /** Where the headline sits, so the vignette keeps contrast there. */
  vignette?: 'left' | 'center' | 'none';
}

/* ───────────────────────────── reduced motion ───────────────────────────── */

const RM_QUERY = '(prefers-reduced-motion: reduce)';
const hasMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';
function subscribeReducedMotion(cb: () => void) {
  if (!hasMedia()) return () => {};
  const mq = window.matchMedia(RM_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
/** True when the OS asks for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => (hasMedia() ? window.matchMedia(RM_QUERY).matches : false), () => false);
}

/* ───────────────────────────── aurora (CSS) ───────────────────────────── */

interface Blob { cls: string; style: CSSProperties }
const BLOBS: Blob[] = [
  { cls: 'aurora-1', style: { left: '-14%', top: '-22%', width: '64%', ['--blob-color' as string]: 'var(--primary)' } },
  { cls: 'aurora-2', style: { right: '-20%', top: '4%', width: '58%', ['--blob-color' as string]: 'var(--accent)' } },
  { cls: 'aurora-3', style: { left: '14%', bottom: '-34%', width: '70%', ['--blob-color' as string]: 'var(--primary-hover)' } },
  { cls: 'aurora-4', style: { right: '2%', bottom: '-16%', width: '46%', ['--blob-color' as string]: 'color-mix(in oklab, var(--primary) 45%, var(--ink))' } },
];

const AURORA_OPACITY: Record<BackdropVariant, Record<BackdropIntensity, number>> = {
  ink: { strong: 0.6, soft: 0.4 },
  surface: { strong: 0.26, soft: 0.16 },
};

/* ───────────────────────────── streak field (canvas) ───────────────────────────── */

type RGB = [number, number, number];
interface Depth { w: number; len: [number, number]; speed: [number, number]; alpha: number; share: number }
interface Streak { x: number; y: number; len: number; speed: number; depth: number; hue: number; alpha: number; freq: number; phase: number }
interface Stats { frames: number; totalMs: number; maxMs: number }

/** Far → near: thinner, dimmer and slower at the back; brighter, longer and faster at the front. */
const DEPTHS: Depth[] = [
  { w: 1.25, len: [90, 210], speed: [9, 16], alpha: 0.32, share: 0.45 },
  { w: 2, len: [150, 340], speed: [22, 40], alpha: 0.58, share: 0.35 },
  { w: 3.25, len: [230, 520], speed: [55, 95], alpha: 0.92, share: 0.2 },
];
const ANGLE = (-14 * Math.PI) / 180; // the mark's lean
const SPRITE_LEN = 320; // logical px; stretched per streak
const GLOW = 8; // sprite height = w × GLOW
const MAX_DPR = 2;
const MIN_FRAME_MS = 15; // ≈ 60 fps cap on 120 Hz displays

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseColor(input: string): RGB | null {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split('').map((c) => c + c).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}
const lighten = ([r, g, b]: RGB, k: number): RGB => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

/** Violet + ember from the live tokens; lifted towards white on ink so they read as light, not paint. */
function readPalette(el: Element, variant: BackdropVariant): [RGB, RGB] {
  const cs = getComputedStyle(el);
  const primary = parseColor(cs.getPropertyValue('--primary')) ?? [157, 153, 255];
  const accent = parseColor(cs.getPropertyValue('--accent')) ?? [255, 160, 89];
  return variant === 'ink' ? [lighten(primary, 0.3), lighten(accent, 0.35)] : [primary, accent];
}

/** A horizontal streak with a fading tail (left) and a soft glowing head (right), rendered once per depth/hue. */
function makeSprite(color: RGB, w: number, dpr: number): HTMLCanvasElement {
  const h = w * GLOW;
  const c = document.createElement('canvas');
  c.width = Math.ceil(SPRITE_LEN * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d');
  if (!g) return c;
  g.scale(dpr, dpr);
  const [r, gg, b] = color.map(Math.round) as RGB;
  const rgba = (a: number) => `rgba(${r},${gg},${b},${a})`;
  const headR = w * 3.5;
  const headX = SPRITE_LEN - headR - 1;
  const cy = h / 2;
  const tail = g.createLinearGradient(0, 0, headX, 0);
  tail.addColorStop(0, rgba(0));
  tail.addColorStop(0.55, rgba(0.35));
  tail.addColorStop(1, rgba(1));
  g.strokeStyle = tail;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(w, cy);
  g.lineTo(headX, cy);
  g.stroke();
  const glow = g.createRadialGradient(headX, cy, 0, headX, cy, headR);
  glow.addColorStop(0, rgba(0.95));
  glow.addColorStop(0.35, rgba(0.45));
  glow.addColorStop(1, rgba(0));
  g.fillStyle = glow;
  g.beginPath();
  g.arc(headX, cy, headR, 0, Math.PI * 2);
  g.fill();
  return c;
}

interface StreakFieldProps { intensity: BackdropIntensity; variant: BackdropVariant; live: boolean }

function StreakField({ intensity, variant, live }: StreakFieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const alphaScale = (intensity === 'strong' ? 1 : 0.6) * (variant === 'surface' ? 0.45 : 1);
    const stats: Stats = { frames: 0, totalMs: 0, maxMs: 0 };
    // Exposed for perf probes (a JS property, not an attribute, so it costs nothing per frame).
    (canvas as HTMLCanvasElement & { __stats?: Stats }).__stats = stats;

    let W = 0, H = 0, dpr = 1, RX = 0, RY = 0;
    let streaks: Streak[] = [];
    let sprites: HTMLCanvasElement[][] = [];
    let raf = 0, last = 0, ready = false, running = false;
    let visible = typeof document !== 'undefined' ? !document.hidden : true;
    let inView = true;

    const buildSprites = () => {
      const [violet, ember] = readPalette(host, variant);
      sprites = DEPTHS.map((d) => [makeSprite(violet, d.w, dpr), makeSprite(ember, d.w, dpr)]);
    };
    const spawn = (depth: number, anywhere: boolean): Streak => {
      const d = DEPTHS[depth]!;
      const len = rand(d.len[0], d.len[1]);
      return {
        x: anywhere ? rand(-RX - len, RX + len) : -RX - len - rand(0, 240),
        y: rand(-RY, RY),
        len,
        speed: rand(d.speed[0], d.speed[1]),
        depth,
        hue: Math.random() < 0.72 ? 0 : 1,
        alpha: d.alpha * rand(0.75, 1),
        freq: rand(0.4, 1.1),
        phase: rand(0, Math.PI * 2),
      };
    };
    const populate = () => {
      const total = Math.round(clamp((W * H) / 15000, 16, 56) * (intensity === 'strong' ? 1 : 0.6));
      streaks = [];
      DEPTHS.forEach((d, i) => {
        const n = Math.max(2, Math.round(total * d.share));
        for (let k = 0; k < n; k++) streaks.push(spawn(i, true));
      });
    };
    const drawFrame = (dt: number, t: number) => {
      const t0 = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(ANGLE);
      ctx.globalCompositeOperation = variant === 'ink' ? 'lighter' : 'source-over';
      for (const s of streaks) {
        if (dt > 0) {
          s.x += s.speed * dt;
          if (s.x - s.len > RX + 24) {
            // off the right edge: come back in from the left on a new line
            s.x = -RX - s.len - rand(0, 240);
            s.y = rand(-RY, RY);
          }
        }
        const breathe = 0.82 + 0.18 * Math.sin(t * 0.001 * s.freq + s.phase);
        ctx.globalAlpha = s.alpha * alphaScale * breathe;
        const h = DEPTHS[s.depth]!.w * GLOW;
        ctx.drawImage(sprites[s.depth]![s.hue]!, s.x - s.len, s.y - h / 2, s.len, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      const ms = performance.now() - t0;
      stats.frames += 1;
      stats.totalMs += ms;
      if (ms > stats.maxMs) stats.maxMs = ms;
    };
    const shouldRun = () => live && visible && inView && ready;
    const loop = (now: number) => {
      raf = 0;
      if (!shouldRun()) { running = false; return; }
      const elapsed = now - last;
      if (elapsed < MIN_FRAME_MS) { raf = requestAnimationFrame(loop); return; }
      last = now;
      drawFrame(Math.min(elapsed, 50) / 1000, now);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || !shouldRun()) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      running = false;
    };
    const resize = () => {
      const rect = host.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      // Streaks live in a frame rotated by ANGLE; these half-extents cover the rotated viewport.
      const sin = Math.abs(Math.sin(ANGLE));
      RX = W / 2 + (H / 2) * sin;
      RY = H / 2 + (W / 2) * sin;
      buildSprites();
      populate();
      if (!live) drawFrame(0, performance.now());
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (!ready) { ready = true; start(); }
    });
    ro.observe(host);
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting);
        if (inView) start(); else stop();
      },
      { threshold: 0 },
    );
    io.observe(host);
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) start(); else stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Theme switch (`.dark` on <html>) changes the tokens the sprites were built from.
    const mo = new MutationObserver(() => {
      if (!ready) return;
      buildSprites();
      if (!live) drawFrame(0, performance.now());
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      delete (canvas as HTMLCanvasElement & { __stats?: Stats }).__stats;
    };
  }, [intensity, variant, live]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

/* ───────────────────────────── the backdrop ───────────────────────────── */

const VIGNETTE: Record<BackdropVariant, Record<'left' | 'center', string>> = {
  ink: {
    left: 'radial-gradient(60% 78% at 22% 50%, color-mix(in srgb, var(--ink) 80%, transparent) 0%, transparent 72%)',
    center: 'radial-gradient(70% 70% at 50% 50%, color-mix(in srgb, var(--ink) 80%, transparent) 0%, transparent 72%)',
  },
  surface: {
    left: 'radial-gradient(60% 78% at 22% 50%, color-mix(in srgb, var(--surface) 85%, transparent) 0%, transparent 72%)',
    center: 'radial-gradient(70% 70% at 50% 50%, color-mix(in srgb, var(--surface) 85%, transparent) 0%, transparent 72%)',
  },
};

export function BrandBackdrop({ className, intensity = 'strong', variant = 'ink', animated = true, vignette = 'left' }: BrandBackdropProps) {
  const reduced = useReducedMotion();
  const live = animated && !reduced;
  const dotColor = variant === 'ink' ? 'color-mix(in srgb, var(--ink-fg) 13%, transparent)' : 'color-mix(in srgb, var(--fg) 9%, transparent)';

  return (
    <div className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden data-backdrop={variant} data-live={live || undefined}>
      {/* base wash — also the whole of the still version's colour */}
      <div className={clsx('brand-wash absolute inset-0', variant === 'ink' ? 'opacity-80' : 'opacity-50')} />

      {/* 1. aurora */}
      <div className="absolute inset-0" style={{ opacity: AURORA_OPACITY[variant][intensity] }}>
        {BLOBS.map((b) => (
          <span key={b.cls} className={clsx('aurora-blob', live && b.cls)} style={b.style} />
        ))}
      </div>

      {/* dot grid with slow parallax drift */}
      <div
        className={clsx('dot-grid absolute -inset-6 [mask-image:radial-gradient(72%_76%_at_50%_50%,black_30%,transparent)]', live && 'dot-drift')}
        style={{ ['--dot-color' as string]: dotColor }}
      />

      {/* 2. the exploded mark */}
      <StreakField intensity={intensity} variant={variant} live={live} />

      {/* contrast: vignette behind the headline + a solid-ish bottom edge for footers */}
      {vignette !== 'none' && <div className="absolute inset-0" style={{ background: VIGNETTE[variant][vignette] }} />}
      {variant === 'ink' && <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-ink/80 to-transparent" />}
    </div>
  );
}
