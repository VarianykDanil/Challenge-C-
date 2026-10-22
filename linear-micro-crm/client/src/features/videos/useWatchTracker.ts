// Release 1.3 — P5 learning-videos: follows what the player shows and reports it. The parts of the video seen in this
// visit are kept as ranges (shared recordWatchSample: a jump ahead is a seek and never counts); every 15 s while
// something new was seen, on pause and at the end, POST /videos/:id/progress sends them with the position to resume
// from. The server merges them with what was seen before, so a report sent twice (a retry on a bad signal) counts
// once. When the page goes (tab closed, phone locked, another page) the last report goes with keepalive.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  VIDEO_LIMITS,
  VIDEO_PROGRESS_INTERVAL_S,
  breakWatchSession,
  createWatchSession,
  normaliseWatchedRanges,
  recordWatchSample,
  watchSessionRanges,
  watchedRangesSeconds,
  type LearningVideo,
  type VideoProgress,
  type VideoProgressInput,
} from '@lm/shared';
import { sendVideoProgressBeacon, useReportVideoProgress } from '@/api/videos';

export interface WatchTracker {
  /** The player's position while it plays (several times a second). */
  playing(t: number): void;
  /** Paused: the current range closes and a report goes. */
  paused(t: number): void;
  /** Seeking: the current range closes (the next sample starts a new one). */
  seeked(t: number): void;
  /** Played to the end. */
  ended(t: number): void;
  /** The length the player knows. */
  setDuration(d: number | null | undefined): void;
  /** "Mark as watched" (links whose player cannot report). */
  markWatched(): Promise<VideoProgress>;
}

export function useWatchTracker(video: Pick<LearningVideo, 'id' | 'durationS' | 'my'>): WatchTracker {
  const report = useReportVideoProgress();
  const mutate = report.mutate;
  const mutateAsync = report.mutateAsync;
  const id = video.id;
  const session = useRef(createWatchSession());
  const position = useRef(video.my?.positionS ?? 0);
  const duration = useRef<number | null>(video.durationS ?? null);
  const dirty = useRef(false);

  const payload = useCallback((extra: Partial<VideoProgressInput> = {}): VideoProgressInput => {
    const max = duration.current ?? undefined;
    const ranges = normaliseWatchedRanges(watchSessionRanges(session.current, max), max, VIDEO_LIMITS.rangesPerReport);
    return {
      watchedS: watchedRangesSeconds(ranges),
      positionS: Math.max(0, Math.min(position.current, max ?? Number.MAX_SAFE_INTEGER)),
      ranges,
      ...(duration.current ? { durationS: duration.current } : {}),
      ...extra,
    };
  }, []);

  const send = useCallback(
    (extra?: Partial<VideoProgressInput>) => {
      if (!dirty.current && !extra) return;
      dirty.current = false;
      // a failed report (no signal) leaves the parts seen in the session: the next one sends them again
      mutate({ id, ...payload(extra) }, { onError: () => void (dirty.current = true) });
    },
    [id, mutate, payload],
  );

  // every 15 s while there is something new
  useEffect(() => {
    const timer = window.setInterval(() => send(), VIDEO_PROGRESS_INTERVAL_S * 1000);
    return () => window.clearInterval(timer);
  }, [send]);

  // the page going away: the last report with keepalive (never awaited)
  useEffect(() => {
    const flush = () => {
      if (!dirty.current) return;
      dirty.current = false;
      sendVideoProgressBeacon(id, payload());
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [id, payload]);

  return useMemo<WatchTracker>(
    () => ({
      playing(t) {
        position.current = t;
        const next = recordWatchSample(session.current, t);
        if (next !== session.current) {
          session.current = next;
          dirty.current = true;
        }
      },
      paused(t) {
        position.current = t;
        session.current = breakWatchSession(session.current);
        dirty.current = true;
        send();
      },
      seeked(t) {
        position.current = t;
        session.current = breakWatchSession(session.current);
        dirty.current = true;
      },
      ended(t) {
        position.current = t;
        session.current = breakWatchSession(session.current);
        dirty.current = true;
        send({ ended: true });
      },
      setDuration(d) {
        if (d && Number.isFinite(d) && d > 0) duration.current = d;
      },
      markWatched() {
        dirty.current = false;
        return mutateAsync({ id, ...payload({ markWatched: true }) });
      },
    }),
    [id, mutateAsync, payload, send],
  );
}
