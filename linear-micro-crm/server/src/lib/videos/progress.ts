/**
 * Release 1.3 — OWNED BY P5 learning-videos. The server's side of watch progress that is not the route itself:
 *
 *  - the watch credit's clock: the REAL clock (like rate limits), never the business clock, so pinning or moving the
 *    business date never hands anyone extra seconds; configureProgressClock / configureWatchCredit are test hooks.
 *  - completeViewsAtLength: when an upload without a length gets one (its editor's player reports it, or an editor
 *    types it in Edit video), everyone who has already seen 90 % of it counts as watched, in one statement.
 *  - isVideoProgressReport: the progress report path (POST /videos/:id/progress, every 15 s per viewer). The route
 *    bumps the response cache's data version itself when a report makes a video watched; this predicate is for the
 *    app's blanket "every write bumps the cache" step, so it can leave the in-between reports out (lead merge note in
 *    docs/LOGIC.md §16.5).
 */
import { VIDEO_COMPLETE_SHARE, VIDEO_WATCH_CREDIT_MAX_S, VIDEO_WATCH_CREDIT_START_S, VIDEO_WATCH_RATE, VIDEO_WATCH_SESSION_GAP_S } from '@lm/shared';
import { run, type Db } from '../../db/connection.ts';

export interface WatchCreditLimits {
  rate: number;
  maxS: number;
  /** A new viewing's credit (the first report, or the first after `gapS` without one). */
  startS: number;
  gapS: number;
}

const DEFAULT_LIMITS: WatchCreditLimits = { rate: VIDEO_WATCH_RATE, maxS: VIDEO_WATCH_CREDIT_MAX_S, startS: VIDEO_WATCH_CREDIT_START_S, gapS: VIDEO_WATCH_SESSION_GAP_S };

let clock: () => number = () => Date.now();
let limits: WatchCreditLimits = DEFAULT_LIMITS;

/** Tests: the clock the watch credit reads (milliseconds); null puts the real clock back. */
export function configureProgressClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/**
 * Tests: other credit limits (e.g. a test of the merging maths that sends minutes of ranges at once); null: the
 * defaults. A new viewing starts with `startS`, else `maxS`.
 */
export function configureWatchCredit(next: { rate: number; maxS: number; startS?: number; gapS?: number } | null): void {
  limits = next ? { rate: next.rate, maxS: next.maxS, startS: next.startS ?? next.maxS, gapS: next.gapS ?? VIDEO_WATCH_SESSION_GAP_S } : DEFAULT_LIMITS;
}

export function progressNowMs(): number {
  return clock();
}

export function watchCreditLimits(): WatchCreditLimits {
  return limits;
}

/**
 * Marks as watched, now, every viewing of the video not yet watched that has 90 % of `lengthS` counted. Returns how
 * many. Used when a video that had no length gets one; a viewing already watched stays watched. Re-review fix: a
 * viewing that was counted on the viewer's own reported length (a link with no length: stored as Marked) and is
 * measured at 90% of the real length now is a watch, not Marked (a Mark as watched below 90% stays Marked).
 */
export function completeViewsAtLength(db: Db, videoId: number, lengthS: number, nowIso: string): number {
  if (!Number.isFinite(lengthS) || lengthS <= 0) return 0;
  const enough = lengthS * VIDEO_COMPLETE_SHARE;
  run(db, `UPDATE video_views SET marked = 0 WHERE video_id = ? AND completed_at IS NOT NULL AND marked = 1 AND watched_s >= ?`, [videoId, enough]);
  return Number(run(db, `UPDATE video_views SET completed_at = ?, marked = 0 WHERE video_id = ? AND completed_at IS NULL AND watched_s >= ?`, [nowIso, videoId, enough]).changes);
}

/** POST /videos/:id/progress, as the API router sees it (path relative to /api). */
export function isVideoProgressReport(method: string, path: string): boolean {
  return method === 'POST' && /^\/videos\/\d+\/progress\/?$/.test(path);
}
