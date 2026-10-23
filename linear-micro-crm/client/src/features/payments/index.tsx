// Release 1.4 — F payments-foundation: the small pieces other pages import (kept tiny: they sit in the Finance,
// Settings and Team chunks). Everything with logos or forms loads lazily: the Settings → Payments section
// (LazyPaymentsSettingsSection) and the two pages (pages/PaymentsPay.tsx, pages/PaymentBatch.tsx, lazy in App.tsx).
import { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import type { PaymentBatchStatus, PaymentItemStatus, PayrollRunPayment } from '@lm/shared';
import { PAYMENT_BATCH_STATUS_LABELS, PAYMENT_ITEM_STATUS_LABELS } from '@lm/shared';
import { Badge, Card, Skeleton } from '@/components/ui';

const Section = lazy(() => import('./PaymentsSettingsSection'));

export function LazyPaymentsSettingsSection(props: { className?: string }) {
  return (
    <Suspense fallback={<Card className={props.className}><Skeleton className="mb-4 h-6 w-40" /><Skeleton className="h-48 w-full rounded-xl" /></Card>}>
      <Section {...props} />
    </Suspense>
  );
}

const ITEM_TONE: Record<PaymentItemStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral', submitted: 'info', processing: 'info', paid: 'success', failed: 'danger', cancelled: 'neutral',
};
const BATCH_TONE: Record<PaymentBatchStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  draft: 'neutral', submitted: 'info', processing: 'info', completed: 'success', partly_failed: 'warning', failed: 'danger', cancelled: 'neutral',
};

/** "In the file" for a bank file's people still waiting for the bank, else the shared label. */
export function PaymentItemStatusBadge({ status, kind }: { status: PaymentItemStatus; kind?: 'file' | 'api' }) {
  const label = kind === 'file' && (status === 'submitted' || status === 'processing') ? 'In the file' : PAYMENT_ITEM_STATUS_LABELS[status];
  return <Badge tone={ITEM_TONE[status]} size="sm" dot={status === 'paid'}>{label}</Badge>;
}

/** "File ready" for a bank file not yet marked paid, else the shared label. */
export function PaymentBatchStatusBadge({ status, kind }: { status: PaymentBatchStatus; kind?: 'file' | 'api' }) {
  const label = kind === 'file' && status === 'submitted' ? 'File ready' : PAYMENT_BATCH_STATUS_LABELS[status];
  return <Badge tone={BATCH_TONE[status]} dot={status === 'completed'}>{label}</Badge>;
}

/** On a run in Runs to pay (admin): its payment from Linear Hub, on its way or failed, linking to the payment. */
export function PaymentRunBadge({ payment }: { payment: PayrollRunPayment | undefined }) {
  if (!payment) return null;
  const failed = payment.status === 'failed';
  const label = failed ? 'Payment failed' : payment.draft ? 'In a draft payment' : 'Payment on its way';
  return (
    <Link
      to={`/finance/pay/batches/${payment.batchId}`}
      className="focus-ring inline-flex items-center rounded-full max-sm:min-h-10 pointer-coarse:min-h-10"
      title={failed && payment.failureReason ? payment.failureReason : `Payment #${payment.batchId}`}
      onClick={(e) => e.stopPropagation()}
      data-run-payment={payment.status}
    >
      <Badge tone={failed ? 'danger' : payment.draft ? 'neutral' : 'info'}>{label}</Badge>
    </Link>
  );
}

/** Runs to pay → "Pay from Linear Hub", carrying the selected runs (if any) to the Pay people page. */
export function PayFromHubLink({ runIds }: { runIds: number[] }) {
  const to = runIds.length ? `/finance/pay?runs=${runIds.join(',')}` : '/finance/pay';
  return (
    <Link
      to={to}
      className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-fg shadow-card hover:bg-surface-2 sm:h-8"
      data-pay-from-hub=""
    >
      <Send className="h-4 w-4" aria-hidden />
      {runIds.length ? `Pay ${runIds.length} from Linear Hub` : 'Pay from Linear Hub'}
    </Link>
  );
}
