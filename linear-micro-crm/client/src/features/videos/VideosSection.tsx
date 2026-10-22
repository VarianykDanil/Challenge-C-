// Release 1.3 slot — OWNED BY P5 learning-videos.
// Learning hub → Videos: thumbnails, length, "Watched", "Required", and "Add video" for admins (and leaders when
// allowed). Mounted in pages/Learning.tsx right after the pitches section, in an ErrorBoundary with fallback={null}.
// Renders a whole <section> (the hub spaces its sections itself). The player is pages/LearningVideo.tsx
// (/learning/videos/:id). Order: what is required of you and not watched yet first, then what you are part way
// through, then the rest, newest first; a topic filter appears once there are more than four videos.
import { useMemo, useState } from 'react';
import { Clapperboard, Plus } from 'lucide-react';
import clsx from 'clsx';
import { VIDEO_TOPICS, VIDEO_TOPIC_LABELS, videoRequiredFor, type LearningVideo, type Role, type VideoTopic } from '@lm/shared';
import { useVideoAccess, useVideos } from '@/api/videos';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Button, Skeleton } from '@/components/ui';
import { AddVideoModal } from './AddVideoModal';
import { VideoCard } from './VideoCard';
import { VIDEO_COPY, videoStatus } from './videoCopy';

export interface VideosSectionProps {
  className?: string;
}

/** 0 required of you and not watched, 1 part way through, 2 not started, 3 watched (then newest first, as the server sends). */
function rank(v: LearningVideo, role: Role): number {
  const s = videoStatus(v.my);
  if (s === 'watched') return 3;
  if (videoRequiredFor(v, role)) return 0;
  return s === 'started' ? 1 : 2;
}

export function sortVideosForHub(videos: readonly LearningVideo[], role: Role): LearningVideo[] {
  return videos.map((v, i) => ({ v, i, r: rank(v, role) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.v);
}

export function VideosSection({ className }: VideosSectionProps) {
  const me = useCurrentUser();
  const t = VIDEO_COPY.section;
  const { data, isLoading, isError } = useVideos();
  const access = useVideoAccess();
  const canAdd = access.data?.canAdd ?? false;
  const [adding, setAdding] = useState(false);
  const [topic, setTopic] = useState<VideoTopic | 'all'>('all');
  const videos = useMemo(() => sortVideosForHub(data ?? [], me.role), [data, me.role]);
  const topics = VIDEO_TOPICS.filter((k) => videos.some((v) => v.topic === k));
  const shown = topic === 'all' ? videos : videos.filter((v) => v.topic === topic);
  if (isError) return null;
  const watched = videos.filter((v) => v.my?.completedAt).length;

  return (
    <section aria-labelledby="videos-heading" className={clsx('min-w-0', className)} data-videos-section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="videos-heading" className="flex items-center gap-2 text-lg font-semibold text-fg">
            <Clapperboard className="h-5 w-5 text-primary" aria-hidden />
            {t.title}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{t.description}</p>
        </div>
        <div className="flex items-center gap-3">
          {!isLoading && videos.length > 0 && (
            <p className="text-xs text-muted tabular" data-testid="videos-watched-count">
              {watched} of {videos.length} watched
            </p>
          )}
          {canAdd && (
            <Button size="sm" className="min-h-10" leftIcon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
              {t.add}
            </Button>
          )}
        </div>
      </div>

      {videos.length > 4 && topics.length > 1 && (
        <div role="group" aria-label="Filter by topic" className="mb-3 flex flex-wrap gap-2">
          {(['all', ...topics] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={topic === k}
              onClick={() => setTopic(k)}
              className={clsx(
                'focus-ring min-h-10 rounded-full border px-3.5 text-sm font-medium transition-colors',
                topic === k ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {k === 'all' ? t.all : VIDEO_TOPIC_LABELS[k]}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-60 rounded-xl" />)}
        </div>
      ) : videos.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">{t.empty}</span> {canAdd ? t.emptyCanAdd : t.emptyCannotAdd}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((v) => (
            <li key={v.id} className="min-w-0">
              <VideoCard video={v} role={me.role} />
            </li>
          ))}
        </ul>
      )}
      {canAdd && <AddVideoModal open={adding} onClose={() => setAdding(false)} />}
    </section>
  );
}
