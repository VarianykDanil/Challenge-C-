// Release 1.3 slot — OWNED BY P5 learning-videos.
// Settings → Learning videos (admin): whether leaders may add videos, and where the uploaded files are kept (with the
// reminder that the nightly backup copies the database only). Mounted in pages/Settings.tsx in the left column after
// Settings → Integrations, administrators only, in an ErrorBoundary with fallback={null}. Renders a whole Card.
import { Clapperboard, HardDrive } from 'lucide-react';
import { useCurrentUser } from '@/auth/AuthProvider';
import { useSaveVideoSettings, useVideoSettings } from '@/api/videos';
import { Card, CardHeader, Skeleton, Switch, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';
import { SWITCH_HIT_AREA, VIDEO_COPY, formatBytes } from './videoCopy';

export interface VideoSettingsSectionProps {
  className?: string;
}

export function VideoSettingsSection({ className }: VideoSettingsSectionProps) {
  const me = useCurrentUser();
  if (me.role !== 'admin') return null;
  return <VideoSettingsCard className={className} />;
}

function VideoSettingsCard({ className }: VideoSettingsSectionProps) {
  const t = VIDEO_COPY.settings;
  const toast = useToast();
  const q = useVideoSettings();
  const save = useSaveVideoSettings();
  const s = q.data;
  return (
    <Card className={className} data-testid="video-settings">
      <CardHeader icon={<Clapperboard />} title={t.title} description={t.description} />
      {q.isLoading ? (
        <Skeleton lines={3} />
      ) : q.isError || !s ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the video settings" />
      ) : (
        <div className="space-y-4">
          <div className={`rounded-xl border border-border p-4 ${SWITCH_HIT_AREA}`}>
            <Switch
              checked={s.leadersCanAdd}
              disabled={save.isPending}
              label={t.leaders}
              description={t.leadersHint}
              onChange={(on) =>
                save.mutate(
                  { leadersCanAdd: on },
                  {
                    onSuccess: () => toast.success(t.saved(on)),
                    onError: (err) => toast.error('Could not save the setting', errorMessage(err)),
                  },
                )
              }
            />
          </div>
          {s.storage && (
            <div className="flex gap-3 rounded-xl border border-border bg-surface-2/50 p-4">
              <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-fg">{t.storage(s.storage.uploads, formatBytes(s.storage.bytes))}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="video-media-folder">{s.storage.folder}</p>
                <p className="mt-2 text-xs leading-relaxed text-muted">{t.backup}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
