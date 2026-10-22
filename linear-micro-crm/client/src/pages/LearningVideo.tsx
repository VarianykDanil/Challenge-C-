// Release 1.3 — /learning/videos/:id (every staff role) — OWNED BY P5 learning-videos.
// One video: the player (an upload streamed from Linear Hub, or the YouTube / Vimeo / Google Drive player), picking up
// where you left off; your progress (watched at 90%, reported every 15 s, on pause and at the end; "Mark as watched"
// where the player cannot report); what it covers and who it is for; Edit / Delete for whoever may change it; and,
// for administrators, who watched. A video outside your role's audience answers "Video not found".
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ExternalLink, PenLine, RotateCcw, Video } from 'lucide-react';
import {
  VIDEO_AUDIENCE_LABELS,
  VIDEO_COMPLETE_SHARE,
  VIDEO_PROVIDER_LABELS,
  VIDEO_TOPIC_LABELS,
  formatVideoLength,
  videoRequiredFor,
  videoResumeAt,
  type LearningVideo,
} from '@lm/shared';
import { useVideo } from '@/api/videos';
import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, ProgressBar, Skeleton, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';
import { EditVideoModal } from '@/features/videos/EditVideoModal';
import { EmbedPlayer, FilePlayer, type PlayerHandle } from '@/features/videos/VideoPlayer';
import { VideoViewsCard } from '@/features/videos/VideoViewsCard';
import { useVideoStill } from '@/features/videos/useVideoStill';
import { useWatchTracker } from '@/features/videos/useWatchTracker';
import { VIDEO_COPY, formatBytes, formatDay, progressText, videoStatus, watchedByPlaying } from '@/features/videos/videoCopy';
import { COPY } from '@/content/copy';
import { usePageTitle } from '@/lib/usePageTitle';

const back = (
  <Link to="/learning" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10">
    <ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.learning.title}
  </Link>
);

export function LearningVideoPage() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const valid = Number.isInteger(id) && id > 0;
  const q = useVideo(valid ? id : null);
  usePageTitle(q.data?.title ?? COPY.nav.learningVideo.title);

  if (!valid || (q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400))) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={COPY.nav.learningVideo.title} />
        <EmptyState
          icon={<Video aria-hidden />}
          title={VIDEO_COPY.player.missing}
          description={VIDEO_COPY.player.missingBody}
          action={
            <Link to="/learning" className="focus-ring inline-flex h-10 items-center rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-2">
              Back to Learning
            </Link>
          }
        />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={COPY.nav.learningVideo.title} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this video" />
      </>
    );
  }
  if (!q.data) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={<Skeleton className="h-7 w-64 max-w-full" />} />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </>
    );
  }
  return <VideoView key={q.data.id} video={q.data} />;
}

function VideoView({ video }: { video: LearningVideo }) {
  const me = useCurrentUser();
  const navigate = useNavigate();
  const toast = useToast();
  const t = VIDEO_COPY.player;
  const tracker = useWatchTracker(video);
  useVideoStill(video);
  const player = useRef<PlayerHandle>(null);
  // the place to pick up from is fixed when the page opens (the saved position moves as you watch)
  const [resumeAt] = useState(() => videoResumeAt(video.my, video.durationS));
  const [resumedNote, setResumedNote] = useState(resumeAt > 0);
  const [tracking, setTracking] = useState<boolean | null>(null);
  const [fileError, setFileError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);
  const status = videoStatus(video.my);
  const requiredForMe = videoRequiredFor(video, me.role);
  const source = video.kind === 'upload' ? 'Uploaded to Linear Hub' : video.provider ? `${VIDEO_PROVIDER_LABELS[video.provider]} link` : 'Link';
  const canMark = video.kind === 'link' && status !== 'watched' && tracking === false;

  const meta = [VIDEO_TOPIC_LABELS[video.topic], video.durationS ? formatVideoLength(video.durationS) : null, video.audience === 'everyone' ? null : `For ${VIDEO_AUDIENCE_LABELS[video.audience].toLowerCase()}`]
    .filter(Boolean)
    .join(' · ');

  const markWatched = async () => {
    setMarking(true);
    try {
      await tracker.markWatched();
      toast.success(t.marked, video.title);
    } catch (err) {
      toast.error('Could not save it', errorMessage(err));
    } finally {
      setMarking(false);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={back}
        // a video's whole title, wrapped on a phone (the header would cut it to one line)
        title={<span className="block whitespace-normal break-words">{video.title}</span>}
        description={meta}
        actions={
          video.canEdit ? (
            <Button variant="outline" leftIcon={<PenLine aria-hidden />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-4">
          <div className="overflow-hidden rounded-xl border border-border bg-ink shadow-card">
            {video.kind === 'upload' ? (
              <FilePlayer ref={player} video={video} resumeAt={resumeAt} tracker={tracker} onError={() => setFileError(true)} />
            ) : (
              <EmbedPlayer ref={player} video={video} resumeAt={resumeAt} tracker={tracker} onTracking={setTracking} />
            )}
          </div>
          {fileError && (
            <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-fg" role="status">
              {t.fileError}
            </p>
          )}
          {resumedNote && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted" role="status">
              <span>{t.resumed(formatVideoLength(resumeAt))}</span>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-10"
                leftIcon={<RotateCcw aria-hidden />}
                onClick={() => {
                  player.current?.restart();
                  setResumedNote(false);
                }}
              >
                {t.startOver}
              </Button>
            </div>
          )}
          {(video.description || video.example) && (
            <Card>
              <CardHeader title="What it covers" className="mb-2" />
              {video.description && <p className="whitespace-pre-line text-sm leading-relaxed text-fg">{video.description}</p>}
              {video.example && <p className="mt-3 text-xs text-muted">{t.exampleNote}</p>}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <Card data-testid="video-my-progress">
            <CardHeader
              title={t.yourProgress}
              actions={
                status === 'watched' ? (
                  <Badge tone="success" size="sm">
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Watched
                  </Badge>
                ) : requiredForMe ? (
                  <Badge tone="warning" size="sm">Required</Badge>
                ) : undefined
              }
            />
            {status === 'watched' && video.my?.completedAt ? (
              <p className="text-sm text-fg">
                {watchedByPlaying(video.my) ? t.watchedOn(formatDay(video.my.completedAt)) : `${t.marked} on ${formatDay(video.my.completedAt)}`}
              </p>
            ) : video.durationS ? (
              <>
                <ProgressBar
                  value={video.my?.watchedS ?? 0}
                  max={video.durationS}
                  marker={VIDEO_COMPLETE_SHARE}
                  showValue
                  label={status === 'new' ? `Not started · ${formatVideoLength(video.durationS)}` : progressText(video, video.my)}
                  formatValue={(v, m) => `${Math.round((v / m) * 100)}%`}
                />
                <p className="mt-2 text-xs text-muted">{t.countsAt}</p>
              </>
            ) : (
              <p className="text-sm text-muted">{video.kind === 'link' && video.provider === 'drive' ? t.driveNote : video.kind === 'upload' ? t.noLengthUpload : t.noLength}</p>
            )}
            {canMark && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                {video.provider !== 'drive' && <p className="text-xs text-muted">{t.notTracking}</p>}
                {video.provider === 'drive' && video.durationS ? <p className="text-xs text-muted">{t.driveNote}</p> : null}
                <Button variant="soft" className="w-full" loading={marking} leftIcon={<CheckCircle2 aria-hidden />} onClick={() => void markWatched()}>
                  {t.markWatched}
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="About this video" className="mb-3" />
            <dl className="space-y-2 text-sm">
              <Row label="Topic" value={VIDEO_TOPIC_LABELS[video.topic]} />
              <Row label="For" value={VIDEO_AUDIENCE_LABELS[video.audience]} />
              <Row label="Required" value={video.required ? (video.audience === 'everyone' ? 'Yes, for everyone' : `Yes, for ${VIDEO_AUDIENCE_LABELS[video.audience].toLowerCase()}`) : 'No'} />
              <Row label="Length" value={video.durationS ? formatVideoLength(video.durationS) : 'Not known yet'} />
              <Row label="Source" value={video.kind === 'upload' && video.size ? `${source}, ${formatBytes(video.size)}` : source} />
              <Row label="Added" value={`${formatDay(video.createdAt)}${video.createdByName ? ` by ${video.createdByName}` : ''}`} />
            </dl>
            {video.kind === 'link' && video.url && video.provider && (
              <a
                href={video.url}
                target="_blank"
                rel="noreferrer noopener"
                className="focus-ring mt-3 inline-flex min-h-10 items-center gap-1.5 rounded text-sm font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t.openOn(VIDEO_PROVIDER_LABELS[video.provider])}
              </a>
            )}
          </Card>

          {me.role === 'admin' && <VideoViewsCard video={video} />}
        </div>
      </div>
      {video.canEdit && <EditVideoModal video={video} open={editing} onClose={() => setEditing(false)} onDeleted={() => navigate('/learning', { replace: true })} />}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg">{value}</dd>
    </div>
  );
}
