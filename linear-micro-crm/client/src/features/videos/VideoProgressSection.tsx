// Release 1.3 slot — OWNED BY P5 learning-videos.
// Learning → Progress: the required videos in the person's checklist (view 'me', or 'person' for a leader or admin
// looking at someone), and the team view's "6 of 8 watched" (view 'team'). Mounted in pages/LearningProgress.tsx after
// the checklist (me, person) and after the team checklist (team), in an ErrorBoundary with fallback={null}. Renders the
// whole card or nothing (nothing while no video is required of them).
//  - me: GET /videos (their own progress); a row per required video, linked to its player.
//  - person: GET /videos/team?userId= (leader: own team; admin: anyone); the same rows, from that person's progress.
//  - team: GET /videos/team; how many have watched every required video, and a row per person with a dot per video.
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Clapperboard, Users } from 'lucide-react';
import clsx from 'clsx';
import {
  videoRequiredFor,
  type LearningVideo,
  type TeamVideoCell,
  type TeamVideoColumn,
  type TeamVideoProgressRow,
  type VideoProgress,
} from '@lm/shared';
import { useTeamVideoProgress, useVideos } from '@/api/videos';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Avatar, Badge, Card, CardHeader, ProgressBar, SkeletonCard } from '@/components/ui';
import { VideoThumb } from './VideoThumb';
import { VIDEO_COPY, formatDay, progressText, videoStatus } from './videoCopy';

export interface VideoProgressSectionProps {
  view: 'me' | 'person' | 'team';
  /** The person shown (view 'me': the signed-in user; 'person': that person). */
  userId?: number;
  className?: string;
}

export function VideoProgressSection({ view, userId, className }: VideoProgressSectionProps) {
  if (view === 'me') return <MyVideos className={className} />;
  if (view === 'person' && userId) return <PersonVideos userId={userId} className={className} />;
  if (view === 'team') return <TeamVideos className={className} />;
  return null;
}

function MyVideos({ className }: { className?: string }) {
  const me = useCurrentUser();
  const q = useVideos();
  if (q.isLoading) return <SkeletonCard className={className} lines={3} />;
  const required = (q.data ?? []).filter((v) => videoRequiredFor(v, me.role));
  if (!required.length) return null;
  const done = required.filter((v) => v.my?.completedAt).length;
  return (
    <Card className={className} data-testid="video-progress-me">
      <CardHeader icon={<Clapperboard />} title={VIDEO_COPY.progress.title} description={VIDEO_COPY.progress.me} />
      <ProgressBar size="sm" value={done} max={required.length} tone="success" label={`${done} of ${required.length} watched`} className="mb-3" />
      <ul className="divide-y divide-border/70">
        {required.map((v) => (
          <VideoRow key={v.id} video={v} my={v.my ?? null} />
        ))}
      </ul>
    </Card>
  );
}

function PersonVideos({ userId, className }: { userId: number; className?: string }) {
  const q = useTeamVideoProgress(userId);
  if (q.isLoading) return <SkeletonCard className={className} lines={3} />;
  const row = q.data?.rows.find((r) => r.userId === userId);
  if (!q.data || !row || !row.cells?.length) return null;
  const byId = new Map((q.data.videos ?? []).map((v) => [v.id, v]));
  return (
    <Card className={clsx('mt-5', className)} data-testid="video-progress-person">
      <CardHeader icon={<Clapperboard />} title={VIDEO_COPY.progress.title} description={VIDEO_COPY.progress.person(row.userName.split(' ')[0] ?? row.userName, row.watchedRequired, row.requiredTotal ?? row.cells.length)} />
      <ul className="divide-y divide-border/70">
        {row.cells.map((c) => {
          const col = byId.get(c.videoId);
          return col ? <VideoRow key={c.videoId} video={columnVideo(col)} my={cellProgress(c)} /> : null;
        })}
      </ul>
    </Card>
  );
}

/** A team column as just enough of a video for a row (no still: the team API sends titles only). */
function columnVideo(c: TeamVideoColumn): Pick<LearningVideo, 'id' | 'title' | 'durationS'> {
  return { id: c.id, title: c.title, durationS: c.durationS };
}

const cellProgress = (c: TeamVideoCell): VideoProgress | null =>
  c.completedAt || c.watchedS > 0 ? { videoId: c.videoId, watchedS: c.watchedS, positionS: 0, completedAt: c.completedAt, lastAt: null } : null;

function VideoRow({ video, my }: { video: Pick<LearningVideo, 'id' | 'title' | 'durationS'> & Partial<LearningVideo>; my: VideoProgress | null }) {
  const status = videoStatus(my);
  const full = 'kind' in video && video.kind !== undefined;
  const detail = status === 'watched' && my?.completedAt ? formatDay(my.completedAt) : progressText(video, my);
  return (
    <li>
      <Link to={`/learning/videos/${video.id}`} className="focus-ring-inset group -mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2/60">
        {full ? (
          <VideoThumb video={video as LearningVideo} size="sm" />
        ) : (
          <span
            className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', status === 'watched' ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted')}
            aria-hidden
          >
            {status === 'watched' ? <CheckCircle2 className="h-5 w-5" /> : <Clapperboard className="h-4 w-4" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium text-fg group-hover:text-primary">{video.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {status === 'watched' ? (
              <Badge size="sm" tone="success">Watched</Badge>
            ) : status === 'started' ? (
              <Badge size="sm" tone="primary">In progress</Badge>
            ) : (
              <Badge size="sm" tone="warning">To watch</Badge>
            )}
            <span className="text-xs tabular text-muted">{detail}</span>
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

function TeamVideos({ className }: { className?: string }) {
  const me = useCurrentUser();
  const q = useTeamVideoProgress();
  if (q.isLoading) return <SkeletonCard className={className} lines={4} />;
  const data = q.data;
  if (!data || !data.required) return null;
  const rows = data.rows.filter((r) => (r.requiredTotal ?? 0) > 0);
  if (!rows.length) return null;
  const videos = data.videos ?? [];
  const all = rows.filter((r) => r.watchedRequired >= (r.requiredTotal ?? 0)).length;
  const number = new Map(videos.map((v, i) => [v.id, i + 1]));
  const href = (id: number) => (id === me.id ? '/learning/progress' : `/learning/progress?userId=${id}`);
  return (
    <Card padded={false} className={clsx('mt-4', className)} data-testid="video-progress-team">
      <div className="p-5 pb-3">
        <CardHeader className="mb-2" icon={<Users />} title={VIDEO_COPY.progress.title} description={VIDEO_COPY.progress.team(all, rows.length)} />
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {videos.map((v) => (
            <li key={v.id} className="min-w-0">
              <Link to={`/learning/videos/${v.id}`} className="focus-ring inline-flex min-h-8 max-w-full items-center gap-1.5 rounded hover:text-primary max-sm:min-h-10">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold tabular text-fg" aria-hidden>
                  {number.get(v.id)}
                </span>
                <span className="truncate">{v.title}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
      <ul className="divide-y divide-border/70 border-t border-border">
        {rows.map((r) => (
          <TeamRow key={r.userId} r={r} href={href(r.userId)} showTeam={me.role === 'admin'} number={number} videos={videos} />
        ))}
      </ul>
    </Card>
  );
}

function TeamRow({ r, href, showTeam, number, videos }: { r: TeamVideoProgressRow; href: string; showTeam: boolean; number: Map<number, number>; videos: TeamVideoColumn[] }) {
  const total = r.requiredTotal ?? 0;
  const title = new Map(videos.map((v) => [v.id, v.title]));
  return (
    <li>
      <Link to={href} className="focus-ring-inset group flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
        <Avatar name={r.userName} color={r.avatarColor} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="truncate text-sm font-semibold text-fg">{r.userName}</span>
            {showTeam && r.teamName && <span className="truncate text-xs text-muted">{r.teamName}</span>}
          </span>
          <span className="mt-1 flex items-center gap-3">
            <span className="text-xs tabular text-muted">
              {r.watchedRequired} of {total} watched
            </span>
            <span className="flex flex-wrap gap-1" aria-hidden>
              {(r.cells ?? []).map((c) => (
                <span
                  key={c.videoId}
                  title={`${number.get(c.videoId)}. ${title.get(c.videoId) ?? ''}`}
                  className={clsx(
                    'inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold tabular',
                    c.completedAt ? 'bg-success text-status-fg' : c.watchedS > 0 ? 'bg-primary/30 text-fg' : 'border border-border bg-surface text-muted',
                  )}
                >
                  {number.get(c.videoId)}
                </span>
              ))}
            </span>
          </span>
          <span className="sr-only">
            {(r.cells ?? []).map((c) => `${title.get(c.videoId) ?? 'Video'}: ${c.completedAt ? 'watched' : c.watchedS > 0 ? 'started' : 'not started'}`).join('; ')}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}
