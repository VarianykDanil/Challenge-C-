// Release 1.3 slot — OWNED BY P4 pdf-everywhere (laid down by r3-foundation; renders nothing until P4 pdf-everywhere fills it).
// "Download PDF" of the audit view as filtered on screen. Mounted in pages/Audit.tsx (P9's) in the page header's
// actions only while lib/pdf PDF_EXPORTS_READY is true (so no empty actions row before), in an ErrorBoundary with
// fallback={null}. P9 passes the rows on screen and the filter lines.
import type { AuditEntryDetail } from '@lm/shared';

export interface AuditPdfButtonProps {
  entries: AuditEntryDetail[];
  /** The filters on screen, e.g. ["Person: Jordan Lee", "1 Oct – 21 Oct 2026"]. */
  filters: string[];
  className?: string;
}

export function AuditPdfButton(_props: AuditPdfButtonProps) {
  return null;
}
