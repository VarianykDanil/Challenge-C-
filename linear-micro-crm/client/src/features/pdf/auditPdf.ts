// Release 1.3 — OWNED BY P4 pdf-everywhere. The audit view as a PDF: the entries (newest first) with when, who, what
// happened, the record and the field changes, under the filters on screen. Loaded on demand by AuditPdfButton, so the
// Audit page's chunk carries only the button.
//
// Every matching entry, not just the page on screen: when the page passes its GET /audit query and the total, the
// entries are read page by page (AUDIT_PDF_PAGE at a time, the server's most) up to AUDIT_PDF_MAX_ENTRIES, newest
// first; an entry that moves to the next page while they are read (new activity arrives on top) is printed once.
// Without them it is the page on screen, and the file says so (auditPdfText.ts auditCoverageLine).
import { AUDIT_ENTITY_LABELS, auditChangeText, type AuditEntryDetail, type AuditPage } from '@lm/shared';
import { api, qs } from '@/api/client';
import { csvDateTime, type CsvColumn } from '@/lib/csv';
import { exportTablePdf } from '@/lib/pdf';
import { auditCoverageLine, auditPdfWho } from './auditPdfText';

export { auditCoverageLine, auditPdfWho } from './auditPdfText';

/** The most entries one audit PDF holds (about 60 A4 pages). */
export const AUDIT_PDF_MAX_ENTRIES = 2000;
/** GET /audit answers at most 200 entries a request (server routes/audit.ts AUDIT_PAGE_MAX). */
const AUDIT_PDF_PAGE = 200;

export type AuditQuery = Record<string, string | number | boolean | null | undefined>;

/** The columns of the audit PDF (also what a CSV of the trail would hold). */
export const AUDIT_PDF_COLUMNS: CsvColumn<AuditEntryDetail>[] = [
  { key: 'at', header: 'When', format: csvDateTime },
  { key: 'userName', header: 'Who', format: (_, r) => auditPdfWho(r) },
  { key: 'summary', header: 'What happened' },
  { key: 'entity', header: 'Record', format: (_, r) => (r.entity ? `${AUDIT_ENTITY_LABELS[r.entity] ?? r.entity}${r.entityId ? ` #${r.entityId}` : ''}` : '—') },
  { key: 'diff', header: 'Changes', format: (_, r) => auditChangeText(r.diff ?? [], { max: 4 }) || '—' },
];

/** Every entry that matches `query`, newest first, up to `max`; `total` is the server's count as it answered last. */
export async function fetchAuditEntries(query: AuditQuery, max = AUDIT_PDF_MAX_ENTRIES): Promise<{ entries: AuditEntryDetail[]; total: number }> {
  const seen = new Set<number>();
  const entries: AuditEntryDetail[] = [];
  let total = 0;
  for (let offset = 0; entries.length < max; offset += AUDIT_PDF_PAGE) {
    const page = await api<AuditPage>(`/audit${qs({ ...query, limit: AUDIT_PDF_PAGE, offset })}`);
    total = page.total;
    for (const e of page.rows) {
      if (seen.has(e.id) || entries.length >= max) continue;
      seen.add(e.id);
      entries.push(e);
    }
    if (page.rows.length < AUDIT_PDF_PAGE || offset + AUDIT_PDF_PAGE >= total) break;
  }
  return { entries, total };
}

export interface AuditPdfOptions {
  filename: string;
  generatedBy: string | null;
  /** How many entries match the filters (GET /audit `total`). */
  total?: number;
  /** The view's GET /audit query without limit and offset: with it, the PDF holds every matching entry. */
  query?: AuditQuery;
}

/** Builds and downloads the PDF; returns how many entries it holds. */
export async function downloadAuditPdf(entries: AuditEntryDetail[], filters: string[], opts: AuditPdfOptions): Promise<number> {
  let rows = entries;
  let total = opts.total;
  const allPages = Boolean(opts.query && total !== undefined && total > entries.length);
  if (allPages) {
    const all = await fetchAuditEntries(opts.query!);
    rows = all.entries;
    total = all.total;
  }
  const coverage = auditCoverageLine(rows.length, total, allPages);
  await exportTablePdf({
    title: 'Audit trail',
    subtitle: 'What happened on Linear Hub, newest first',
    filters: coverage ? [...filters, coverage] : filters,
    columns: AUDIT_PDF_COLUMNS,
    rows,
    filename: opts.filename,
    generatedBy: opts.generatedBy,
  });
  return rows.length;
}
