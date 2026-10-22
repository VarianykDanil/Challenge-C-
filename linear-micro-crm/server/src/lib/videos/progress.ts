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
 *    docs/r3/P5-learning-videos.md).
 */
import { VIDEO_COMPLETE_SHARE, VIDEO_WATCH_CREDIT_MAX_S, VIDEO_WATCH_RATE } from '@lm/shared';
import { run, type Db } from '../../db/connection.ts';

let clock: () => number = () => Date.now();
let limits = { rate: VIDEO_WATCH_RATE, maxS: VIDEO_WATCH_CREDIT_MAX_S };

/** Tests: the clock the watch credit reads (milliseconds); null puts the real clock back. */
export function configureProgressClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Tests: other credit limits (e.g. a test of the merging maths that sends minutes of ranges at once); null: the defaults. */
export function configureWatchCredit(next: { rate: number; maxS: number } | null): void {
  limits = next ?? { rate: VIDEO_WATCH_RATE, maxS: VIDEO_WATCH_CREDIT_MAX_S };
}

export function progressNowMs(): number {
  return clock();
}

export function watchCreditLimits(): { rate: number; maxS: number } {
  return limits;
}

/**
 * Marks as watched, now, every viewing of the video not yet watched that has 90 % of `lengthS` counted. Returns how
 * many. Used when a video that had no length gets one; a viewing already watched is never touched.
 */
export function completeViewsAtLength(db: Db, videoId: number, lengthS: number, nowIso: string): number {
  if (!Number.isFinite(lengthS) || lengthS <= 0) return 0;
  return Number(
    run(db, `UPDATE video_views SET completed_at = ?, marked = 0 WHERE video_id = ? AND completed_at IS NULL AND watched_s >= ?`, [nowIso, videoId, lengthS * VIDEO_COMPLETE_SHARE]).changes,
  );
}

/** POST /videos/:id/progress, as the API router sees it (path relative to /api). */
export function isVideoProgressReport(method: string, path: string): boolean {
  return method === 'POST' && /^\/videos\/\d+\/progress\/?$/.test(path);
}
