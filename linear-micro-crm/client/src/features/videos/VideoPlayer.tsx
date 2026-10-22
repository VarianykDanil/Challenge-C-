// Release 1.3 — P5 learning-videos: the two players.
//  - FilePlayer: an upload, in the browser's own <video> player, streamed from /api/videos/:id/stream with byte ranges
//    (so it starts at once and seeks without downloading everything); it picks up at the saved position.
//  - EmbedPlayer: a YouTube, Vimeo or Google Drive link in its provider's player. YouTube and Vimeo report their
//    position by postMessage (no script of theirs is loaded: the page's CSP allows only the frames); Google Drive does
//    not. The player counts as tracking only once it sends a time while it plays (onTracking(true)); "Mark as
//    watched" is offered (onTracking(false)) for Drive, for a player that stays silent for 10 s, and for one that
//    answers but sends no time within 10 s of saying it plays or of being tapped (a time arriving later hides it).
// Both feed the same WatchTracker (useWatchTracker).
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  VIDEO_EMBED_MESSAGE_ORIGINS,
  embedListenMessages,
  parseEmbedMessage,
  videoEmbedUrl,
  type EmbedPlayerState,
  type LearningVideo,
} from '@lm/shared';
import type { WatchTracker } from './useWatchTracker';

export interface PlayerHandle {
  /** Back to the start (Start from the beginning). */
  restart(): void;
}

export interface FilePlayerProps {
  video: LearningVideo;
  resumeAt: number;
  tracker: WatchTracker;
  onError?: () => void;
}

export const FilePlayer = forwardRef<PlayerHandle, FilePlayerProps>(function FilePlayer({ video, resumeAt, tracker, onError }, ref) {
  const el = useRef<HTMLVideoElement>(null);
  const resumed = useRef(false);
  // the jump to the saved position is ours, not the viewer's: it saves nothing
  const ownSeek = useRef(false);
  useImperativeHandle(ref, () => ({
    restart() {
      const v = el.current;
      if (!v) return;
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    },
  }));
  return (
    <video
      ref={el}
      className="block aspect-video w-full bg-ink"
      src={video.streamUrl ?? undefined}
      poster={video.thumbnailUrl ?? undefined}
      controls
      playsInline
      preload="metadata"
      controlsList="nodownload"
      aria-label={video.title}
      data-testid="video-file-player"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (Number.isFinite(v.duration)) tracker.setDuration(v.duration);
        if (!resumed.current && resumeAt > 0) {
          resumed.current = true;
          ownSeek.current = true;
          v.currentTime = resumeAt;
        }
      }}
      // a WebM recorded without a length learns it only as it plays (Infinity until then)
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d)) tracker.setDuration(d);
      }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (!v.paused && !v.seeking) tracker.playing(v.currentTime);
      }}
      onSeeking={(e) => {
        if (ownSeek.current) ownSeek.current = false;
        else tracker.seeked(e.currentTarget.currentTime);
      }}
      onPause={(e) => {
        if (!e.currentTarget.ended) tracker.paused(e.currentTarget.currentTime);
      }}
      onEnded={(e) => tracker.ended(e.currentTarget.currentTime)}
      onError={onError}
    />
  );
});

export interface EmbedPlayerProps {
  video: LearningVideo;
  resumeAt: number;
  tracker: WatchTracker;
  /**
   * true once the player sends its time while playing; false when it cannot (Google Drive), stays silent, or answers
   * but sends no time once it plays (then "Mark as watched" is offered).
   */
  onTracking?: (tracking: boolean) => void;
}

/** How long a silent player (or one that plays without sending its time) gets before the page offers "Mark as watched". */
const SILENT_AFTER_MS = 10_000;

export const EmbedPlayer = forwardRef<PlayerHandle, EmbedPlayerProps>(function EmbedPlayer({ video, resumeAt, tracker, onTracking }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const provider = video.provider ?? null;
  const reports = provider === 'youtube' || provider === 'vimeo' ? provider : null;
  const srcAt = (startS: number) => (video.url ? videoEmbedUrl(video.url, { startS, origin: reports ? window.location.origin : undefined }) : null);
  // the start is fixed when the player first loads (resume); Start from the beginning loads it again at 0
  const [load, setLoad] = useState(() => ({ src: srcAt(resumeAt), n: 0 }));
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  const trackingRef = useRef(onTracking);
  trackingRef.current = onTracking;

  useImperativeHandle(ref, () => ({
    restart() {
      setLoad((l) => ({ src: srcAt(0), n: l.n + 1 }));
    },
  }));

  useEffect(() => {
    if (!reports) {
      trackingRef.current?.(false);
      return;
    }
    const origin = VIDEO_EMBED_MESSAGE_ORIGINS[reports];
    let state: EmbedPlayerState | undefined;
    let heard = false;
    let tracking = false;
    let lastT = 0;
    let waitingForTime: number | undefined;
    const post = () => {
      const win = frame.current?.contentWindow;
      if (!win) return;
      for (const m of embedListenMessages(reports)) win.postMessage(m, origin);
    };
    // The player said it plays, or someone tapped into it: its time should follow. None within 10 s → Mark as watched.
    const expectTime = () => {
      if (tracking || waitingForTime !== undefined) return;
      waitingForTime = window.setTimeout(() => {
        waitingForTime = undefined;
        if (!tracking) trackingRef.current?.(false);
      }, SILENT_AFTER_MS);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const ev = parseEmbedMessage(reports, e.data);
      if (!ev) return;
      heard = true; // it answered: stop asking
      const t = trackerRef.current;
      if (ev.ready) post(); // Vimeo listens for addEventListener only once it is ready
      if (ev.duration) t.setDuration(ev.duration);
      if (ev.currentTime !== undefined) lastT = ev.currentTime;
      if (ev.state) state = ev.state;
      if (ev.state === 'playing') expectTime();
      if (ev.currentTime !== undefined && state === 'playing' && !tracking) {
        tracking = true;
        window.clearTimeout(waitingForTime);
        waitingForTime = undefined;
        trackingRef.current?.(true);
      }
      if (ev.state === 'paused') t.paused(lastT);
      else if (ev.state === 'ended') t.ended(lastT);
      else if (ev.currentTime !== undefined && state === 'playing') t.playing(ev.currentTime);
    };
    // a tap into the player moves the focus into its frame (the page cannot see the tap itself)
    const onBlur = () => {
      if (frame.current && document.activeElement === frame.current) expectTime();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('blur', onBlur);
    // YouTube answers "listening" once its player is up: ask every 250 ms until it does
    let tries = 0;
    const ask = window.setInterval(() => {
      if (heard || ++tries > SILENT_AFTER_MS / 250) {
        window.clearInterval(ask);
        if (!heard) trackingRef.current?.(false);
        return;
      }
      post();
    }, 250);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('blur', onBlur);
      window.clearInterval(ask);
      window.clearTimeout(waitingForTime);
    };
  }, [reports, load.n]);

  if (!load.src) return null;
  return (
    <iframe
      ref={frame}
      key={load.n}
      src={load.src}
      title={video.title}
      className="block aspect-video w-full border-0 bg-ink"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      data-testid="video-embed-player"
    />
  );
});
