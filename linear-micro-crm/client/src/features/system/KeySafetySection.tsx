// Settings › Backups: the app key and the recovery sheet, off-site copies and server errors (GET /system/status).
// The recovery sheet itself is made and confirmed on the server computer only, so the key never reaches a browser:
// this section shows whether it is done and what happens next, in plain words.
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui';
import { api } from '@/api/client';
import { formatDateTime, formatRelative } from '@/lib/format';

export interface SystemStatus {
  key: {
    fingerprint: string | null;
    source: 'file' | 'env' | null;
    sheetMadeAt: string | null;
    sheetConfirmedAt: string | null;
    confirmedForThisKey: boolean;
    inLocalBackups: boolean;
  };
  offsite: { configured: boolean; dir: string | null; lastAt: string | null; file: string | null; error: string | null; errorAt: string | null; problem: string | null };
  backupFailure: { at: string; message: string } | null;
  files: { includeVideos: boolean };
  disk: { freeBytes: number; totalBytes: number } | null;
  serverErrors24h: number;
  errorLog: string | null;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col border-b border-border pb-2" data-testid={testId}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

/** The key, off-site copies, disk and errors, for administrators. */
export function KeySafetySection() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => api<SystemStatus>('/system/status'), staleTime: 60_000 });
  const s = q.data;
  if (!s) return null;
  const sheetDone = s.key.confirmedForThisKey;
  return (
    <section className="mt-5 border-t border-border pt-4" aria-labelledby="key-safety-title" data-testid="key-safety">
      <h3 id="key-safety-title" className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden />
        App key and recovery
      </h3>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Row label="Recovery sheet" testId="key-sheet-status">
          {sheetDone ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone="success" dot>Printed and kept</Badge>
              <span className="text-muted">{formatDateTime(s.key.sheetConfirmedAt!)}</span>
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone="warning" dot>Not done yet</Badge>
              <span className="text-muted">The key that locks bank details and two-step sign-in is not on paper yet.</span>
            </span>
          )}
        </Row>
        <Row label="Key fingerprint">
          <span className="font-mono text-xs">{s.key.fingerprint ?? '—'}</span>
          <span className="block text-xs text-muted">
            {s.key.inLocalBackups ? 'A copy of the key is kept in the backups folder until the sheet is checked.' : 'The backups folder holds no copy of the key.'}
          </span>
        </Row>
        <Row label="Off-site copies" testId="offsite-status">
          {!s.offsite.configured ? (
            <span className="text-muted">Off: backups stay on the server only. Noryn can switch on locked copies in a second place.</span>
          ) : s.offsite.problem || s.offsite.error ? (
            <span className="text-danger">{s.offsite.problem ?? s.offsite.error}</span>
          ) : s.offsite.lastAt ? (
            <>
              Last copy {formatRelative(s.offsite.lastAt)}
              <span className="block break-all font-mono text-xs text-muted">{s.offsite.dir}</span>
            </>
          ) : (
            <span className="text-muted">On. The first copy is made with the next backup.</span>
          )}
        </Row>
        <Row label="Server health">
          {s.backupFailure ? <span className="block text-danger">The last backup failed {formatRelative(s.backupFailure.at)}.</span> : null}
          {s.serverErrors24h ? (
            <span className="block text-warning">
              {s.serverErrors24h} server error{s.serverErrors24h === 1 ? '' : 's'} in the last 24 hours{s.errorLog ? ` (details in ${s.errorLog} in the data folder)` : ''}.
            </span>
          ) : (
            <span className="block">No server errors in the last 24 hours.</span>
          )}
          {s.disk ? <span className="block text-xs text-muted">{gb(s.disk.freeBytes)} free on the server's disk.</span> : null}
        </Row>
      </dl>

      <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-sm text-fg" data-testid="sheet-how">
        {sheetDone ? (
          <p>The key is on paper and locked away. If the sheet is lost, ask Noryn to make a new one with the owner.</p>
        ) : (
          <>
            <p className="font-medium">How the recovery sheet is made</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted">
              <li>Noryn makes it with the owner, on the computer that runs Linear Hub. The key never travels over the network.</li>
              <li>The owner prints it and locks it away, like a bank card.</li>
              <li>The owner types the key back in once, from the paper, to check it. Then this says “Printed and kept”.</li>
            </ol>
            <p className="mt-1.5 text-xs text-muted">Until then, the backups folder keeps a copy of the key, so nothing can be lost.</p>
          </>
        )}
      </div>
    </section>
  );
}
