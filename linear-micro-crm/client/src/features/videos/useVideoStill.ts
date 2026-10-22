// Release 1.3 — P5 learning-videos: an upload's still and length, taken the first time someone who may edit it opens
// it. The page's Content-Security-Policy lets the browser play videos from Linear Hub itself but not from a local file
// (blob:), so the still cannot be taken in the upload form; here a hidden, muted <video> reads the server's copy (the
// same stream the player uses), seeks a little way in, draws one frame (640 px wide JPEG) and sends it with the length
// (POST /videos/:id/poster). Once: the video then has both. A browser that cannot decode the file (a HEVC MOV on
// Windows) simply leaves the placeholder.
import { useEffect } from 'react';
import { VIDEO_LIMITS, type LearningVideo } from '@lm/shared';
import { useSaveVideoStill } from '@/api/videos';

const STILL_WIDTH = 640;
const GIVE_UP_MS = 30_000;
/** A browser that could not decode a file does not try again on every visit (this tab only). */
const failedKey = (id: number) => `lm-video-still-failed:${id}`;
const failedBefore = (id: number) => {
  try {
    return sessionStorage.getItem(failedKey(id)) === '1';
  } catch {
    return false;
  }
};
const rememberFailed = (id: number) => {
  try {
    sessionStorage.setItem(failedKey(id), '1');
  } catch {
    /* private mode: it simply tries again next time */
  }
};

export function useVideoStill(video: LearningVideo | undefined): void {
  const save = useSaveVideoStill();
  const mutate = save.mutate;
  const needed = !!video && video.kind === 'upload' && !!video.canEdit && !!video.streamUrl && (!video.thumbnailUrl || !video.durationS);
  const id = video?.id;
  const src = video?.streamUrl;
  const hasStill = !!video?.thumbnailUrl;
  useEffect(() => {
    if (!needed || !id || !src || typeof document === 'undefined' || failedBefore(id)) return;
    let done = false;
    let taken = false;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    const finish = () => {
      if (done) return;
      done = true;
      if (!taken) rememberFailed(id);
      window.clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      el.remove();
    };
    const timer = window.setTimeout(finish, GIVE_UP_MS);
    el.addEventListener('error', finish, { once: true });
    el.addEventListener(
      'loadedmetadata',
      () => {
        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
        el.currentTime = d ? Math.min(5, d * 0.1) : 1;
      },
      { once: true },
    );
    el.addEventListener(
      'seeked',
      () => {
        try {
          if (done || !el.videoWidth || !el.videoHeight) return finish();
          const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined;
          // it has a still and this browser cannot tell its length either (a WebM recorded without one): nothing new
          // to send (the player fills the length in once it knows it)
          if (hasStill && !d) return finish();
          const canvas = document.createElement('canvas');
          canvas.width = STILL_WIDTH;
          canvas.height = Math.round((STILL_WIDTH * el.videoHeight) / el.videoWidth);
          canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height);
          const image = canvas.toDataURL('image/jpeg', 0.8);
          if (image.startsWith('data:image/jpeg;base64,') && image.length <= VIDEO_LIMITS.posterDataUrlMaxChars) {
            taken = true;
            mutate({ id, image, durationS: d });
          }
        } catch {
          /* a frame we cannot draw: keep the placeholder */
        }
        finish();
      },
      { once: true },
    );
    document.body.appendChild(el);
    el.src = src;
    return finish;
  }, [needed, id, src, hasStill, mutate]);
}
