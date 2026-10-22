// Release 1.3 slot — OWNED BY P3 statements. Settings → Integrations (admin), mounted in pages/Settings.tsx after
// Settings → Company, in an ErrorBoundary with fallback={null}. One card:
//  - Gmail: the address and the app password (write-only, stored encrypted), "Check for statements every 15 minutes",
//    Save, Test connection, the last check and the last error in plain words, and how to make an app password;
//  - Statement senders: per campaign, the address(es) its statements come from (only those emails are read).
// The card has id="integrations" so the top box and the statements page can link to /settings#integrations.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, KeyRound, Mail, Plus, Send, X } from 'lucide-react';
import clsx from 'clsx';
import type { StatementSender } from '@lm/shared';
import { useCampaigns } from '@/api/hooks';
import { useMailSettings, useSaveMailSettings, useSaveStatementSenders, useStatementSenders, useTestMail } from '@/api/statements';
import { Badge, Button, Card, CardHeader, Field, Input, Skeleton, Switch, useToast } from '@/components/ui';
import { apiMessage } from '@/features/common/QueryStates';
import { formatDateTime } from '@/lib/format';

export interface IntegrationsSectionProps {
  className?: string;
}

export function IntegrationsSection({ className }: IntegrationsSectionProps) {
  const ref = useRef<HTMLDivElement>(null);
  // /settings#integrations (the top box, the statements page) scrolls here once the card is on the page
  useEffect(() => {
    if (window.location.hash === '#integrations') ref.current?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <div id="integrations" ref={ref} className={clsx('scroll-mt-20', className)}>
      <Card data-testid="integrations-card">
        <CardHeader
          icon={<Mail />}
          title="Integrations"
          description="Commission statements from Gmail: Linear Hub reads the clients' statement emails in your Gmail, read-only, with an app password, and lists them in Finance → Statements."
          actions={
            <Link to="/finance/statements" className="text-xs font-medium text-primary hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center">
              Statements
            </Link>
          }
        />
        <GmailSettings />
        <div className="my-5 border-t border-border" />
        <SenderSettings />
      </Card>
    </div>
  );
}

/* ───────────────────────────── Gmail ───────────────────────────── */

function GmailSettings() {
  const uid = useId();
  const mail = useMailSettings();
  const save = useSaveMailSettings();
  const test = useTestMail();
  const toast = useToast();
  const m = mail.data;
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    if (m) setAddress(m.address ?? '');
  }, [m?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mail.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!m) return <p className="text-sm text-danger">{apiMessage(mail.error, 'Could not load the Gmail settings.')}</p>;

  const dirty = address.trim().toLowerCase() !== (m.address ?? '') || password.trim() !== '';
  const configured = Boolean(m.address && m.hasPassword);

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      { address: address.trim() || null, ...(password.trim() ? { appPassword: password } : {}) },
      {
        onSuccess: () => {
          setPassword('');
          setTestResult(null);
          toast.success('Gmail settings saved', password.trim() ? 'The app password is stored encrypted. Press Test connection to check it.' : undefined);
        },
        onError: (err) => toast.error('Could not save the Gmail settings', apiMessage(err, 'Check the address and the app password.')),
      },
    );
  };
  const onToggle = (enabled: boolean) =>
    save.mutate({ enabled }, {
      onSuccess: () => toast.success(enabled ? 'Gmail is checked every 15 minutes' : 'The automatic check is off'),
      onError: (err) => toast.error('Could not change the check', apiMessage(err, 'Save the address and app password first.')),
    });
  const onRemovePassword = () =>
    save.mutate({ appPassword: '' }, { onSuccess: () => toast.success('App password removed', 'Linear Hub no longer reads your Gmail.'), onError: (err) => toast.error('Could not remove it', apiMessage(err, 'Try again.')) });
  const onTest = () =>
    test.mutate(undefined, {
      onSuccess: (r) => setTestResult(r),
      onError: (err) => setTestResult({ ok: false, message: apiMessage(err, 'Could not test the connection.') }),
    });

  return (
    <section aria-labelledby={`${uid}-gmail`} data-testid="gmail-settings">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 id={`${uid}-gmail`} className="font-sans text-sm font-semibold tracking-normal text-fg">Gmail</h4>
        {configured ? (
          m.lastError && m.enabled ? <Badge tone="danger">Check failing</Badge> : m.enabled ? <Badge tone="success" dot>On</Badge> : <Badge tone="neutral">Off</Badge>
        ) : (
          <Badge tone="neutral">Not connected</Badge>
        )}
        {m.lastCheckAt && <span className="text-xs text-muted">Last checked {formatDateTime(m.lastCheckAt)}</span>}
      </div>
      {m.lastError && (
        <p className="mb-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert" data-testid="mail-error">
          {m.lastError}
        </p>
      )}
      <form onSubmit={onSave} className="grid gap-3 sm:grid-cols-2" noValidate>
        <Field label="Gmail address" hint="The inbox the clients send statements to.">
          <Input type="email" autoComplete="email" inputMode="email" placeholder="matt@gmail.com" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field
          label="App password"
          hint={m.hasPassword ? 'Saved (never shown again). Type a new one to replace it.' : '16 letters from Google. Spaces are fine.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={m.hasPassword ? '•••• •••• •••• ••••' : 'abcd efgh ijkl mnop'}
            leftIcon={<KeyRound />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" disabled={!dirty} loading={save.isPending && dirty}>Save</Button>
          <Button variant="outline" leftIcon={<Send aria-hidden />} disabled={!configured || dirty} loading={test.isPending} onClick={onTest}>
            Test connection
          </Button>
          {m.hasPassword && (
            <Button variant="ghost" onClick={onRemovePassword} disabled={save.isPending}>
              Remove app password
            </Button>
          )}
        </div>
      </form>
      {testResult && (
        <p className={clsx('mt-3 flex items-start gap-2 text-sm', testResult.ok ? 'text-success' : 'text-danger')} role="status" data-testid="mail-test-result">
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{testResult.message}</span>
        </p>
      )}
      <div className="mt-4">
        <Switch
          checked={m.enabled}
          onChange={onToggle}
          disabled={!configured || save.isPending}
          label="Check for statements every 15 minutes"
          description={configured ? 'While Linear Hub is running. Finance → Statements also has Check Gmail now.' : 'Save the address and app password first.'}
        />
      </div>
      <details className="mt-4 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm">
        <summary className="cursor-pointer py-2.5 font-medium text-fg">How to make an app password</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>Sign in to the Google account of this Gmail address.</li>
          <li>Turn on 2-Step Verification (Google account → Security), if it is not on yet. App passwords need it.</li>
          <li>
            Open{' '}
            <a className="inline-flex items-center gap-0.5 text-primary hover:underline max-sm:min-h-10 pointer-coarse:min-h-10" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            , name it “Linear Hub” and press Create.
          </li>
          <li>Copy the 16 letters Google shows into App password above, press Save, then Test connection.</li>
          <li>In Gmail, Settings → See all settings → Forwarding and POP/IMAP: IMAP must be on.</li>
        </ol>
        <p className="mt-2 text-muted">
          Linear Hub only reads emails from the statement senders below, never marks, moves or deletes anything, and keeps the app password encrypted. To stop it,
          press Remove app password, or delete the app password at the same Google page.
        </p>
      </details>
    </section>
  );
}

/* ───────────────────────────── senders ───────────────────────────── */

function SenderSettings() {
  const uid = useId();
  const campaigns = useCampaigns();
  const senders = useStatementSenders();
  const save = useSaveStatementSenders();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const list = senders.data ?? [];
  const shown = (campaigns.data ?? []).filter((c) => c.active || list.some((s) => s.campaignId === c.id));

  const commit = (next: StatementSender[], done: string) =>
    save.mutate(next, {
      onSuccess: () => toast.success(done),
      onError: (err) => toast.error('Could not save the senders', apiMessage(err, 'Check the address.')),
    });
  const add = (campaignId: number) => {
    const address = (drafts[campaignId] ?? '').trim().toLowerCase();
    if (!address) return;
    if (list.some((s) => s.campaignId === campaignId && s.address.toLowerCase() === address)) return;
    commit([...list, { campaignId, address }], `Added ${address}`);
    setDrafts((d) => ({ ...d, [campaignId]: '' }));
  };
  const removeOne = (row: StatementSender) =>
    commit(list.filter((s) => !(s.campaignId === row.campaignId && s.address === row.address)), `Removed ${row.address}`);

  return (
    <section aria-labelledby={`${uid}-senders`} data-testid="sender-settings">
      <h4 id={`${uid}-senders`} className="font-sans text-sm font-semibold tracking-normal text-fg">Statement senders</h4>
      <p className="mt-1 text-xs text-muted">The address each client sends its commission statements from. Only emails from these addresses are read.</p>
      {campaigns.isLoading || senders.isLoading ? (
        <Skeleton className="mt-3 h-24 w-full" />
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {shown.map((c) => {
            const mine = list.filter((s) => s.campaignId === c.id);
            return (
              <li key={c.id} className="py-3" data-testid={`senders-${c.code}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral" dot color={c.color}>{c.code}</Badge>
                  <span className="text-sm text-fg">{c.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {mine.map((s) => (
                    <span key={s.address} className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-xs text-fg ring-1 ring-inset ring-border">
                      <span className="truncate">{s.address}</span>
                      <Button variant="ghost" size="icon-sm" label={`Remove ${s.address}`} onClick={() => removeOne(s)} disabled={save.isPending} className="max-sm:h-10 max-sm:w-10 pointer-coarse:h-10 pointer-coarse:w-10">
                        <X aria-hidden />
                      </Button>
                    </span>
                  ))}
                  {!mine.length && <span className="text-xs text-muted">No sender yet.</span>}
                </div>
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    add(c.id);
                  }}
                >
                  <Input
                    type="email"
                    inputMode="email"
                    size="sm"
                    aria-label={`Add a sender address for ${c.name}`}
                    placeholder="statements@charity.org.uk"
                    value={drafts[c.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                    className="max-sm:h-10 pointer-coarse:h-10"
                  />
                  <Button type="submit" variant="outline" size="sm" leftIcon={<Plus aria-hidden />} disabled={!(drafts[c.id] ?? '').trim() || save.isPending} className="max-sm:h-10 pointer-coarse:h-10">
                    Add
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
