// Release 1.4 — /finance/pay (admin) — OWNED BY F payments-foundation. Finance → Pay people: choose the runs (the
// Runs to pay selection comes along as ?runs=1,2,3), choose a connection, then "Review payment" makes a draft and opens
// its page (pages/PaymentBatch.tsx), where Matt checks the total, the people, the masked accounts and who was left out,
// and approves with a code from his authenticator app. Below: the recent payments. Lazy (App.tsx).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Settings as SettingsIcon, TriangleAlert } from 'lucide-react';
import { PAYMENT_MODE_LABELS, formatPence, payDayLabel, payWeekLabel, poundsToPence, type PaymentConnection, type PaymentProviderView, type PaymentSkip, type PayrollRunWithUser } from '@lm/shared';
import { ApiError } from '@/api/client';
import { usePayroll } from '@/api/hooks';
import { useCreateBatch, usePaymentBatches, usePaymentConnections, usePaymentProviders } from '@/api/payments';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Skeleton, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';
import { invoiceNotAccepted } from '@/features/finance';
import { PaymentBatchStatusBadge, PaymentRunBadge } from '@/features/payments';
import { bankFileFormatLabel } from '@/features/payments/BankFileFormats';
import { ProviderLogo } from '@/features/payments/ProviderLogo';
import { todayISO } from '@/lib/dates';
import { formatNumber } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

const back = (
  <Link to="/finance?tab=company#runs" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10 pointer-coarse:min-h-10">
    <ArrowLeft className="h-3 w-3" aria-hidden /> Finance
  </Link>
);

/** Why a run cannot be picked here (null: it can). */
function blocked(r: PayrollRunWithUser, today: string): string | null {
  if (!(r.weekEnd < today)) return `The week ends on ${payDayLabel(r.weekEnd)}`;
  if (!(r.gross > 0)) return 'Nothing to pay';
  if (r.payment && r.payment.status !== 'failed' && !r.payment.draft) return `In payment #${r.payment.batchId}, on its way`;
  return null;
}

export function PaymentsPayPage() {
  usePageTitle('Pay people');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const today = todayISO();
  const runs = usePayroll({ status: 'pending,failed' });
  const connections = usePaymentConnections();
  const providers = usePaymentProviders();
  const batches = usePaymentBatches();
  const create = useCreateBatch();
  const preset = useMemo(() => new Set((params.get('runs') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)), [params]);
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [skipped, setSkipped] = useState<PaymentSkip[] | null>(null);
  const list = useMemo(() => [...(runs.data ?? [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.userName.localeCompare(b.userName)), [runs.data]);
  const selectable = list.filter((r) => !blocked(r, today));
  const selected = picked ?? new Set(selectable.filter((r) => preset.has(r.id)).map((r) => r.id));
  const chosen = selectable.filter((r) => selected.has(r.id));
  // review fix: the counts leave out what the server will leave out for certain (invoice not accepted or disputed)
  const counted = chosen.filter((r) => !invoiceNotAccepted(r));
  const totalPence = counted.reduce((s, r) => s + poundsToPence(r.gross), 0);
  const usable = (connections.data ?? []).filter((c) => !c.disconnectedAt && c.status === 'connected');
  // review fix: connections that exist but need a (new) test are listed, not "set one up first"
  const untested = (connections.data ?? []).filter((c) => !c.disconnectedAt && c.status !== 'connected');
  const connection = usable.find((c) => c.id === connectionId) ?? (usable.length === 1 ? usable[0] : undefined);
  const info = (c: PaymentConnection) => providers.data?.find((p) => p.id === c.provider);
  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    setPicked(next);
    setSkipped(null);
  };
  const review = () => {
    if (!connection || !chosen.length) return;
    setSkipped(null);
    create.mutate({ connectionId: connection.id, runIds: chosen.map((r) => r.id) }, {
      onSuccess: (b) => navigate(`/finance/pay/batches/${b.id}`),
      onError: (e) => {
        const s = e instanceof ApiError && e.details && typeof e.details === 'object' ? (e.details as { skipped?: PaymentSkip[] }).skipped : undefined;
        if (s?.length) setSkipped(s);
        else toast.error('Could not make the payment', errorMessage(e));
      },
    });
  };

  return (
    <>
      <PageHeader breadcrumbs={back} title="Pay people" description="Pay the runs you choose through one of your payment connections. You check everything before anything is sent, and every payment needs a code from your authenticator app." />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <Card padded={false} className="min-w-0 overflow-clip">
            <div className="flex flex-wrap items-start justify-between gap-3 p-5 pb-3">
              <CardHeader title="1. Who to pay" description="Runs still to pay: pending weeks and failed transfers." className="mb-0" />
              {selectable.length > 0 && (
                <Button size="sm" variant="outline" className="h-10 sm:h-8" onClick={() => { setPicked(chosen.length === selectable.length ? new Set() : new Set(selectable.map((r) => r.id))); setSkipped(null); }}>
                  {chosen.length === selectable.length ? 'Clear the selection' : `Select all ${formatNumber(selectable.length)}`}
                </Button>
              )}
            </div>
            {runs.isLoading ? (
              <div className="space-y-2 p-5 pt-0"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
            ) : runs.isError ? (
              <ErrorState error={runs.error} onRetry={() => void runs.refetch()} className="m-5" />
            ) : !list.length ? (
              <EmptyState title="Everyone is paid up" description="There are no runs to pay." size="sm" className="m-5" />
            ) : (
              <ul className="divide-y divide-border border-t border-border" aria-label="Runs to pay">
                {list.map((r) => {
                  const why = blocked(r, today);
                  const held = invoiceNotAccepted(r);
                  return (
                    <li key={r.id}>
                      <label className={`flex min-h-14 items-center gap-3 px-5 py-2.5 ${why ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-2/60'}`}>
                        <input
                          type="checkbox"
                          className="focus-ring h-5 w-5 shrink-0 cursor-pointer rounded border-control-border accent-[var(--color-primary)] disabled:cursor-not-allowed"
                          checked={!why && selected.has(r.id)}
                          disabled={!!why}
                          onChange={(e) => toggle(r.id, e.target.checked)}
                          aria-label={`Pay ${r.userName}, ${payWeekLabel(r.weekStart)}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">{r.userName}</span>
                          <span className="block text-xs text-muted">
                            {payWeekLabel(r.weekStart)}
                            {r.status === 'failed' ? ' · failed transfer' : ''}
                            {why ? ` · ${why}` : held ? (r.invoice?.status === 'disputed' ? ' · invoice disputed (left out)' : ' · invoice not accepted yet (left out)') : ''}
                            {r.payment?.status === 'failed' && r.payment.failureReason ? ` · last payment failed: ${r.payment.failureReason}` : ''}
                          </span>
                          {/* review fix: a run already in a draft is left out of a new one (the server says "Already in payment #N") */}
                          {r.payment?.draft && <span className="mt-1 block"><PaymentRunBadge payment={r.payment} /></span>}
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">{formatPence(poundsToPence(r.gross))}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* phones and tablets: the total and the next step stay in reach while ticking a long list */}
            {chosen.length > 0 && (
              <div className="sticky bottom-0 z-20 flex items-center gap-3 border-t border-border bg-surface/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-pop backdrop-blur-md sm:px-5 xl:hidden" data-pay-bar="">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block font-medium text-fg">{formatNumber(counted.length)} {counted.length === 1 ? 'run' : 'runs'} · <span className="tabular-nums">{formatPence(totalPence)}</span></span>
                  {!connection && <span className="block text-xs text-muted">Choose how to pay below</span>}
                </span>
                {connection ? (
                  <Button className="h-10 shrink-0" loading={create.isPending} rightIcon={<ArrowRight aria-hidden />} onClick={review}>Review payment</Button>
                ) : (
                  <Button variant="outline" className="h-10 shrink-0" onClick={() => document.getElementById('how-to-pay')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>How to pay</Button>
                )}
              </div>
            )}
          </Card>
          {skipped && (
            <Card tone="warning" role="alert" data-skipped="">
              <CardHeader title="None of these can be paid this way" icon={<TriangleAlert aria-hidden />} description="Nothing was made. Here is why each one was left out:" />
              <ul className="space-y-1.5 text-sm">
                {skipped.map((s) => <li key={s.runId}><span className="font-medium text-fg">{s.userName ?? `Run ${s.runId}`}</span>{s.weekStart ? `, ${payWeekLabel(s.weekStart)}` : ''}: <span className="text-muted">{s.reason}</span></li>)}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Card id="how-to-pay" className="scroll-mt-20">
            <CardHeader title="2. How to pay" />
            {connections.isLoading ? <Skeleton className="h-16" /> : !usable.length ? (
              <div className="space-y-3 text-sm text-muted">
                {untested.length ? (
                  <UntestedList connections={untested} info={info} />
                ) : (
                  <p>Set up a way to pay first: a bank payment file, Revolut Business, Wise Business or Open Banking through TrueLayer.</p>
                )}
                <Link to="/settings#payments" className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg shadow-card hover:bg-primary-hover">
                  <SettingsIcon className="h-4 w-4" aria-hidden /> Open Settings → Payments
                </Link>
              </div>
            ) : (
              <div role="radiogroup" aria-label="How to pay" className="grid gap-2">
                {usable.map((c) => {
                  const p = info(c);
                  const on = connection?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => { setConnectionId(c.id); setSkipped(null); }}
                      className={`flex min-h-14 items-center gap-3 rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-2'}`}
                    >
                      <ProviderLogo iconKey={p?.iconKey ?? 'bank'} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">{c.name}</span>
                        <span className="block text-xs text-muted">{p?.kind === 'file' ? (bankFileFormatLabel(c.settings) ?? 'Bank payment file') : PAYMENT_MODE_LABELS[c.mode]}{p && !p.available ? ' · not switched on in this version yet' : ''}</span>
                      </span>
                      {(p?.kind === 'api' || p?.testOnly) && c.mode === 'test' && <Badge tone="info" size="sm">Test</Badge>}
                    </button>
                  );
                })}
                {/* review fix (UI-8): a connection that needs a (new) test stays listed, greyed, below the ones that work */}
                {untested.length > 0 && <UntestedList connections={untested} info={info} className="mt-1" />}
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="3. Review" />
            <dl className="mb-4 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">People</dt><dd className="tabular-nums text-fg">{formatNumber(new Set(counted.map((r) => r.userId)).size)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Runs</dt><dd className="tabular-nums text-fg">{formatNumber(counted.length)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Total before checks</dt><dd className="font-semibold tabular-nums text-fg">{formatPence(totalPence)}</dd></div>
            </dl>
            {chosen.length > counted.length && (
              <p className="mb-3 text-xs text-muted" data-not-counted="">
                {formatNumber(chosen.length - counted.length)} ticked {chosen.length - counted.length === 1 ? 'run is' : 'runs are'} not counted: the invoice is not accepted yet or is disputed.
              </p>
            )}
            <Button className="h-10 w-full" disabled={!connection || !chosen.length} loading={create.isPending} rightIcon={<ArrowRight aria-hidden />} onClick={review}>
              Review payment
            </Button>
            <p className="mt-2 text-xs text-muted">Nothing is sent yet: the next page shows who is paid, to which account, and who is left out (for example anyone without bank details).</p>
          </Card>
          <RecentPayments loading={batches.isLoading} rows={batches.data ?? []} iconFor={(provider) => providers.data?.find((p) => p.id === provider)?.iconKey ?? 'bank'} kindFor={(provider) => providers.data?.find((p) => p.id === provider)?.kind} />
        </div>
      </div>
    </>
  );
}

/** Connections that exist but need a (new) test: listed, not selectable, with what to do. */
function UntestedList({ connections, info, className }: { connections: PaymentConnection[]; info: (c: PaymentConnection) => PaymentProviderView | undefined; className?: string }) {
  return (
    <ul className={`grid gap-2 ${className ?? ''}`} aria-label="Connections to test first" data-untested="">
      {connections.map((c) => (
        <li key={c.id} className="flex min-h-14 items-center gap-3 rounded-lg border border-dashed border-border p-3 opacity-80" aria-disabled="true">
          <ProviderLogo iconKey={info(c)?.iconKey ?? 'bank'} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-fg">{c.name}</span>
            <span className="block text-xs text-muted">Test it in Settings → Payments first{c.status === 'error' && c.lastError ? `. Last time: ${c.lastError}` : ''}</span>
          </span>
          {info(c)?.kind === 'api' && c.mode === 'test' && <Badge tone="info" size="sm">Test</Badge>}
        </li>
      ))}
    </ul>
  );
}

function RecentPayments({ loading, rows, iconFor, kindFor }: { loading: boolean; rows: import('@lm/shared').PaymentBatchSummary[]; iconFor: (p: string) => string; kindFor: (p: string) => 'file' | 'api' | undefined }) {
  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="p-5 pb-3"><CardHeader title="Recent payments" className="mb-0" /></div>
      {loading ? <div className="p-5 pt-0"><Skeleton className="h-12" /></div> : !rows.length ? (
        <p className="px-5 pb-5 text-sm text-muted">No payments made from Linear Hub yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.slice(0, 10).map((b) => (
            <li key={b.id}>
              <Link to={`/finance/pay/batches/${b.id}`} className="focus-ring-inset flex min-h-14 items-center gap-3 px-5 py-2.5 hover:bg-surface-2/60">
                <ProviderLogo iconKey={iconFor(b.provider)} size="sm" />
                <span className="min-w-0 flex-1">
                  {/* review fix: both lines wrap rather than cutting off the amount or the date */}
                  <span className="block text-sm font-medium text-fg">Payment #{b.id} · {formatPence(b.totalPence)}</span>
                  <span className="block text-xs text-muted">{b.connectionName} · {formatNumber(b.count)} {b.count === 1 ? 'payment' : 'payments'} · {payDayLabel(b.createdAt.slice(0, 10))}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {/* review fix (UI-2): nothing reached the provider yet → "Waiting to send", not "Sent" */}
                  <PaymentBatchStatusBadge status={b.status} kind={kindFor(b.provider)} mode={b.mode} allQueued={!!b.queuedCount && b.queuedCount === b.paidCount + b.failedCount + b.waitingCount} />
                  {b.mode === 'test' && <Badge tone="info" size="sm">Test</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
