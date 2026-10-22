/**
 * Release 1.3 — OWNED BY P5 learning-videos (laid down by r3-foundation). Pure rules for learning videos:
 *
 *  - links: which YouTube, Vimeo and Google Drive addresses are accepted, the embed URL each plays from
 *    (videoEmbedUrl), YouTube's thumbnail, and the player messages the page listens to (parseEmbedMessage);
 *  - audiences: who sees a video (videoVisibleTo) and whom a required one is required for (videoRequiredFor);
 *  - watching: the parts of a video someone has seen, as merged [from, to] ranges, so a replayed minute counts once
 *    and skipping ahead counts nothing (recordWatchSample, mergeWatchedRanges, watchedRangesSeconds); a video counts
 *    as watched once 90 % of its length has been seen (isVideoComplete);
 *  - lengths as words ("9:58", "10 min") and from words ("9:58" → 598).
 */
import type { Role } from '../types.ts';
import {
  VIDEO_COMPLETE_SHARE,
  VIDEO_LIMITS,
  type VideoAudience,
  type VideoProvider,
  type VideoTopic,
  type WatchedRange,
} from '../types/videos.ts';

export const VIDEO_TOPIC_LABELS: Record<VideoTopic, string> = {
  interviews: 'Interviews',
  pitching: 'Pitching',
  objections: 'Objections',
  leadership: 'Leadership',
  other: 'Other',
};

export const VIDEO_PROVIDER_LABELS: Record<VideoProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  drive: 'Google Drive',
};

export const VIDEO_AUDIENCE_LABELS: Record<VideoAudience, string> = {
  everyone: 'Everyone',
  leaders: 'Leaders',
  reps: 'Reps',
};

/** What each audience means, for the forms. */
export const VIDEO_AUDIENCE_HINTS: Record<VideoAudience, string> = {
  everyone: 'Every member of staff.',
  leaders: 'Team leaders (and administrators).',
  reps: 'Reps, and the leaders who coach them (and administrators).',
};

// ───────────────────────────── links ─────────────────────────────

export interface VideoLink {
  provider: VideoProvider;
  /** The provider's id of the video. */
  id: string;
  /** Vimeo: the privacy hash of an unlisted video ("vimeo.com/123/abc123"). */
  hash?: string;
  /** Google Drive: the resource key older shared files need. */
  resourceKey?: string;
  /** Where the link asked to start (YouTube `t=` / `start=`, Vimeo `#t=`), in seconds. */
  startS?: number;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const VIMEO_ID = /^\d{5,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/i;
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const DRIVE_ID = /^[A-Za-z0-9_-]{20,100}$/;
const DRIVE_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** "90", "90s", "1m30s", "1h2m3s" → seconds; anything else null. */
export function parseTimeParam(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^\d{1,6}$/.test(v)) return Number(v);
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function toUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text || text.length > VIDEO_LIMITS.urlMax || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

const positiveStart = (s: number | null): number | undefined => (s !== null && s > 0 ? s : undefined);

function youtubeLink(url: URL): VideoLink | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host === 'youtu.be') id = parts[0];
  else if (YOUTUBE_HOSTS.has(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v') ?? undefined;
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1];
  } else return null;
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const startS = positiveStart(parseTimeParam(url.searchParams.get('t') ?? url.searchParams.get('start')));
  return startS ? { provider: 'youtube', id, startS } : { provider: 'youtube', id };
}

function vimeoLink(url: URL): VideoLink | null {
  const host = url.hostname.toLowerCase();
  if (!VIMEO_HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let hash: string | undefined;
  if (host === 'player.vimeo.com') {
    if (parts[0] !== 'video') return null;
    id = parts[1];
    hash = url.searchParams.get('h') ?? undefined;
  } else if (parts.length >= 1 && VIMEO_ID.test(parts[0]!)) {
    // vimeo.com/123456789 or vimeo.com/123456789/abc123def (an unlisted video's hash)
    id = parts[0];
    hash = parts[1] ?? url.searchParams.get('h') ?? undefined;
  } else {
    // vimeo.com/channels/staffpicks/123…, /groups/x/videos/123…, /showcase/9/video/123…, /album/9/video/123…: the
    // video is the last number in the path (a showcase's own number comes first)
    if (['channels', 'groups', 'showcase', 'album'].includes(parts[0] ?? '')) id = [...parts].reverse().find((p) => VIMEO_ID.test(p));
  }
  if (!id || !VIMEO_ID.test(id)) return null;
  if (hash !== undefined && !VIMEO_HASH.test(hash)) hash = undefined;
  const startS = positiveStart(parseTimeParam(/(?:^|&)t=([^&]+)/.exec(url.hash.replace(/^#/, ''))?.[1]));
  return { provider: 'vimeo', id, ...(hash ? { hash } : {}), ...(startS ? { startS } : {}) };
}

function driveLink(url: URL): VideoLink | null {
  const host = url.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (parts[0] === 'file' && parts[1] === 'd') id = parts[2];
  else if (host === 'drive.google.com' && (parts[0] === 'open' || parts[0] === 'uc')) id = url.searchParams.get('id') ?? undefined;
  if (!id || !DRIVE_ID.test(id)) return null;
  const key = url.searchParams.get('resourcekey');
  return key && DRIVE_KEY.test(key) ? { provider: 'drive', id, resourceKey: key } : { provider: 'drive', id };
}

/** A YouTube, Vimeo or Google Drive video link, understood; null for anything else (another site, a playlist, a typo). */
export function parseVideoLink(raw: string): VideoLink | null {
  const url = toUrl(raw);
  if (!url) return null;
  return youtubeLink(url) ?? vimeoLink(url) ?? driveLink(url);
}

/** The link as stored: with its scheme ("youtu.be/x" → "https://youtu.be/x"), so it opens as a link; null when not a video link. */
export function normaliseVideoUrl(raw: string): string | null {
  const url = toUrl(raw);
  return url && parseVideoLink(raw) ? url.toString() : null;
}

export function videoProviderOf(url: string | null | undefined): VideoProvider | null {
  return url ? (parseVideoLink(url)?.provider ?? null) : null;
}

/** The same video, whatever form its link was pasted in ("youtube:eIho2S0ZahI"); null when not a video link. */
export function videoLinkKey(url: string): string | null {
  const link = parseVideoLink(url);
  return link ? `${link.provider}:${link.id}` : null;
}

export interface VideoEmbedOptions {
  /** Start here (seconds), e.g. to resume. Ignored by Google Drive. */
  startS?: number;
  /**
   * The page's origin, to let the player report progress (YouTube's `enablejsapi=1&origin=…`; Vimeo always reports).
   * Left out, the embed is a plain player.
   */
  origin?: string;
}

/**
 * The iframe URL for a YouTube, Vimeo or Google Drive link; null for anything else. YouTube plays from
 * youtube-nocookie.com without related videos from other channels; Vimeo with Do Not Track. Every origin it returns is
 * in the server's frame-src list (server/src/lib/videoEmbeds.ts).
 */
export function videoEmbedUrl(url: string, opts: VideoEmbedOptions = {}): string | null {
  const link = parseVideoLink(url);
  if (!link) return null;
  const start = opts.startS !== undefined && Number.isFinite(opts.startS) && opts.startS >= 1 ? Math.floor(opts.startS) : (link.startS ?? 0);
  if (link.provider === 'youtube') {
    const q = new URLSearchParams({ rel: '0', playsinline: '1', modestbranding: '1' });
    if (opts.origin) {
      q.set('enablejsapi', '1');
      q.set('origin', opts.origin);
    }
    if (start > 0) q.set('start', String(start));
    return `https://www.youtube-nocookie.com/embed/${link.id}?${q.toString()}`;
  }
  if (link.provider === 'vimeo') {
    const q = new URLSearchParams({ dnt: '1' });
    if (link.hash) q.set('h', link.hash);
    return `https://player.vimeo.com/video/${link.id}?${q.toString()}${start > 0 ? `#t=${start}s` : ''}`;
  }
  return `https://drive.google.com/file/d/${link.id}/preview${link.resourceKey ? `?resourcekey=${encodeURIComponent(link.resourceKey)}` : ''}`;
}

/** YouTube's still for a link (i.ytimg.com, in the server's img-src list); null for Vimeo and Drive (no public URL). */
export function videoThumbnailUrl(url: string | null | undefined): string | null {
  const link = url ? parseVideoLink(url) : null;
  return link?.provider === 'youtube' ? `https://i.ytimg.com/vi/${link.id}/hqdefault.jpg` : null;
}

/** Whether the page can follow the player's progress (YouTube and Vimeo answer messages; Google Drive does not). */
export function videoProviderReportsProgress(provider: VideoProvider | null | undefined): boolean {
  return provider === 'youtube' || provider === 'vimeo';
}

// ───────────────────────────── the embedded players' messages ─────────────────────────────

/** The origin each player's messages come from (and are sent to). */
export const VIDEO_EMBED_MESSAGE_ORIGINS: Readonly<Record<'youtube' | 'vimeo', string>> = {
  youtube: 'https://www.youtube-nocookie.com',
  vimeo: 'https://player.vimeo.com',
};

export type EmbedPlayerState = 'unstarted' | 'playing' | 'paused' | 'buffering' | 'ended';

/** What one message from an embedded player says (only the parts it carried). */
export interface EmbedPlayerEvent {
  ready?: boolean;
  /** The player's position, seconds. */
  currentTime?: number;
  duration?: number;
  state?: EmbedPlayerState;
}

/**
 * The messages to post to the player (JSON strings) so it starts reporting: YouTube's "listening" (its iframe API's
 * handshake: it answers with `infoDelivery` messages carrying currentTime, duration and playerState); Vimeo's
 * addEventListener for play, pause, ended and timeupdate.
 */
export function embedListenMessages(provider: 'youtube' | 'vimeo', id = 1): string[] {
  if (provider === 'youtube') return [JSON.stringify({ event: 'listening', id, channel: 'widget' })];
  return ['ready', 'play', 'pause', 'ended', 'timeupdate', 'seeked'].map((value) => JSON.stringify({ method: 'addEventListener', value }));
}

const YT_STATES: Record<number, EmbedPlayerState> = { [-1]: 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'unstarted' };

const finiteNonNegative = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function asObject(data: unknown): Record<string, unknown> | null {
  let v = data;
  if (typeof v === 'string') {
    if (v.length > 100_000) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function compact(e: EmbedPlayerEvent): EmbedPlayerEvent | null {
  const out: EmbedPlayerEvent = {};
  if (e.ready) out.ready = true;
  if (e.currentTime !== undefined) out.currentTime = e.currentTime;
  if (e.duration !== undefined && e.duration > 0) out.duration = e.duration;
  if (e.state) out.state = e.state;
  return Object.keys(out).length ? out : null;
}

/** One message from a YouTube or Vimeo embed, understood; null for anything else (never throws). */
export function parseEmbedMessage(provider: 'youtube' | 'vimeo', data: unknown): EmbedPlayerEvent | null {
  const msg = asObject(data);
  if (!msg || typeof msg.event !== 'string') return null;
  if (provider === 'youtube') {
    if (msg.event === 'onReady') return { ready: true };
    if (msg.event === 'onStateChange') {
      const state = typeof msg.info === 'number' ? YT_STATES[msg.info] : undefined;
      return state ? { state } : null;
    }
    if (msg.event === 'infoDelivery' || msg.event === 'initialDelivery') {
      const info = asObject(msg.info);
      if (!info) return null;
      const state = typeof info.playerState === 'number' ? YT_STATES[info.playerState] : undefined;
      return compact({ currentTime: finiteNonNegative(info.currentTime), duration: finiteNonNegative(info.duration), state, ready: msg.event === 'initialDelivery' });
    }
    return null;
  }
  const d = asObject(msg.data);
  const at = { currentTime: finiteNonNegative(d?.seconds), duration: finiteNonNegative(d?.duration) };
  switch (msg.event) {
    case 'ready':
      return { ready: true };
    case 'play':
    case 'playing':
      return compact({ ...at, state: 'playing' });
    case 'pause':
      return compact({ ...at, state: 'paused' });
    case 'ended':
      return compact({ ...at, state: 'ended' });
    case 'timeupdate':
    case 'seeked':
      return compact(at);
    default:
      return null;
  }
}

// ───────────────────────────── audiences ─────────────────────────────

/** The audiences a role sees: an administrator every video; a leader everyone's, leaders' and reps' (they coach reps). */
export function videoAudiencesFor(role: Role): VideoAudience[] {
  switch (role) {
    case 'admin':
    case 'leader':
      return ['everyone', 'leaders', 'reps'];
    case 'rep':
      return ['everyone', 'reps'];
    case 'recruiter':
      return ['everyone'];
    default:
      return [];
  }
}

export function videoVisibleTo(audience: VideoAudience, role: Role): boolean {
  return videoAudiencesFor(role).includes(audience);
}

/**
 * Whom a required video is required for: "everyone" → every member of staff; "leaders" → team leaders; "reps" →
 * reps. Administrators and leaders see more than they must watch.
 */
export function videoRequiredFor(video: { required: boolean; audience: VideoAudience }, role: Role): boolean {
  if (!video.required) return false;
  if (video.audience === 'everyone') return role === 'admin' || role === 'leader' || role === 'recruiter' || role === 'rep';
  return video.audience === 'leaders' ? role === 'leader' : role === 'rep';
}

// ───────────────────────────── watched ranges ─────────────────────────────

/** Ranges this close (seconds) are one range: a gap of a second between two reports is not a gap. */
const JOIN_GAP_S = 1;

/**
 * Clean ranges: whole seconds, inside [0, maxS], from < to, sorted, overlapping or touching ones (a gap of at most a
 * second) joined. Beyond `keep` ranges the two closest are joined (the small gap between them then counts as seen),
 * so what is stored stays small.
 */
export function normaliseWatchedRanges(ranges: readonly (readonly [number, number])[], maxS: number = VIDEO_LIMITS.durationMaxS, keep: number = VIDEO_LIMITS.rangesKept): WatchedRange[] {
  const cap = Number.isFinite(maxS) && maxS > 0 ? maxS : VIDEO_LIMITS.durationMaxS;
  const clean: WatchedRange[] = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [a, b] = r;
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const from = Math.max(0, Math.min(cap, Math.round(Math.min(a, b))));
    const to = Math.max(0, Math.min(cap, Math.round(Math.max(a, b))));
    if (to > from) clean.push([from, to]);
  }
  clean.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: WatchedRange[] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + JOIN_GAP_S) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const limit = Math.max(1, Math.floor(keep));
  while (merged.length > limit) {
    let at = 0;
    for (let i = 1; i < merged.length - 1; i++) {
      if (merged[i + 1]![0] - merged[i]![1] < merged[at + 1]![0] - merged[at]![1]) at = i;
    }
    merged[at]![1] = merged[at + 1]![1];
    merged.splice(at + 1, 1);
  }
  return merged;
}

/** Two sets of ranges as one (the parts seen before and the parts just reported). */
export function mergeWatchedRanges(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[], maxS?: number, keep?: number): WatchedRange[] {
  return normaliseWatchedRanges([...a, ...b], maxS, keep);
}

/** Seconds covered by clean (non-overlapping) ranges. */
export function watchedRangesSeconds(ranges: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (const [a, b] of ranges) total += Math.max(0, b - a);
  return total;
}

/** Watched once 90 % of the length has been seen (unknown length: never by time alone). */
export function isVideoComplete(watchedS: number, durationS: number | null | undefined): boolean {
  return !!durationS && durationS > 0 && watchedS >= durationS * VIDEO_COMPLETE_SHARE;
}

// ───────────────────────────── watch credit ─────────────────────────────

/**
 * How fast the seconds watched may grow, so a progress report cannot count more than a player could have shown in
 * the time since: at most double speed (2 s of video for each second of the clock), from a credit of up to two
 * minutes. The credit refills at that rate between reports and each report spends what it adds; a first report starts
 * with the full two minutes. A viewer at normal or double speed never runs short (the player reports every 15 s, and
 * at least once a minute in a background tab). What a report claims beyond the credit stays in the parts seen and is
 * counted by later reports as the credit refills.
 */
export const VIDEO_WATCH_RATE = 2;
export const VIDEO_WATCH_CREDIT_MAX_S = 120;

/** The credit left after the last report, and when that was (milliseconds of the real clock). */
export interface WatchCredit {
  creditS: number;
  atMs: number;
}

/** The credit available at `nowMs`: what was left plus `rate` seconds per second since, up to `maxS` (a first report: `maxS`). */
export function watchCreditAt(prev: WatchCredit | null | undefined, nowMs: number, rate = VIDEO_WATCH_RATE, maxS = VIDEO_WATCH_CREDIT_MAX_S): number {
  if (!prev || !Number.isFinite(prev.creditS) || !Number.isFinite(prev.atMs) || !Number.isFinite(nowMs)) return maxS;
  const elapsedS = Math.max(0, (nowMs - prev.atMs) / 1000); // a clock set back gives nothing, never a negative credit
  return Math.min(maxS, Math.max(0, prev.creditS) + rate * elapsedS);
}

/**
 * Seconds counted after a report: what was counted before, plus what the report adds up to the credit (whole
 * seconds); never fewer than before. Returns the credit left.
 */
export function creditedWatchSeconds(prevS: number, claimedS: number, creditS: number): { watchedS: number; creditS: number } {
  const before = Math.max(0, Number.isFinite(prevS) ? prevS : 0);
  const credit = Math.max(0, Number.isFinite(creditS) ? creditS : 0);
  const grow = Math.max(0, Math.floor(Math.min((Number.isFinite(claimedS) ? claimedS : 0) - before, credit)));
  return { watchedS: before + grow, creditS: credit - grow };
}

/**
 * The player's side of watching: the ranges seen since the page opened, built from the position the player reports
 * while it plays (several times a second). A step forward of at most `maxStepS` is playing (at up to double speed,
 * with a late sample); a bigger jump, or any step back, is a seek and starts a new range, so skipping ahead never
 * counts as seen.
 */
export interface WatchSession {
  ranges: WatchedRange[];
  /** The range being watched now. */
  open: WatchedRange | null;
}

export const WATCH_MAX_STEP_S = 4;

export function createWatchSession(): WatchSession {
  return { ranges: [], open: null };
}

/** One position report while the video plays. */
export function recordWatchSample(session: WatchSession, t: number, maxStepS = WATCH_MAX_STEP_S): WatchSession {
  if (!Number.isFinite(t) || t < 0) return session;
  const open = session.open;
  if (open && t >= open[1] && t - open[1] <= maxStepS) return { ranges: session.ranges, open: [open[0], t] };
  const ranges = open && open[1] > open[0] ? [...session.ranges, open] : session.ranges;
  return { ranges, open: [t, t] };
}

/** The player paused, ended or was seeked: the open range closes (the next sample starts a new one). */
export function breakWatchSession(session: WatchSession): WatchSession {
  if (!session.open) return session;
  return { ranges: session.open[1] > session.open[0] ? [...session.ranges, session.open] : session.ranges, open: null };
}

/** Every range seen in this session, merged (what a progress report sends). */
export function watchSessionRanges(session: WatchSession, maxS?: number): WatchedRange[] {
  return normaliseWatchedRanges(session.open ? [...session.ranges, session.open] : session.ranges, maxS);
}

/** Where to pick up: the saved position, unless it is near the start or the end, or the video was watched (start over). */
export function videoResumeAt(progress: { positionS: number; completedAt: string | null } | null | undefined, durationS: number | null | undefined): number {
  if (!progress || progress.completedAt) return 0;
  const p = progress.positionS;
  if (!Number.isFinite(p) || p < 5) return 0;
  if (durationS && p > durationS - 10) return 0;
  return Math.floor(p);
}

// ───────────────────────────── lengths ─────────────────────────────

/** 598 → "9:58"; 3723 → "1:02:03"; 0 → "0:00". */
export function formatVideoLength(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds ?? NaN) ? (seconds as number) : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Rounded for a card: 45 → "45 s"; 598 → "10 min"; 3900 → "1 h 5 min"; 3600 → "1 h". */
export function videoLengthLabel(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/**
 * A length as typed in a form: "9:58", "1:02:03", or whole minutes ("18"). Empty → null; anything unreadable, zero or
 * over six hours → NaN (so the form can say so).
 */
export function parseVideoLength(text: string | null | undefined): number | null {
  const v = (text ?? '').trim();
  if (!v) return null;
  let s: number;
  if (/^\d{1,3}$/.test(v)) s = Number(v) * 60;
  else {
    const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(v);
    if (!m || Number(m[3]) > 59 || (m[1] !== undefined && Number(m[2]) > 59)) return Number.NaN;
    s = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return s > 0 && s <= VIDEO_LIMITS.durationMaxS ? s : Number.NaN;
}
