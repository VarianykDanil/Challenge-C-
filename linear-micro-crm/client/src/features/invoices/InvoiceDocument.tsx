// Release 1.3 — OWNED BY P2 invoices. The self-billing invoice as a document: A4-like on screen, a clean page in print
// (PayslipModal's print rules print only its data-print-root). Supplier = the person, customer = Linear MCR Limited,
// every line from the pay week (a line listed but not paid is marked "Not paid"; release 1.3.1: its note, in grey
// under the description), the total, the self-billing sentence, both signatures, earlier versions and the dispute /
// the office's answer.
import clsx from 'clsx';
import type { Invoice, InvoiceParty } from '@lm/shared';
import { INVOICE_STATUS_LABELS, invoiceLineNote } from '@lm/shared';
import { Badge } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import {
  WITHHELD_SUPPLIER, acceptanceSentence, customerExtraLines, invoiceDay, invoiceMoment, money, signedMoney, statusTone, supplierTaxLines, weekRange,
} from './invoiceText';

function Party({ heading, party, extra, missing }: { heading: string; party: InvoiceParty; extra: string[]; missing?: string }) {
  const hasAddress = party.addressLines.length > 0 || !!party.postcode;
  return (
    <section className="min-w-0 rounded-lg border border-border p-3 sm:p-4" aria-label={heading} data-print-keep>
      <h4 className="eyebrow mb-1.5">{heading}</h4>
      <p className="font-semibold text-fg">{party.name}</p>
      {party.withheld ? (
        <p className="text-sm text-muted" data-supplier-withheld="">{WITHHELD_SUPPLIER}</p>
      ) : hasAddress ? (
        <address className="not-italic text-sm leading-relaxed text-fg">
          {party.addressLines.map((l, i) => <span key={i} className="block break-words">{l}</span>)}
          {party.postcode && <span className="block">{party.postcode}</span>}
        </address>
      ) : (
        <p className="text-sm text-warning">{missing ?? 'No address on file'}</p>
      )}
      {extra.length > 0 && (
        <p className="mt-1.5 space-y-0.5 text-xs text-muted">
          {extra.map((l) => <span key={l} className="block">{l}</span>)}
        </p>
      )}
    </section>
  );
}

export interface InvoiceDocumentProps {
  invoice: Invoice;
  /** The supplier is looking at their own invoice (the missing-address hint points them to Settings). */
  mine?: boolean;
  className?: string;
}

export function InvoiceDocument({ invoice: inv, mine, className }: InvoiceDocumentProps) {
  const disputed = new Map((inv.dispute?.lines ?? []).map((l) => [l.line, l]));
  const notPaid = inv.lines.filter((l) => !l.paid);
  return (
    <article className={clsx('min-w-0 rounded-xl border border-border bg-surface p-4 shadow-card sm:p-6 print:border-0 print:p-0 print:shadow-none', className)} aria-label={`Invoice ${inv.number}`} data-invoice-document="">
      <header className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between" data-print-keep>
        <div className="min-w-0">
          <p className="eyebrow">Self-billed invoice</p>
          <h3 className="mt-1 break-words text-xl font-semibold tabular-nums text-fg">{inv.number}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(inv.status)} variant={inv.status === 'deemed_accepted' ? 'outline' : 'soft'}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
            {inv.version > 1 && <Badge tone="neutral">Version {formatNumber(inv.version)}</Badge>}
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:text-right">
          <dt className="text-muted sm:text-left">Invoice date</dt><dd className="text-fg">{invoiceDay(inv.issuedAt)}</dd>
          <dt className="text-muted sm:text-left">Pay week</dt><dd className="text-fg">{weekRange(inv.weekStart, inv.weekEnd)}</dd>
          <dt className="text-muted sm:text-left">Due (payday)</dt><dd className="font-medium text-fg">{invoiceDay(inv.dueDate)}</dd>
        </dl>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Party heading="Supplier" party={inv.supplier} extra={supplierTaxLines(inv.supplier)} missing={mine ? 'No address yet: add it in Settings → Invoices' : undefined} />
        <Party heading="Customer" party={inv.customer} extra={customerExtraLines(inv.customer)} />
      </div>

      <table className="mt-5 w-full text-sm" data-print-keep>
        <caption className="sr-only">Invoice lines</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th scope="col" className="py-2 pr-2 font-medium">Description</th>
            <th scope="col" className="hidden py-2 pr-2 text-right font-medium sm:table-cell print:table-cell">Qty</th>
            <th scope="col" className="hidden py-2 pr-2 text-right font-medium sm:table-cell print:table-cell">Rate</th>
            <th scope="col" className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => {
            const flagged = disputed.get(i);
            const note = invoiceLineNote(l);
            return (
              <tr key={i} className={clsx('border-b border-border align-top', !l.paid && 'text-muted')} data-invoice-line={i}>
                <td className="py-2 pr-2">
                  <span className={clsx('block break-words', l.paid ? 'text-fg' : 'text-muted')}>{l.description}</span>
                  {(l.quantity !== undefined || l.unitPrice !== undefined) && !(l.unitPrice !== undefined && l.description.includes(money(l.unitPrice))) && (
                    <span className="block text-xs text-muted sm:hidden print:hidden">
                      {l.quantity !== undefined ? formatNumber(l.quantity) : ''}{l.quantity !== undefined && l.unitPrice !== undefined ? ' × ' : ''}{l.unitPrice !== undefined ? money(l.unitPrice) : ''}
                    </span>
                  )}
                  {note && <span className="mt-0.5 block break-words text-xs text-muted" data-invoice-line-note="">{note}</span>}
                  {!l.paid && <span className="mt-0.5 block text-xs">Not paid: shown so you can see how the week was worked out</span>}
                  {flagged && <span className="mt-0.5 block text-xs font-medium text-danger">Disputed{flagged.note ? `: “${flagged.note}”` : ''}</span>}
                </td>
                <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell print:table-cell">{l.quantity !== undefined ? formatNumber(l.quantity) : ''}</td>
                <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell print:table-cell">{l.unitPrice !== undefined ? money(l.unitPrice) : ''}</td>
                <td className={clsx('whitespace-nowrap py-2 text-right tabular-nums', !l.paid ? 'text-muted line-through decoration-1' : l.amount < 0 ? 'text-danger' : 'text-fg')}>
                  {signedMoney(l.amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={1} className="pt-3 text-left text-base font-semibold text-fg sm:hidden print:hidden">Total due</th>
            <th scope="row" colSpan={3} className="hidden pt-3 text-left text-base font-semibold text-fg sm:table-cell print:table-cell">Total due</th>
            <td className="whitespace-nowrap pt-3 text-right text-base font-semibold tabular-nums text-fg" data-invoice-total="">{money(inv.total)}</td>
          </tr>
          <tr>
            <td colSpan={4} className="pt-1 text-xs text-muted">
              {inv.supplier.vatNumber ? 'No VAT has been added to this invoice.' : 'No VAT: the supplier is not VAT registered.'}
              {notPaid.length > 0 && ' Lines marked "Not paid" are not part of the total.'}
            </td>
          </tr>
        </tfoot>
      </table>

      <p className="mt-4 text-xs leading-relaxed text-muted">{inv.selfBillingNote}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2" data-print-keep>
        <section className="min-w-0 rounded-lg border border-border p-3 sm:p-4" aria-label="Signed for the customer">
          <h4 className="eyebrow mb-1.5">For {inv.customer.name}</h4>
          {inv.signatory.signatureUrl && (
            <img src={inv.signatory.signatureUrl} alt={`Signature of ${inv.signatory.name || 'the authorised signatory'}`} className="mb-1 h-12 max-w-[200px] rounded bg-white object-contain object-left p-1" />
          )}
          <p className="font-medium text-fg">{inv.signatory.name || 'Authorised signatory'}</p>
          <p className="text-xs text-muted">Authorised signatory</p>
        </section>
        <section className="min-w-0 rounded-lg border border-border p-3 sm:p-4" aria-label="The supplier's acceptance">
          <h4 className="eyebrow mb-1.5">Supplier</h4>
          <p className="font-medium text-fg">{inv.supplier.name}</p>
          <p className={clsx('text-sm', inv.acceptance ? 'text-success' : inv.status === 'disputed' ? 'text-danger' : 'text-muted')} data-invoice-acceptance="">{acceptanceSentence(inv)}</p>
        </section>
      </div>

      {(inv.dispute || inv.resolution || inv.paidOverride) && (
        <div className="mt-4 space-y-2 text-sm">
          {inv.dispute && (
            <p className="rounded-lg border border-danger/30 bg-danger/5 p-3">
              <span className="font-medium text-fg">{inv.supplier.name} said something's wrong</span> <span className="text-muted">({invoiceMoment(inv.dispute.at)})</span>: “{inv.dispute.reason}”
            </p>
          )}
          {inv.resolution && (
            <p className="rounded-lg border border-border bg-surface-2/60 p-3">
              <span className="font-medium text-fg">{inv.resolution.action === 'keep' ? 'The office kept it as it is' : 'The office fixed and reissued it'}</span>
              <span className="text-muted"> ({inv.resolution.byName ? `${inv.resolution.byName}, ` : ''}{invoiceMoment(inv.resolution.at)})</span>: “{inv.resolution.note}”
            </p>
          )}
          {inv.paidOverride && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 print:hidden">
              <span className="font-medium text-fg">Paid before it was accepted</span>
              <span className="text-muted"> ({inv.paidOverride.byName ?? 'an administrator'}, {invoiceMoment(inv.paidOverride.at)})</span>: “{inv.paidOverride.reason}”
            </p>
          )}
        </div>
      )}

      {inv.previousVersions && inv.previousVersions.length > 0 && (
        <details className="mt-4 rounded-lg border border-border p-3 text-sm print:hidden">
          <summary className="cursor-pointer font-medium text-fg">Earlier versions ({formatNumber(inv.previousVersions.length)})</summary>
          <ul className="mt-2 space-y-1.5">
            {inv.previousVersions.map((v) => (
              <li key={v.version} className="text-muted">
                <span className="font-medium text-fg">Version {formatNumber(v.version)}</span>, issued {invoiceDay(v.issuedAt)}: {money(v.total)}, {INVOICE_STATUS_LABELS[v.status].toLowerCase()}. Replaced {invoiceMoment(v.replacedAt)}: {v.reason.toLowerCase()}.
                {v.disputeReason && <span className="block text-xs">Dispute: “{v.disputeReason}”</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="mt-5 border-t border-border pt-3 text-xs text-muted">
        {inv.customer.name}{inv.customer.companyNumber ? ` · Company number ${inv.customer.companyNumber}` : ''}{inv.customer.addressLines.length ? ` · ${inv.customer.addressLines.join(', ')}` : ''}{inv.customer.postcode ? ` ${inv.customer.postcode}` : ''}
      </footer>
    </article>
  );
}
