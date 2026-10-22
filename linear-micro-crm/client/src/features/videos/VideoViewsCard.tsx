// Release 1.3 — P5 learning-videos: "Who watched" on a video's page (administrators): everyone who has started it,
// watched first (the latest first), then those part way through, with how far and when. GET /videos/:id/views.
import { Eye } from 'lucide-react';
import type { LearningVideo } from '@lm/shared';
import { useVideoViews } from '@/api/videos';
import { Avatar, Badge, Card, CardHeader, Skeleton } from '@/components/ui';
import { ErrorState } from '@/features/common';
import { VIDEO_COPY, formatDay, progressText } from './videoCopy';

export function VideoViewsCard({ video, className }: { video: LearningVideo; className?: string }) {
  const t = VIDEO_COPY.views;
  const q = useVideoViews(video.id);
  const rows = q.data ?? [];
  const watched = rows.filter((r) => r.completedAt).length;
  return (
    <Card className={className} data-testid="video-views">
      <CardHeader icon={<Eye />} title={t.title} description={q.data ? (rows.length ? t.summary(watched, rows.length - watched) : t.none) : t.description} />
      {q.isLoading ? (
        <Skeleton lines={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load who watched" />
      ) : rows.length === 0 ? null : (
        <ul className="-mx-1 max-h-[26rem] space-y-0.5 overflow-y-auto px-1">
          {rows.map((r) => (
            <li key={r.userId} className="flex items-start gap-3 rounded-lg px-1 py-2">
              <Avatar name={r.userName} color={r.avatarColor} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-fg">{r.userName}</span>
                  {r.completedAt && (
                    <Badge size="sm" tone="success" className="shrink-0 tabular">
                      {r.marked ? 'Marked' : 'Watched'} {formatDay(r.completedAt)}
                    </Badge>
                  )}
                </span>
                <span className="block truncate text-xs text-muted">{r.teamName ?? 'No team'}</span>
                {!r.completedAt && (
                  <span className="block text-xs tabular text-muted">
                    {progressText(video, { videoId: video.id, watchedS: r.watchedS, positionS: r.positionS ?? 0, completedAt: null, lastAt: r.lastAt })}
                    {r.lastAt ? `, last ${formatDay(r.lastAt)}` : ''}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
