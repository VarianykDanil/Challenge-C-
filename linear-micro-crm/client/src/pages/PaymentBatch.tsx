// Release 1.4 — /finance/pay/batches/:id (admin) — OWNED BY F payments-foundation. One payment from Linear Hub:
//  - a draft: the review (total, people, masked accounts, who was left out and why), then the code from the admin's
//    authenticator app and "Approve and pay £X" (or "Approve and make the bank file"); Cancel;
//  - once approved: each person's status, live while anything is on its way (the page refreshes every 10 seconds and
//    "Check now" asks the provider at once); for a bank file, Download the file and Mark as paid (untick the ones the
//    bank rejected, with a reason). Lazy (App.tsx).
// Package A: for an API provider the page says what the provider still needs from Matt (its `approveNote` on the
// Approve card, its `waitingNote` while payments are on their way): Wise only creates the transfers, Matt funds them in
// Wise, so its Approve button says "create the transfers" rather than "pay".
// Before approving, "Check before paying" lists days waiting for a leader (not in this pay), pay resting on subs no client
// statement confirmed, and bonuses or adjustments added in the last 7 days and by whom. With "Two people approve each
// payment" on, a live payment needs a second administrator. A downloaded bank file counts as sent: cancelling it, or
// marking someone not paid, needs NOT UPLOADED / NOT PAID typed and a fresh code, and a cancelled one is void.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, Download, Info, RefreshCw, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import {
  FILE_NOT_PAID_CONFIRMATION, FILE_NOT_UPLOADED_CONFIRMATION, approvalOutcome, formatPence, isTypedConfirmation, payDayLabel, payMoney, payWeekLabel,
  poundsToPence, type PaymentBatch, type PaymentItem, type PaymentProviderView,
} from '@lm/shared';
import { ApiError } from '@/api/client';
import { paymentFileUrl, paymentKeys, useApproveBatch, useCancelBatch, useMarkBatchPaid, usePaymentBatch, usePaymentProviders, useRefreshBatch } from '@/api/payments';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, CardHeader, Field, Input, KpiTile, PageHeader, Skeleton, useToast } from '@/components/ui';
import { ConfirmDialog, ErrorState, apiMessage, errorMessage } from '@/features/common';
import { PaymentBatchStatusBadge, PaymentItemStatusBadge } from '@/features/payments';
import { BankFileHelp } from '@/features/payments/BankFileFormats';
import { ProviderLogo } from '@/features/payments/ProviderLogo';
import { todayISO } from '@/lib/dates';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';

const back = (
  <Link to="/finance/pay" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10 pointer-coarse:min-h-10">
    <ArrowLeft className="h-3 w-3" aria-hidden /> Pay people
  </Link>
);

const people = (n: number) => `${formatNumber(n)} ${n === 1 ? 'person' : 'people'}`;

/** Review fix: "People" counts people — someone paid for two weeks is one person with two payments. */
const personCount = (b: Pick<PaymentBatch, 'items'>) => new Set(b.items.map((i) => i.userId)).size;

/** Review fix (UI-2): nothing in this approved payment has reached the provider yet (every live item still queued). */
function allQueued(b: Pick<PaymentBatch, 'items' | 'status'>): boolean {
  const live = b.items.filter((i) => i.status !== 'cancelled');
  return b.status !== 'draft' && live.length > 0 && live.every((i) => i.status === 'queued');
}

/** Review fix (UI-12): "the Wise sandbox", never "Wise Business's sandbox". */
const SANDBOX: Record<string, string> = { revolut: 'the Revolut sandbox', wise: 'the Wise sandbox', truelayer: 'the TrueLayer sandbox' };
const sandboxName = (provider: string, providerName: string) => SANDBOX[provider] ?? `the ${providerName} sandbox`;

/** "3 people" or, when someone has more than one week in it, "4 payments for 3 people". */
function whoText(b: Pick<PaymentBatch, 'items' | 'count'>): string {
  const n = personCount(b);
  return n === b.count ? people(n) : `${formatNumber(b.count)} payments for ${people(n)}`;
}

export function PaymentBatchPage() {
  const { id } = useParams();
  const batchId = Number(id);
  usePageTitle(Number.isInteger(batchId) ? `Payment #${batchId}` : 'Payment');
  const q = usePaymentBatch(Number.isInteger(batchId) && batchId > 0 ? batchId : null, { poll: true });
  const providers = usePaymentProviders();
  if (!Number.isInteger(batchId) || batchId <= 0 || (q.error instanceof ApiError && q.error.status === 404)) return <NotFoundPage />;
  const b = q.data;
  const provider = b ? providers.data?.find((p) => p.id === b.provider) : undefined;
  return (
    <>
      <PageHeader
        breadcrumbs={back}
        title={b ? <span className="flex flex-wrap items-center gap-3"><ProviderLogo iconKey={provider?.iconKey ?? 'bank'} size="md" />Payment #{b.id}</span> : <Skeleton className="h-9 w-56" />}
        description={b ? (
          <span className="flex flex-wrap items-center gap-2">
            <PaymentBatchStatusBadge status={b.status} kind={b.kind} mode={b.mode} allQueued={allQueued(b)} />
            {(b.kind === 'api' || b.mode === 'test') && <Badge tone={b.mode === 'live' ? 'danger' : 'info'}>{b.mode === 'live' ? 'Live: real money' : 'Test mode: nobody is paid'}</Badge>}
            <span>{b.connectionName} · made {payDayLabel(b.createdAt.slice(0, 10))}{b.createdByName ? ` by ${b.createdByName}` : ''}{b.approvedAt ? ` · approved ${formatDateTime(b.approvedAt)}${b.approvedByName ? ` by ${b.approvedByName}` : ''}` : ''}</span>
          </span>
        ) : undefined}
      />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !b ? (
        <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
      ) : (
        <BatchBody b={b} provider={provider} providerName={provider?.name ?? b.connectionName} available={provider?.available ?? false} />
      )}
    </>
  );
}

function BatchBody({ b, provider, providerName, available }: { b: PaymentBatch; provider?: PaymentProviderView; providerName: string; available: boolean }) {
  const uid = useId();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefreshBatch();
  const cancel = useCancelBatch();
  const [confirmCancel, setConfirmCancel] = useState(false);
  // MON-2: after a download, cancelling (or making a freed 1.4.0 file void) needs NOT UPLOADED typed and a fresh code
  const [typed, setTyped] = useState('');
  const [cancelCode, setCancelCode] = useState('');
  const needsTyped = !!b.actions.cancelNeedsConfirmation || !!b.actions.voidable;
  const typedOk = !needsTyped || (isTypedConfirmation(typed, FILE_NOT_UPLOADED_CONFIRMATION) && cancelCode.replace(/\s+/g, '').length === 6);
  const draft = b.status === 'draft';
  // (a bank file is in test mode only for the test bank file, which pays nobody either)
  const test = b.mode === 'test';
  const persons = personCount(b);
  const peopleHint = [persons !== b.count ? `${formatNumber(b.count)} payments` : '', b.skipped.length ? `${formatNumber(b.skipped.length)} left out` : ''].filter(Boolean).join(' · ');
  // review fix: a bank file just made is waiting for Matt's bank, not on its way
  const fourth = draft ? 'To approve' : b.failedCount ? 'Failed' : b.kind === 'file' ? 'In the file' : allQueued(b) ? 'Waiting to send' : 'On the way';
  const queued = b.items.some((i) => i.status === 'queued');
  // review fix (UI-1): what the bank file holds — a line the bank format refused is not in it (no file reference). Review
  // fix (money:4): a line cancelled later is still in the file, so it counts (the server's download audit does the same)
  const inFilePence = b.kind === 'file' && !draft ? b.items.filter((i) => i.providerRef).reduce((sum, i) => sum + i.amountPence, 0) : null;
  // review fix (UI-2): the provider's note about payments on their way, only once one really is (and never in test mode)
  const sentSome = b.items.some((i) => i.status === 'submitted' || i.status === 'processing');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Total" value={formatPence(b.totalPence)} tone="primary" hint={inFilePence !== null && inFilePence !== b.totalPence ? `In the file ${formatPence(inFilePence)}` : undefined} />
        <KpiTile label="People" value={formatNumber(persons)} hint={peopleHint || undefined} />
        <KpiTile label={test ? 'Test, not paid' : 'Paid'} value={formatNumber(b.paidCount)} tone={b.paidCount && !test ? 'success' : 'default'} />
        <KpiTile label={fourth} value={formatNumber(draft ? b.waitingCount : b.failedCount || b.waitingCount)} tone={b.failedCount ? 'danger' : 'default'} />
      </div>

      {b.lastError && (
        <Card tone="danger" role="alert">
          <p className="flex items-start gap-2 text-sm text-fg"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
            {/* review fix: one full stop, and only a promise Linear Hub keeps (it resends queued payments with the same references) */}
            <span>{b.lastError.trim().replace(/\.+$/, '')}.{b.kind === 'api' && queued && b.actions.refresh ? ` Linear Hub sends them again with the same references, so ${b.connectionName} does not make them twice.` : ''}</span>
          </p>
        </Card>
      )}

      {b.voidedAt ? (
        <Card tone="warning" data-file-void="">
          <p className="flex items-start gap-2 text-sm text-fg"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>Void: {b.voidedByName ?? 'an administrator'} confirmed on {payDayLabel(b.voidedAt.slice(0, 10))} that this file was not uploaded to the bank{b.voidReason ? ` (${b.voidReason.replace(/\.$/, '')})` : ''}. Do not upload it: its weeks can be paid again.</span>
          </p>
        </Card>
      ) : b.kind === 'file' && b.mode === 'live' && b.downloadedAt ? (
        <Card tone="info" data-file-downloaded="">
          <p className="flex items-start gap-2 text-sm text-fg"><Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
            <span>
              Downloaded {formatDateTime(b.downloadedAt)}{b.downloadedByName ? ` by ${b.downloadedByName}` : ''}, so its people count as sent.
              {b.actions.voidable
                ? ' Its weeks were freed without saying the file was not uploaded, so a new file for them is refused for 7 days. If you did not upload it, confirm that now.'
                : ' If you did not upload it to your bank, cancel it with the words NOT UPLOADED and your code: the file becomes void.'}
            </span>
          </p>
          {b.actions.voidable && <Button size="sm" variant="outline" className="mt-3 h-10" onClick={() => setConfirmCancel(true)}>Confirm it was not uploaded</Button>}
        </Card>
      ) : null}

      {draft && <ChecksCard b={b} />}

      {draft && <ApproveCard b={b} provider={provider} providerName={providerName} available={available} />}

      {!draft && b.kind === 'api' && b.mode === 'live' && sentSome && provider?.waitingNote && (
        <Card tone="info" data-waiting-note="">
          <p className="flex items-start gap-2 text-sm text-fg"><Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
            <span>{provider.waitingNote}</span>
          </p>
        </Card>
      )}

      <Card padded={false} className="min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 p-5 pb-3">
          <CardHeader title={draft ? 'Who is paid' : 'Payments'} description={draft ? 'Check the names, accounts and amounts.' : b.kind === 'api' && b.waitingCount ? 'This page updates by itself while payments are on their way.' : undefined} className="mb-0" />
          <div className="flex flex-wrap gap-2">
            {b.actions.download && (
              <a
                href={paymentFileUrl(b.id)}
                className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg shadow-card hover:bg-primary-hover sm:h-8 sm:px-3"
                download
                // the download is recorded (MON-2): show it once the server has it
                onClick={() => window.setTimeout(() => void qc.invalidateQueries({ queryKey: paymentKeys.batch(b.id) }), 1500)}
              >
                <Download className="h-4 w-4" aria-hidden /> {b.mode === 'test' ? 'Download the TEST file' : 'Download the bank file'}
              </a>
            )}
            {b.actions.refresh && (
              <Button size="sm" variant="outline" className="h-10 sm:h-8" loading={refresh.isPending} leftIcon={<RefreshCw aria-hidden />}
                onClick={() => refresh.mutate({ id: b.id }, { onError: (e) => toast.error('Could not check', errorMessage(e)) })}>
                Check now
              </Button>
            )}
            {b.actions.cancel && (
              <Button size="sm" variant="ghost" className="h-10 text-danger sm:h-8" leftIcon={<X aria-hidden />} onClick={() => setConfirmCancel(true)}>
                {draft ? 'Cancel draft' : 'Cancel the rest'}
              </Button>
            )}
            {/* review fix (UI-9): shown, but waiting, while Linear Hub does not know whether the provider made them —
                only when Check now can bring it back (review fix SD-1: the provider can stop a payment, Wise) */}
            {!b.actions.cancel && b.actions.cancelBlocked && b.actions.cancelWaits && (
              <Button size="sm" variant="ghost" className="h-10 sm:h-8" leftIcon={<X aria-hidden />} disabled aria-describedby={`cancel-blocked-${b.id}`}>
                Cancel the rest
              </Button>
            )}
          </div>
          {!b.actions.cancel && b.actions.cancelBlocked && <p id={`cancel-blocked-${b.id}`} className="w-full text-xs text-muted" data-cancel-blocked="">{b.actions.cancelBlocked}</p>}
        </div>
        {/* Release 1.4 (P): which bank file this is and where to upload it */}
        {b.kind === 'file' && b.status !== 'cancelled' && <BankFileHelp connectionId={b.connectionId} className="mx-5 mb-4" />}
        <ItemList items={b.items} draft={draft} kind={b.kind} mode={b.mode} />
      </Card>

      {b.actions.markPaid && <MarkPaidCard b={b} />}

      {b.skipped.length > 0 && (
        <Card>
          <CardHeader title="Left out" description="These selected runs are not in this payment. They stay on Runs to pay." />
          <ul className="space-y-2 text-sm" data-left-out="">
            {b.skipped.map((s) => (
              <li key={s.runId} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0 sm:flex-row sm:justify-between sm:gap-4">
                <span className="font-medium text-fg">{s.userName ?? `Run ${s.runId}`}{s.weekStart ? <span className="font-normal text-muted"> · {payWeekLabel(s.weekStart)}</span> : null}</span>
                <span className="text-muted sm:text-right">{s.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={b.actions.voidable ? `Make bank file #${b.id} void?` : draft ? `Cancel draft payment #${b.id}?` : `Cancel what is left of payment #${b.id}?`}
        description={draft ? 'Nothing has been sent. The runs stay on Runs to pay.' : needsTyped
          ? `This file was downloaded, so it may already be at your bank. Only go on if you did NOT upload it. Its weeks go back to Runs to pay and the file is void: never upload it afterwards.`
          : b.kind === 'file' ? 'Only do this if you did not upload the file to your bank (or the bank did not pay them). Those runs stay unpaid on Runs to pay.' : `Linear Hub asks ${b.connectionName} to stop the payments it has not paid yet. Any it is already paying stay on their way.`}
        confirmLabel={needsTyped ? 'Make it void' : draft ? 'Cancel draft' : 'Cancel them'}
        tone="danger"
        loading={cancel.isPending}
        onConfirm={() => {
          if (!typedOk) return toast.error(`Type ${FILE_NOT_UPLOADED_CONFIRMATION} and your code`, 'Both are needed once a bank file has been downloaded.');
          cancel.mutate({ id: b.id, body: needsTyped ? { confirm: typed.trim(), code: cancelCode.replace(/\s+/g, '') } : {} }, {
          onSuccess: (next) => {
            setConfirmCancel(false);
            setTyped('');
            setCancelCode('');
            if (draft) return toast.success('Draft cancelled', 'The runs stay on Runs to pay.');
            if (next.voidedAt) return toast.success('The file is void', 'Its weeks are back on Runs to pay. Do not upload it.');
            // review fix: say what actually stopped, and what is still on its way
            const was = new Set(b.items.filter((i) => i.status === 'queued' || i.status === 'submitted' || i.status === 'processing').map((i) => i.id));
            const stopped = next.items.filter((i) => was.has(i.id) && (i.status === 'cancelled' || i.status === 'failed')).length;
            const still = next.waitingCount;
            if (!stopped) return toast.error('Nothing was stopped', `${formatNumber(still)} still on the way: ${next.connectionName} is already paying ${still === 1 ? 'it' : 'them'}.`);
            toast.success(`Stopped ${formatNumber(stopped)} ${stopped === 1 ? 'payment' : 'payments'}`, still
              ? `${formatNumber(still)} still on the way: ${next.connectionName} is already paying ${still === 1 ? 'it' : 'them'}. The stopped weeks stay on Runs to pay.`
              : 'Those weeks stay on Runs to pay.');
          },
          onError: (e) => toast.error('Could not cancel', errorMessage(e)),
          });
        }}
      >
        {needsTyped && (
          <div className="space-y-3">
            <Field label={`Type ${FILE_NOT_UPLOADED_CONFIRMATION} to confirm`} htmlFor={`${uid}-typed`}>
              <Input id={`${uid}-typed`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
            </Field>
            <Field label="Code from your authenticator app" htmlFor={`${uid}-ccode`}>
              <Input id={`${uid}-ccode`} value={cancelCode} onChange={(e) => setCancelCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono" />
            </Field>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * When an item was paid: a bank file's is the day chosen in Mark as paid; a test item (a sandbox, or the test bank
 * file: review fix SD-4) was never paid at all.
 */
function paidText(i: PaymentItem, kind: 'file' | 'api', mode: PaymentBatch['mode']): string {
  if (i.status !== 'paid' || !i.paidAt) return '';
  if (mode === 'test') return '';
  if (kind === 'file' && i.runPaidDate) return ` · paid ${payDayLabel(i.runPaidDate)} · marked ${formatDateTime(i.paidAt)}`;
  return ` · paid ${formatDateTime(i.paidAt)}`;
}

function ItemList({ items, draft, kind, mode }: { items: PaymentItem[]; draft: boolean; kind: 'file' | 'api'; mode: PaymentBatch['mode'] }) {
  if (!items.length) return <p className="px-5 pb-5 text-sm text-muted">Nobody is in this payment.</p>;
  return (
    <ul className="divide-y divide-border border-t border-border" aria-label="People in this payment">
      {items.map((i) => (
        <li key={i.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4" data-item={i.status}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{i.userName}</span>
            <span className="block text-xs text-muted">
              {payWeekLabel(i.weekStart)} · to {i.payeeName}, account <span className="font-mono">••••{i.accountLast4}</span>
              {/* Release 1.4 (P): a bank file line's reference, to find it on the bank statement */}
              {kind === 'file' && i.providerRef ? <> · reference <span className="font-mono">{i.providerRef}</span></> : null}
              {paidText(i, kind, mode)}
            </span>
            {i.checks && (i.checks.daysWaiting > 0 || i.checks.unconfirmed) && (
              <span className="mt-0.5 flex flex-wrap gap-1.5" data-item-checks="">
                {i.checks.daysWaiting > 0 && <Badge tone="warning" size="sm">{formatNumber(i.checks.daysWaiting)} {i.checks.daysWaiting === 1 ? 'day' : 'days'} waiting for a leader</Badge>}
                {i.checks.unconfirmed && <Badge tone="warning" size="sm">{payMoney(i.checks.unconfirmed.amount)} on {formatNumber(i.checks.unconfirmed.subs)} unconfirmed {i.checks.unconfirmed.subs === 1 ? 'sub' : 'subs'}</Badge>}
              </span>
            )}
            {i.failureReason && <span className="block text-xs text-danger">{i.failureReason}</span>}
            {i.note && <span className="block text-xs text-warning">{i.note}</span>}
            {/* MON-2: this week was in an earlier downloaded file that was let go; check the bank did not pay that one */}
            {i.earlierFile && (
              <span className="block text-xs text-warning" data-earlier-file={i.earlierFile.batchId}>
                Also in bank file <Link to={`/finance/pay/batches/${i.earlierFile.batchId}`} className="underline underline-offset-2">payment #{i.earlierFile.batchId}</Link>, downloaded {payDayLabel(i.earlierFile.downloadedAt.slice(0, 10))}{i.earlierFile.downloadedByName ? ` by ${i.earlierFile.downloadedByName}` : ''}{i.earlierFile.voidedAt ? ' and marked as not uploaded' : ' and then let go'}. Check your bank did not pay it{i.earlierFile.copies > 1 ? ` (${i.earlierFile.copies} earlier files)` : ''}: this file's reference ends in {i.earlierFile.copies + 1} so your bank can tell them apart.
              </span>
            )}
          </span>
          <span className="flex items-center gap-3 sm:justify-end">
            {!draft && <PaymentItemStatusBadge status={i.status} kind={kind} mode={mode} />}
            <span className="text-sm font-semibold tabular-nums text-fg">{formatPence(i.amountPence)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ApproveCard({ b, provider, providerName, available }: { b: PaymentBatch; provider?: PaymentProviderView; providerName: string; available: boolean }) {
  const uid = useId();
  const me = useCurrentUser();
  const approve = useApproveBatch();
  const toast = useToast();
  const [code, setCode] = useState('');
  const err = approve.error;
  const needs2fa = !me.twoFactorEnabled || (err instanceof ApiError && err.status === 403);
  // Wise: approving only creates the transfers; Matt pays them in Wise
  const createsOnly = b.kind === 'api' && provider?.abilities.paysFromApp === false;
  // review fix (UI-12): in test mode nobody is paid anyway, so the provider's "nobody is paid until…" note is left out
  const approveNote = b.kind === 'api' && b.mode === 'live' && provider?.approveNote ? ` ${provider.approveNote}` : '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    approve.mutate({ id: b.id, body: { code: code.replace(/\s+/g, '') } }, {
      onSuccess: (next) => {
        setCode('');
        if (next.status === 'draft' && next.firstApprovedAt) {
          toast.success('First approval given', 'Nothing is sent yet: a different administrator gives the second approval.');
          return;
        }
        // review fixes (UI-2, SD-3, money:3): say what really happened, from the statuses that came back — a refused
        // item is not "sent", one not confirmed yet may still have reached the provider, a test file is never uploaded
        const out = approvalOutcome(next, { providerName, createsOnly, success: `${whoText(next)}, ${formatPence(next.totalPence)}.` });
        toast[out.tone](out.title, out.body);
      },
    });
  };
  // MONEY-MISSED-2: the first of two approvals sends nothing
  const two = b.approvalsNeeded === 2;
  const first = two && !b.firstApprovedAt;
  const label = first ? 'Give the first approval (of two)' : b.kind === 'file' ? (b.mode === 'test' ? 'Approve and make the test file' : 'Approve and make the bank file') : b.mode === 'test' ? `Approve test payment of ${formatPence(b.totalPence)}` : createsOnly ? `Approve and create the transfers (${formatPence(b.totalPence)})` : `Approve and pay ${formatPence(b.totalPence)}`;
  return (
    <Card tone={b.mode === 'live' && b.kind === 'api' ? 'warning' : 'default'}>
      <CardHeader
        title="Approve"
        icon={<ShieldCheck aria-hidden />}
        description={b.kind === 'file'
          // review fix (money:3): the test bank file is for looking at only
          ? b.mode === 'test'
            ? `Test mode: Linear Hub makes a test file for ${whoText(b)} (${formatPence(b.totalPence)}), for looking at only. Every line has sort code 00-00-00 and account 00000000, so it pays nobody, even if it is uploaded.`
            : `Linear Hub makes the file for ${whoText(b)} (${formatPence(b.totalPence)}). Nothing moves until you upload it to your bank and approve it there.`
          : b.mode === 'test'
            ? `Test mode: ${sandboxName(b.provider, providerName)} gets the payments and nobody is paid. The runs stay on Runs to pay.`
            : createsOnly
              ? `${providerName} gets transfers for ${whoText(b)} (${formatPence(b.totalPence)}) when you approve.${approveNote}`
              : `${providerName} pays ${whoText(b)}, ${formatPence(b.totalPence)} in all, as soon as you approve. This cannot be undone from Linear Hub.`}
      />
      {two && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg" data-two-approvals="">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            Two people approve each payment (Settings → Payments).{' '}
            {b.firstApprovedAt
              ? `First approval by ${b.firstApprovedByName ?? 'an administrator'}, ${formatDateTime(b.firstApprovedAt)}. A different administrator approves it now; nothing is sent until then.`
              : 'Your approval is the first: nothing is sent until a different administrator approves it too.'}
          </span>
        </p>
      )}
      {!available ? (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Paying through {providerName} is not switched on in this version of Linear Hub yet. Pay these people another way and mark their runs paid in Finance → Runs to pay, then cancel this draft.
        </p>
      ) : needs2fa ? (
        <p className="flex flex-col gap-3 text-sm text-fg sm:flex-row sm:items-center sm:justify-between">
          <span>Every payment needs a code from your authenticator app. Set up two-step verification first.</span>
          <Link to="/settings" className="focus-ring inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg shadow-card hover:bg-primary-hover">Open Settings → Security</Link>
        </p>
      ) : !b.actions.approve ? (
        // review fix (UI-7): the server's reason (e.g. made in test mode, but the connection is live now); MONEY-MISSED-2:
        // or the signed-in admin gave the first approval
        <p className="text-sm text-muted" data-approve-blocked="">{b.actions.approveBlocked ?? b.actions.approveWaitsFor ?? 'Test the connection first (Settings → Payments).'}</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
          {/* review fix: the server's message once (errorMessage would repeat it with its field detail) */}
          <Field label="Code from your authenticator app" htmlFor={`${uid}-code`} error={err ? apiMessage(err, 'Could not approve this payment') : undefined} className="sm:w-64">
            <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono" invalid={!!err} />
          </Field>
          <Button type="submit" className="h-10" variant={b.mode === 'live' && b.kind === 'api' ? 'danger' : 'primary'} loading={approve.isPending} disabled={code.replace(/\s+/g, '').length !== 6}>
            {label}
          </Button>
        </form>
      )}
    </Card>
  );
}

function MarkPaidCard({ b }: { b: PaymentBatch }) {
  const uid = useId();
  const toast = useToast();
  const mark = useMarkBatchPaid();
  const waiting = b.items.filter((i) => i.status === 'submitted' || i.status === 'processing');
  const [paid, setPaid] = useState<ReadonlySet<number>>(() => new Set(waiting.map((i) => i.id)));
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => setPaid(new Set(waiting.map((i) => i.id))), [b.id, waiting.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const failed = waiting.filter((i) => !paid.has(i.id));
  const test = b.mode === 'test';
  // MON-2: the file was downloaded, so leaving anyone unpaid needs NOT PAID typed and a fresh code
  const needsTyped = !!b.actions.markNotPaidNeedsConfirmation && failed.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (needsTyped && (!isTypedConfirmation(typed, FILE_NOT_PAID_CONFIRMATION) || code.replace(/\s+/g, '').length !== 6)) {
      toast.error(`Type ${FILE_NOT_PAID_CONFIRMATION} and your code`, 'The file was downloaded, so the people you untick count as sent until you confirm the bank did not pay them.');
      return;
    }
    mark.mutate({ id: b.id, body: { paid: [...paid], failed: failed.map((i) => i.id), reason: reason.trim() || undefined, paidDate: date, ...(needsTyped ? { confirm: typed.trim(), code: code.replace(/\s+/g, '') } : {}) } }, {
      // review fix (SD-4): a test file paid nobody, whatever is ticked
      onSuccess: () => toast.success('Marked', test
        ? 'Test: nobody was paid; the weeks stay on Runs to pay.'
        : failed.length ? `${people(paid.size)} paid, ${people(failed.length)} not paid: they stay on Runs to pay.` : `${people(paid.size)} paid.`),
      onError: (er) => toast.error('Could not mark it', errorMessage(er)),
    });
  };
  return (
    <Card>
      <CardHeader
        title="Mark as paid"
        description={test
          ? 'Test mode: nobody is paid, so this marks no week paid. Try it out: the weeks stay on Runs to pay.'
          : 'Once your bank has paid the file, tick who it paid. Untick anyone the bank rejected: their week stays on Runs to pay with your reason.'}
      />
      <form onSubmit={submit} className="space-y-4">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {waiting.map((i) => (
            <li key={i.id}>
              <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2">
                <input type="checkbox" className="focus-ring h-5 w-5 shrink-0 cursor-pointer rounded border-control-border accent-[var(--color-primary)]" checked={paid.has(i.id)} onChange={(e) => { const next = new Set(paid); if (e.target.checked) next.add(i.id); else next.delete(i.id); setPaid(next); }} aria-label={`The bank paid ${i.userName}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{i.userName}</span>
                <span className="text-sm tabular-nums text-fg">{formatPence(i.amountPence)}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paid on" htmlFor={`${uid}-date`}>
            <Input id={`${uid}-date`} type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {failed.length > 0 && (
            <Field label="Why the bank did not pay them" htmlFor={`${uid}-reason`} hint="Shown on Runs to pay, not to the person.">
              <Input id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Rejected: the name does not match the account" />
            </Field>
          )}
          {needsTyped && (
            <>
              <Field label={`Type ${FILE_NOT_PAID_CONFIRMATION}: the bank did not pay the people you unticked`} htmlFor={`${uid}-typed`}>
                <Input id={`${uid}-typed`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
              </Field>
              <Field label="Code from your authenticator app" htmlFor={`${uid}-code`}>
                <Input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="font-mono" />
              </Field>
            </>
          )}
        </div>
        <Button type="submit" className="h-10" loading={mark.isPending} disabled={!waiting.length}>
          {failed.length ? `Mark ${formatNumber(paid.size)} paid, ${formatNumber(failed.length)} not paid` : `Mark ${formatNumber(paid.size)} paid`}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Check before paying (MON-1, MONEY-MISSED-2, MONEY-MISSED-3): what the office should look at before approving — days
 * waiting for a leader (not in this pay), pay resting on subs no client statement confirmed, and bonuses or adjustments
 * added in the last 7 days to these weeks, with who added them ("You added this").
 */
function ChecksCard({ b }: { b: PaymentBatch }) {
  const me = useCurrentUser();
  const changes = b.recentChanges ?? [];
  const days = b.daysWaiting ?? 0;
  const unconfirmed = b.unconfirmedPence ?? 0;
  if (!changes.length && !days && !unconfirmed) return null;
  return (
    <Card data-batch-checks="">
      <CardHeader title="Check before paying" icon={<ClipboardCheck aria-hidden />} description="Nothing here stops the payment. It is what is worth a second look." />
      <ul className="space-y-3 text-sm">
        {days > 0 && (
          <li className="text-fg">
            <span className="font-medium">{formatNumber(days)} {days === 1 ? 'day' : 'days'} waiting for a leader.</span>{' '}
            <span className="text-muted">Logged with no booking or check-in, so not in this pay. A leader confirms them in <Link to="/pay/days" className="text-primary hover:underline">Days to confirm</Link>; they are paid with a later payment.</span>
          </li>
        )}
        {unconfirmed > 0 && (
          <li className="text-fg">
            <span className="font-medium">{formatPence(unconfirmed)} rests on {formatNumber(b.unconfirmedSubs ?? 0)} {b.unconfirmedSubs === 1 ? 'sub' : 'subs'} no client statement has confirmed.</span>{' '}
            <span className="text-muted">The rep logged them; the client has not confirmed them yet (or sends no statements). The people concerned are marked below.</span>
          </li>
        )}
        {changes.length > 0 && (
          <li>
            <p className="font-medium text-fg">Bonuses and adjustments added in the last 7 days</p>
            <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
              {changes.map((c) => (
                <li key={c.adjustmentId} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <span className="min-w-0">
                    <span className="text-fg">{c.userName}</span>
                    <span className="text-muted"> · {payWeekLabel(c.weekStart)} · {c.kind === 'bonus' ? 'bonus' : 'adjustment'}{c.note ? `: ${c.note}` : ''}</span>
                    <span className="block text-xs text-muted">
                      Added {formatDateTime(c.createdAt)} by {c.createdBy === me.id ? 'you' : c.createdByName ?? 'someone'}
                      {c.createdBy === me.id && <Badge tone="warning" size="sm" className="ml-1.5">You added this</Badge>}
                    </span>
                  </span>
                  <span className={`shrink-0 font-semibold tabular-nums ${c.amount < 0 ? 'text-danger' : 'text-fg'}`}>{formatPence(poundsToPence(c.amount))}</span>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </Card>
  );
}
