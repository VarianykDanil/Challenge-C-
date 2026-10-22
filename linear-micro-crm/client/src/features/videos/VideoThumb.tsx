// Release 1.3 — P5 learning-videos: a video's still (16:9) with its length, where it plays from, and how far you are.
// YouTube's thumbnail or an upload's poster; anything else (Vimeo, Drive, an upload without a still, a picture that
// will not load on the hotspot) shows a calm placeholder with a play mark instead.
import { useState } from 'react';
import { CheckCircle2, Play } from 'lucide-react';
import clsx from 'clsx';
import { VIDEO_PROVIDER_LABELS, formatVideoLength, type LearningVideo } from '@lm/shared';
import { videoStatus } from './videoCopy';

export interface VideoThumbProps {
  video: LearningVideo;
  /** Show the caller's progress (a bar along the bottom, a tick once watched). */
  showProgress?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function VideoThumb({ video, showProgress = true, size = 'md', className }: VideoThumbProps) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? video.thumbnailUrl : null;
  const status = videoStatus(video.my);
  const share = video.my && video.durationS ? Math.min(1, video.my.watchedS / video.durationS) : 0;
  const source = video.kind === 'upload' ? 'Uploaded' : video.provider ? VIDEO_PROVIDER_LABELS[video.provider] : 'Link';
  return (
    <span className={clsx('relative block aspect-video overflow-hidden rounded-lg bg-surface-3', size === 'sm' ? 'w-24 shrink-0' : 'w-full', className)} aria-hidden>
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="absolute inset-0 bg-gradient-to-br from-primary-soft via-surface-2 to-accent-soft" />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className={clsx('flex items-center justify-center rounded-full bg-ink/75 text-ink-fg shadow-card', size === 'sm' ? 'h-7 w-7' : 'h-9 w-9 sm:h-11 sm:w-11')}>
          <Play className={clsx('translate-x-px fill-current', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4 sm:h-5 sm:w-5')} />
        </span>
      </span>
      {size === 'md' && (
        <span className="absolute left-2 top-2 rounded bg-ink/75 px-1.5 py-0.5 text-[11px] font-medium text-ink-fg max-sm:hidden">{source}</span>
      )}
      {video.durationS ? (
        <span className={clsx('absolute bottom-2 right-2 rounded bg-ink/80 font-medium tabular text-ink-fg', size === 'sm' ? 'px-1 text-[10px] bottom-1 right-1' : 'px-1.5 py-0.5 text-[11px]')}>
          {formatVideoLength(video.durationS)}
        </span>
      ) : null}
      {showProgress && status === 'watched' && (
        <span className={clsx('absolute flex items-center gap-1 rounded-full bg-success font-semibold text-status-fg', size === 'sm' ? 'left-1 top-1 p-0.5' : 'left-1.5 top-1.5 p-0.5 sm:left-auto sm:right-2 sm:top-2 sm:px-2 sm:py-0.5 sm:text-[11px]')}>
          <CheckCircle2 className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          {size === 'md' && <span className="max-sm:hidden">Watched</span>}
        </span>
      )}
      {showProgress && status === 'started' && share > 0 && (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-ink/40">
          <span className="block h-full bg-primary" style={{ width: `${Math.max(3, share * 100)}%` }} />
        </span>
      )}
    </span>
  );
}
