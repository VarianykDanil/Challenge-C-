// Release 1.3 slot — OWNED BY P2 invoices. Mounted in features/finance/PayslipModal.tsx (P2's) above the invoice, in an
// ErrorBoundary with fallback={null}. What it shows depends on who is looking (the server's `actions` decide):
//  - the supplier: **Accept invoice** and **Something's wrong** while it waits (the agreement first, once), then
//    where it stands (accepted, counts as accepted, held for the office, the office's answer);
//  - an admin: where it stands, **Fix and reissue** / **Keep as it is** for a dispute, and **Mark paid anyway** with a
//    reason while it is not accepted (Finance's Mark paid and the bulk bar send no reason, so they point here);
//  - a team leader: where it stands.
// Nothing for a run without an invoice.
import { useState } from 'react';
import { CheckCircle2, Clock, MessageSquareWarning, ShieldAlert, Wallet, Wrench } from 'lucide-react';
import clsx from 'clsx';
import type { Invoice, PayrollRunWithUser } from '@lm/shared';
import { Button, Skeleton, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useAcceptInvoice, useInvoiceForRun } from '@/api/invoices';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { AgreementDialog } from './AgreementDialog';
import { DisputeDialog, MarkPaidAnywayDialog, ResolveDialog } from './InvoiceDialogs';
import { deadlineShort, invoiceMoment, money } from './invoiceText';

export interface InvoiceActionsBarProps {
  run: PayrollRunWithUser;
  className?: string;
}

const firstName = (name: string) => name.split(' ')[0] ?? name;

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';
const TONE: Record<Tone, string> = {
  info: 'border-info/30 bg-info-soft/60',
  success: 'border-success/30 bg-success-soft/60',
  warning: 'border-warning/40 bg-warning/10',
  danger: 'border-danger/30 bg-danger/5',
  neutral: 'border-border bg-surface-2/60',
};

/** The headline and detail for where the invoice stands, from the viewer's side. */
function standing(inv: Invoice, mine: boolean): { tone: Tone; title: string; detail?: string } {
  const who = mine ? 'You' : firstName(inv.supplier.name);
  switch (inv.status) {
    case 'issued': {
      const fixed = inv.resolution?.action === 'reissue' ? ` The office fixed it: “${inv.resolution.note}”` : inv.version > 1 ? ' This is a new version: the figures changed.' : '';
      return mine
        ? { tone: 'info', title: 'Check your invoice, then accept it or tell us what is wrong', detail: `If you do neither by ${deadlineShort(inv.deemedAcceptedAt)}, it counts as accepted.${fixed}` }
        : { tone: 'info', title: `Waiting for ${who} to accept`, detail: `It counts as accepted at ${deadlineShort(inv.deemedAcceptedAt)} unless disputed.${fixed}` };
    }
    case 'accepted':
      return { tone: 'success', title: `${who} accepted this invoice`, detail: inv.acceptance ? invoiceMoment(inv.acceptance.at) : undefined };
    case 'deemed_accepted':
      return {
        tone: 'success',
        title: 'This invoice counts as accepted',
        detail: `Not disputed by ${deadlineShort(inv.deemedAcceptedAt)}.${inv.acceptance?.withoutAgreement ? (mine ? ' You had not accepted the self-billing agreement yet: it is in Settings → Invoices.' : ` ${who} had not accepted the self-billing agreement yet.`) : ''}`,
      };
    case 'disputed':
      return {
        tone: 'danger',
        title: mine ? 'You said something is wrong' : `${who} says something is wrong`,
        detail: `${inv.dispute ? `“${inv.dispute.reason}” ` : ''}${mine ? 'The office will check it and either fix it or explain why it stands.' : 'Held until you answer.'}`,
      };
    case 'resolved':
      return { tone: 'neutral', title: 'The office checked it and kept it as it is', detail: inv.resolution ? `“${inv.resolution.note}”` : undefined };
  }
}

export function InvoiceActionsBar({ run, className }: InvoiceActionsBarProps) {
  const me = useCurrentUser();
  const q = useInvoiceForRun(run.id, { enabled: !!run.invoice });
  const accept = useAcceptInvoice();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'agreement' | 'dispute' | 'reissue' | 'keep' | 'pay'>(null);
  if (!run.invoice) return null;
  if (q.isLoading) return <Skeleton className={clsx('h-16 w-full rounded-lg', className)} />;
  const inv = q.data;
  if (!inv) return null;
  const mine = inv.userId === me.id;
  const a = inv.actions ?? { accept: false, dispute: false, resolve: false, markPaidWithReason: false };
  const s = standing(inv, mine);
  const Icon = s.tone === 'success' ? CheckCircle2 : s.tone === 'danger' ? ShieldAlert : s.tone === 'info' ? Clock : MessageSquareWarning;

  const doAccept = () => {
    if (mine && inv.agreementAccepted === false) {
      setDialog('agreement');
      return;
    }
    accept.mutate(inv.id, {
      onSuccess: () => toast.success('Invoice accepted', `${inv.number} · ${money(inv.total)}`),
      onError: (e) => {
        if (e instanceof ApiError && (e.details as { code?: string } | undefined)?.code === 'agreement_required') setDialog('agreement');
        else toast.error('Could not accept the invoice', errorMessage(e));
      },
    });
  };

  return (
    <section className={clsx('rounded-lg border p-3 sm:p-4', TONE[s.tone], className)} aria-label="Invoice status" data-invoice-actions="">
      <div className="flex items-start gap-3">
        <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', s.tone === 'success' ? 'text-success' : s.tone === 'danger' ? 'text-danger' : s.tone === 'info' ? 'text-info' : 'text-muted')} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">{s.title}</p>
          {s.detail && <p className="mt-0.5 break-words text-sm text-muted">{s.detail}</p>}
          {inv.paidOverride && !mine && (
            <p className="mt-1 text-xs text-muted">Paid before acceptance by {inv.paidOverride.byName ?? 'an administrator'}: “{inv.paidOverride.reason}”</p>
          )}
        </div>
      </div>
      {(a.accept || a.dispute || a.resolve || a.markPaidWithReason) && (
        <div className="mt-3 flex flex-wrap gap-2 sm:pl-8">
          {a.accept && (
            <Button onClick={doAccept} loading={accept.isPending} leftIcon={<CheckCircle2 aria-hidden />} className="h-10 flex-1 sm:flex-none">
              Accept invoice
            </Button>
          )}
          {a.dispute && (
            <Button variant="outline" onClick={() => setDialog('dispute')} leftIcon={<MessageSquareWarning aria-hidden />} className="h-10 flex-1 sm:flex-none">
              Something's wrong
            </Button>
          )}
          {a.resolve && (
            <>
              <Button onClick={() => setDialog('reissue')} leftIcon={<Wrench aria-hidden />} className="h-10 flex-1 sm:flex-none">Fix and reissue</Button>
              <Button variant="outline" onClick={() => setDialog('keep')} leftIcon={<CheckCircle2 aria-hidden />} className="h-10 flex-1 sm:flex-none">Keep as it is</Button>
            </>
          )}
          {a.markPaidWithReason && (
            <Button variant={a.resolve ? 'ghost' : 'outline'} onClick={() => setDialog('pay')} leftIcon={<Wallet aria-hidden />} className="h-10 flex-1 sm:flex-none">
              Mark paid anyway
            </Button>
          )}
        </div>
      )}

      <AgreementDialog
        open={dialog === 'agreement'}
        onClose={() => setDialog(null)}
        intro="Before you accept your first invoice, read and accept the self-billing agreement. Then tap Accept invoice."
      />
      <DisputeDialog invoice={inv} open={dialog === 'dispute'} onClose={() => setDialog(null)} />
      {a.resolve && (
        <ResolveDialog
          invoice={{ id: inv.id, number: inv.number, total: inv.total, supplierName: inv.supplier.name, reason: inv.dispute?.reason ?? '' }}
          mode={dialog === 'keep' ? 'keep' : 'reissue'}
          open={dialog === 'reissue' || dialog === 'keep'}
          onClose={() => setDialog(null)}
          runTotal={inv.runTotal}
          figuresChanged={inv.figuresChanged}
        />
      )}
      {a.markPaidWithReason && <MarkPaidAnywayDialog runId={run.id} invoice={inv} open={dialog === 'pay'} onClose={() => setDialog(null)} />}
    </section>
  );
}
