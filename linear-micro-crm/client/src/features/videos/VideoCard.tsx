// Release 1.3 — P5 learning-videos: one video on the Learning hub — its still, title, topic and length, and badges
// for Required (for your role), Watched / how far you are, Example (demo data) and who it is for.
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { VIDEO_AUDIENCE_LABELS, VIDEO_TOPIC_LABELS, videoRequiredFor, type LearningVideo, type Role } from '@lm/shared';
import { Badge } from '@/components/ui';
import { VideoThumb } from './VideoThumb';
import { VIDEO_COPY, progressText, videoStatus } from './videoCopy';

export interface VideoCardProps {
  video: LearningVideo;
  role: Role;
  className?: string;
}

export function VideoCard({ video, role, className }: VideoCardProps) {
  const status = videoStatus(video.my);
  const requiredForMe = videoRequiredFor(video, role);
  const forSomeone = video.audience !== 'everyone';
  return (
    <Link
      to={`/learning/videos/${video.id}`}
      // a row on a phone (still beside the words, so a list of videos fits the screen), a card from `sm` up
      className={clsx('focus-ring card-hover group flex h-full min-w-0 flex-row gap-3 rounded-xl border border-border bg-surface p-3 shadow-card sm:flex-col', className)}
      aria-label={`${video.title}${requiredForMe ? ', required' : ''}${status === 'watched' ? ', watched' : ''}`}
      data-video-card={video.id}
    >
      <VideoThumb video={video} className="max-sm:w-32 max-sm:shrink-0 max-sm:self-start" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-fg group-hover:text-primary">{video.title}</span>
        <span className="mt-0.5 text-xs text-muted">
          {VIDEO_TOPIC_LABELS[video.topic]}
          <span aria-hidden> · </span>
          <span className={clsx(status === 'watched' && 'text-success', 'tabular')}>{progressText(video, video.my)}</span>
        </span>
        <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          {video.required && (
            <Badge size="sm" tone={requiredForMe && status !== 'watched' ? 'warning' : 'neutral'}>
              {requiredForMe ? 'Required' : `Required for ${VIDEO_AUDIENCE_LABELS[video.audience].toLowerCase()}`}
            </Badge>
          )}
          {status === 'started' && <Badge size="sm" tone="primary">In progress</Badge>}
          {forSomeone && !video.required && <Badge size="sm" tone="neutral">For {VIDEO_AUDIENCE_LABELS[video.audience].toLowerCase()}</Badge>}
          {video.example && <Badge size="sm" tone="info">{VIDEO_COPY.player.example}</Badge>}
        </span>
      </span>
    </Link>
  );
}
