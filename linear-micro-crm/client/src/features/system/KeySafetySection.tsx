// Settings › Backups: the app key and the recovery sheet, off-site copies and server errors (GET /system/status).
// The owner makes the recovery sheet here (a fresh two-step code, a secure connection only), prints it, then confirms
// by typing the last six characters of the key from the paper. The sheet is never cached or kept after the dialog.
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Printer } from 'lucide-react';
import { Badge, Button, Field, Input, Modal, useToast } from '@/components/ui';
import { api } from '@/api/client';
import { apiMessage } from '@/features/common';
import { OneTimeCodeInput, isCompleteCode } from '@/features/settings/OneTimeCodeInput';
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
  canMakeSheet: boolean;
  secure: boolean;
}

interface RecoverySheet {
  madeAt: string;
  key: string;
  fingerprint: string;
  keySource: 'file' | 'env';
  keyFile: string | null;
  dbPath: string;
  backupDir: string;
  offsiteDir: string | null;
  steps: string[];
  warning: string;
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

/** The key, off-site copies, disk and errors, for administrators; the recovery sheet for the owner. */
export function KeySafetySection() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => api<SystemStatus>('/system/status'), staleTime: 60_000 });
  const [open, setOpen] = useState(false);
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
              <span className="text-muted">The key that locks bank details and two-step sign-in is on no paper yet.</span>
            </span>
          )}
        </Row>
        <Row label="Key fingerprint">
          <span className="font-mono text-xs">{s.key.fingerprint ?? '—'}</span>
          <span className="block text-xs text-muted">
            {s.key.inLocalBackups ? 'A copy of the key is kept in the backups folder until the sheet is confirmed.' : 'The backups folder holds no copy of the key.'}
          </span>
        </Row>
        <Row label="Off-site copies" testId="offsite-status">
          {!s.offsite.configured ? (
            <span className="text-muted">Off: backups stay on the server only. Noryn can switch on encrypted off-site copies.</span>
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

      {s.canMakeSheet ? (
        s.secure ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant={sheetDone ? 'outline' : 'primary'} onClick={() => setOpen(true)} leftIcon={<Printer aria-hidden />} data-testid="make-recovery-sheet">
              {sheetDone ? 'Make a new recovery sheet' : 'Make the recovery sheet'}
            </Button>
            <p className="min-w-0 flex-1 text-xs text-muted">Print it and lock it away. You need a code from your authenticator app.</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted" data-testid="sheet-needs-secure">
            To make the recovery sheet, open Linear Hub with its https:// address, or on the server computer itself. It holds the key, so it is never sent over plain Wi-Fi.
          </p>
        )
      ) : (
        !sheetDone && <p className="mt-3 text-xs text-muted">Only the owner can make the recovery sheet.</p>
      )}
      {open && <RecoverySheetModal onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Opens a plain page with only the sheet and prints it (the app around it is not printed). */
function printSheet(sheet: RecoverySheet): boolean {
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return false;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.document.title = 'Linear Hub recovery sheet';
  w.document.body.innerHTML = `
    <div style="font:15px/1.5 system-ui,sans-serif;color:#000;max-width:680px;margin:24px auto">
      <h1 style="font-size:22px;margin:0 0 4px">Linear Hub: recovery sheet</h1>
      <p style="margin:0 0 16px;color:#444">Made ${esc(new Date(sheet.madeAt).toLocaleString('en-GB'))}</p>
      <p style="margin:0 0 6px;font-weight:600">App key (type it exactly; spaces do not matter):</p>
      <p style="font:20px/1.6 ui-monospace,Menlo,monospace;border:2px solid #000;padding:12px;word-break:break-all;margin:0 0 12px">${esc(sheet.key)}</p>
      <p style="margin:0 0 4px">Key fingerprint: <b style="font-family:ui-monospace,Menlo,monospace">${esc(sheet.fingerprint)}</b></p>
      <p style="margin:0 0 4px">${sheet.keySource === 'env' ? 'The server reads the key from LM_APP_SECRET.' : `The server reads the key from: ${esc(sheet.keyFile ?? '')}`}</p>
      <p style="margin:0 0 4px">Database: ${esc(sheet.dbPath)}</p>
      <p style="margin:0 0 4px">Backups folder: ${esc(sheet.backupDir)}</p>
      <p style="margin:0 0 16px">Off-site backups: ${esc(sheet.offsiteDir ?? 'not switched on')}</p>
      <p style="margin:0 0 6px;font-weight:600">What to do:</p>
      <ol style="margin:0 0 16px;padding-left:20px">${sheet.steps.map((x) => `<li style="margin-bottom:6px">${esc(x)}</li>`).join('')}</ol>
      <p style="border-top:1px solid #000;padding-top:8px">${esc(sheet.warning)}</p>
    </div>`;
  w.focus();
  w.print();
  return true;
}

function RecoverySheetModal({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [lastSix, setLastSix] = useState('');
  const [sheet, setSheet] = useState<RecoverySheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const make = useMutation({
    mutationFn: (c: string) => api<{ sheet: RecoverySheet }>('/system/recovery-sheet', { method: 'POST', json: { code: c }, cache: 'no-store' }),
    onSuccess: (r) => {
      setSheet(r.sheet);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['system', 'status'] });
    },
    onError: (err) => {
      setError(apiMessage(err, 'That did not work. Try again with the next code.'));
      setCode('');
    },
  });
  const confirm = useMutation({
    mutationFn: (typed: string) => api<{ confirmedAt: string }>('/system/recovery-sheet/confirm', { method: 'POST', json: { lastSix: typed } }),
    onSuccess: () => {
      toast.success('Recovery sheet confirmed', 'From the next backup on, the backups folder keeps no copy of the key.');
      void queryClient.invalidateQueries({ queryKey: ['system', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'attention'] });
      onClose();
    },
    onError: (err) => setError(apiMessage(err, 'That did not work. Check the sheet and try again.')),
  });

  function submitCode(e?: FormEvent) {
    e?.preventDefault();
    if (isCompleteCode(code) && !make.isPending) make.mutate(code);
  }
  function submitConfirm(e: FormEvent) {
    e.preventDefault();
    if (lastSix.trim().length === 6 && !confirm.isPending) confirm.mutate(lastSix.trim());
  }

  const formId = `${uid}-sheet`;
  if (!sheet) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Make the recovery sheet"
        description="The sheet shows the app key and the steps to get Linear Hub back if the server is lost. Print it, then lock it away like a bank card."
        icon={<KeyRound aria-hidden />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={make.isPending}>Cancel</Button>
            <Button type="submit" form={formId} loading={make.isPending} disabled={!isCompleteCode(code)}>Show the sheet</Button>
          </>
        }
      >
        <form id={formId} onSubmit={submitCode} noValidate>
          <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={error ?? undefined}>
            <OneTimeCodeInput
              id={`${uid}-code`}
              autoFocus
              value={code}
              onChange={(v) => { setCode(v); if (error) setError(null); }}
              onComplete={(c) => make.mutate(c)}
              disabled={make.isPending}
              invalid={!!error}
            />
          </Field>
        </form>
      </Modal>
    );
  }
  return (
    <Modal
      open
      persistent
      onClose={onClose}
      title="Your recovery sheet"
      description="Print it now. Then type the last six characters of the key from the paper, so Linear Hub knows the sheet is safe."
      icon={<KeyRound aria-hidden />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={confirm.isPending}>Close, confirm later</Button>
          <Button type="submit" form={formId} loading={confirm.isPending} disabled={lastSix.trim().length !== 6}>I have printed it</Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="recovery-sheet">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs font-medium text-muted">App key</p>
          <p className="break-all font-mono text-base leading-relaxed text-fg" data-testid="recovery-sheet-key">{sheet.key}</p>
          <p className="mt-1 text-xs text-muted">Fingerprint <span className="font-mono">{sheet.fingerprint}</span></p>
        </div>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg">
          {sheet.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <p className="text-sm text-warning">{sheet.warning}</p>
        <Button
          variant="outline"
          leftIcon={<Printer aria-hidden />}
          onClick={() => {
            if (!printSheet(sheet)) toast.error('The print window was blocked', 'Allow pop-ups for Linear Hub, or copy the key onto paper by hand.');
          }}
        >
          Print
        </Button>
        <form id={formId} onSubmit={submitConfirm} noValidate>
          <Field label="Last six characters of the key, from the paper" htmlFor={`${uid}-last`} error={error ?? undefined}>
            <Input
              id={`${uid}-last`}
              value={lastSix}
              maxLength={6}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => { setLastSix(e.target.value.replace(/\s+/g, '')); if (error) setError(null); }}
              invalid={!!error}
            />
          </Field>
        </form>
      </div>
    </Modal>
  );
}

