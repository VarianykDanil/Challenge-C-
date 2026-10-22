// Release 1.3 slot — OWNED BY P2 invoices. Finance → Company → Disputes (admin): every disputed invoice with the
// person's reason, the lines they picked (and what they say they should be), our figures, a link to open the run (the
// invoice, the week's gauges and P1's breakdown) and the commission statements; **Fix and reissue** / **Keep as it is**.
// Mounted in pages/Finance.tsx (P1's) at the top of the Company tab, in an ErrorBoundary with fallback={null}. A whole
// Card, or nothing when there are none. /finance?tab=company#disputes scrolls here.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, FileSearch, MessageSquareWarning, Wrench } from 'lucide-react';
import { addDays, type InvoiceDisputeRow } from '@lm/shared';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { usePayslip } from '@/api/hooks';
import { useInvoiceDisputes } from '@/api/invoices';
import { useCurrentUser } from '@/auth/AuthProvider';
import { PayslipModal } from '@/features/finance/PayslipModal';
import { formatNumber, formatRangeLabel } from '@/lib/format';
import { ResolveDialog } from './InvoiceDialogs';
import { invoiceMoment, money, signedMoney } from './invoiceText';

export interface DisputesCardProps {
  className?: string;
}

function DisputeItem({ row, onOpen, onResolve }: { row: InvoiceDisputeRow; onOpen: () => void; onResolve: (mode: 'reissue' | 'keep') => void }) {
  return (
    <li className="rounded-xl border border-danger/30 bg-danger/5 p-3 sm:p-4" data-dispute-row={row.invoice.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg">
            <Link to={`/team/${row.userId}`} className="hover:underline">{row.userName}</Link>
            {row.teamName && <span className="font-normal text-muted"> · {row.teamName}</span>}
          </p>
          <p className="text-xs text-muted">
            Invoice {row.invoice.number}{row.invoice.version > 1 ? ` (version ${formatNumber(row.invoice.version)})` : ''} · week {formatRangeLabel(row.weekStart, addDays(row.weekStart, 6))} · {money(row.invoice.total)}
          </p>
        </div>
        <span className="text-xs text-muted">{invoiceMoment(row.dispute.at)}</span>
      </div>
      <blockquote className="mt-2 break-words text-sm text-fg">“{row.dispute.reason}”</blockquote>
      {row.disputedLines && row.disputedLines.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {row.disputedLines.map((l) => (
            <li key={l.line} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-md bg-surface/70 px-2.5 py-1.5">
              <span className="min-w-0 break-words text-fg">{l.description}{l.note && <span className="text-danger"> · says “{l.note}”</span>}</span>
              <span className="tabular-nums text-muted">{l.paid ? signedMoney(l.amount) : `${money(l.amount)}, not paid`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Our figures: {formatNumber(row.ours.salesLogged ?? 0)} sales logged
        {row.ours.salesConfirmed !== undefined ? `, ${formatNumber(row.ours.salesConfirmed)} confirmed by the client` : ''}; invoice total {money(row.ours.total)}.
        {row.figuresChanged && row.runTotal !== undefined && <Badge tone="warning" size="sm" className="ml-1.5">Week now {money(row.runTotal)}</Badge>}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onResolve('reissue')} leftIcon={<Wrench aria-hidden />} className="h-10 flex-1 sm:h-8 sm:flex-none">Fix and reissue</Button>
        <Button size="sm" variant="outline" onClick={() => onResolve('keep')} leftIcon={<CheckCircle2 aria-hidden />} className="h-10 flex-1 sm:h-8 sm:flex-none">Keep as it is</Button>
        <Button size="sm" variant="ghost" onClick={onOpen} leftIcon={<FileSearch aria-hidden />} className="h-10 sm:h-8">Open the week</Button>
        {/* the client statements that confirmed this week's sales (their rows for this person), else the list */}
        {row.statements && row.statements.length > 0 ? row.statements.map((st) => (
          <Link key={st.id} to={`/finance/statements?statement=${st.id}`} className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg sm:h-8">
            <ExternalLink className="h-4 w-4" aria-hidden /> {st.campaignCode ? `${st.campaignCode} statement` : 'Statement'}
          </Link>
        )) : (
          <Link to="/finance/statements" className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg sm:h-8">
            <ExternalLink className="h-4 w-4" aria-hidden /> Statements
          </Link>
        )}
      </div>
    </li>
  );
}

/** The run behind a dispute, opened in the payslip / invoice modal (its gauges, P1's breakdown, the invoice). */
function DisputeRunModal({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const q = usePayslip(runId);
  return <PayslipModal run={runId && q.data ? q.data : null} onClose={onClose} />;
}

export function DisputesCard({ className }: DisputesCardProps) {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const q = useInvoiceDisputes({ enabled: isAdmin });
  const ref = useRef<HTMLDivElement>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [resolving, setResolving] = useState<{ row: InvoiceDisputeRow; mode: 'reissue' | 'keep' } | null>(null);
  const rows = q.data ?? [];
  // /finance?tab=company#disputes (the attention item) lands here once the list is in
  useEffect(() => {
    if (rows.length && typeof window !== 'undefined' && window.location.hash === '#disputes') ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [rows.length]);
  if (!isAdmin || !rows.length) return null;
  return (
    <div ref={ref} id="disputes" className="scroll-mt-20">
    <Card className={className} data-testid="disputes-card">
      <CardHeader
        title="Disputed invoices"
        description={rows.length === 1
          ? '1 invoice is held until you answer: fix and reissue it, or keep it as it is with a note the person sees.'
          : `${formatNumber(rows.length)} invoices are held until you answer: fix and reissue each one, or keep it as it is with a note the person sees.`}
        icon={<MessageSquareWarning aria-hidden />}
      />
      <ul className="space-y-3">
        {rows.map((r) => (
          <DisputeItem key={r.invoice.id} row={r} onOpen={() => r.payrollRunId && setOpenRun(r.payrollRunId)} onResolve={(mode) => setResolving({ row: r, mode })} />
        ))}
      </ul>
      {resolving && (
        <ResolveDialog
          invoice={{ id: resolving.row.invoice.id, number: resolving.row.invoice.number, total: resolving.row.invoice.total, supplierName: resolving.row.userName, reason: resolving.row.dispute.reason }}
          mode={resolving.mode}
          open
          onClose={() => setResolving(null)}
          runTotal={resolving.row.runTotal}
          figuresChanged={resolving.row.figuresChanged}
        />
      )}
      <DisputeRunModal runId={openRun} onClose={() => setOpenRun(null)} />
    </Card>
    </div>
  );
}
