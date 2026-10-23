// Release 1.3 — OWNED BY P2 invoices. The invoice as an A4 PDF from P4's page primitives (client/src/lib/pdf): header,
// supplier and customer blocks, the lines (each with its note, release 1.3.1), the total, the self-billing sentence,
// both signatures and the footer.
// Loaded on demand (PayslipModal imports it on click); the PDF button shows only while PDF_EXPORTS_READY.
import type { Invoice } from '@lm/shared';
import { INVOICE_STATUS_LABELS, invoiceLineNote } from '@lm/shared';
import { pdfDocument, type PdfLineRow } from '@/lib/pdf';
import { formatNumber } from '@/lib/format';
import { reportAuditEvent } from '@/api/auditEvents';
import { WITHHELD_SUPPLIER, acceptanceSentence, customerExtraLines, invoiceDay, money, signedMoney, supplierTaxLines, weekRange } from './invoiceText';

/** A same-origin image (the signature) as a data URL for jsPDF; null when it cannot be read. */
async function dataUrlOf(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export const invoicePdfFilename = (inv: Pick<Invoice, 'number' | 'version'>) => `${inv.number}${inv.version > 1 ? `-v${inv.version}` : ''}.pdf`;

export async function downloadInvoicePdf(inv: Invoice): Promise<void> {
  const doc = await pdfDocument({ orientation: 'portrait', title: `Self-billed invoice ${inv.number}` });
  // PdfLineRow is string cells plus an optional `muted` flag (the "not paid" lines) and `note` (release 1.3.1: why the
  // line is what it is, drawn smaller and grey under the description; none on an invoice issued before then)
  const rows = inv.lines.map((l) => {
    const note = invoiceLineNote(l);
    return {
      description: l.paid ? l.description : `${l.description} (not paid)`,
      qty: l.quantity !== undefined ? formatNumber(l.quantity) : '',
      rate: l.unitPrice !== undefined ? money(l.unitPrice) : '',
      amount: signedMoney(l.amount),
      ...(l.paid ? {} : { muted: true }),
      ...(note ? { note } : {}),
    } as unknown as PdfLineRow;
  });
  const signature = await dataUrlOf(inv.signatory.signatureUrl);
  doc
    .header({
      title: 'Self-billed invoice',
      subtitle: `${inv.number}${inv.version > 1 ? ` · version ${inv.version}` : ''} · ${INVOICE_STATUS_LABELS[inv.status]}`,
      meta: [['Invoice date', invoiceDay(inv.issuedAt)], ['Pay week', weekRange(inv.weekStart, inv.weekEnd)], ['Due (payday)', invoiceDay(inv.dueDate)]],
    })
    .addressBlocks(
      {
        heading: 'Supplier',
        name: inv.supplier.name,
        lines: inv.supplier.withheld ? [WITHHELD_SUPPLIER] : [...inv.supplier.addressLines, ...(inv.supplier.postcode ? [inv.supplier.postcode] : [])],
        extra: supplierTaxLines(inv.supplier),
      },
      { heading: 'Customer', name: inv.customer.name, lines: [...inv.customer.addressLines, ...(inv.customer.postcode ? [inv.customer.postcode] : [])], extra: customerExtraLines(inv.customer) },
    )
    .lineTable(
      [
        { key: 'description', header: 'Description', width: 4 },
        { key: 'qty', header: 'Qty', align: 'right' },
        { key: 'rate', header: 'Rate', align: 'right', width: 1.3 },
        { key: 'amount', header: 'Amount', align: 'right', width: 1.4 },
      ],
      rows,
    )
    .totals([{ label: 'Total due', value: money(inv.total), strong: true }])
    .paragraph(inv.supplier.vatNumber ? 'No VAT has been added to this invoice.' : 'No VAT: the supplier is not VAT registered.', { muted: true, size: 9 })
    .paragraph(inv.selfBillingNote, { muted: true, size: 9 })
    .signatureBlock(
      { label: `For ${inv.customer.name}`, name: inv.signatory.name || 'Authorised signatory', imageDataUrl: signature, note: 'Authorised signatory' },
      { label: 'Supplier', name: inv.supplier.name, note: acceptanceSentence(inv) },
    );
  if (inv.dispute) doc.paragraph(`Disputed: “${inv.dispute.reason}”`, { size: 9 });
  if (inv.resolution) doc.paragraph(`${inv.resolution.action === 'keep' ? 'Kept as it is' : 'Fixed and reissued'} by the office: “${inv.resolution.note}”`, { size: 9 });
  doc.footer(`${inv.customer.name}${inv.customer.companyNumber ? ` · Company number ${inv.customer.companyNumber}` : ''} · ${inv.number}`);
  const filename = invoicePdfFilename(inv);
  doc.save(filename);
  reportAuditEvent({ kind: 'export', format: 'pdf', what: `invoice ${inv.number}`, filename, entity: 'invoice', entityId: inv.id });
}
