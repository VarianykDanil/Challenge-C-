// Release 1.3 slot — OWNED BY P4 pdf-everywhere (laid down by r3-foundation).
// "Download PDF" of the audit view as filtered on screen. Mounted in pages/Audit.tsx (P9's) in the page header's
// actions only while lib/pdf PDF_EXPORTS_READY is true (so no empty actions row before), in an ErrorBoundary with
// fallback={null}. P9 passes the rows on screen and the filter lines; with `total` and `query` too, the PDF holds every
// matching entry (newest first, up to 2,000), not only the page on screen. The PDF builder loads on the first click.
import { useState } from 'react';
import { FileDown } from 'lucide-react';
import type { AuditEntryDetail } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { Button, useToast } from '@/components/ui';
import { csvFilename } from '@/lib/csv';
import { formatNumber, fullName } from '@/lib/format';
import { reportExport } from './report';

export interface AuditPdfButtonProps {
  entries: AuditEntryDetail[];
  /** The filters on screen, e.g. ["Person: Jordan Lee", "1 Oct – 21 Oct 2026"]. */
  filters: string[];
  /** Release 1.3 (P4): how many entries match the filters (GET /audit `total`). */
  total?: number;
  /**
   * Release 1.3 (P4): the view's GET /audit query without limit and offset, e.g. { userId, entity, entityId, from, to,
   * q, kind }. With `total`, the PDF holds every matching entry, newest first, up to 2,000.
   */
  query?: Record<string, string | number | boolean | null | undefined>;
  className?: string;
}

export function AuditPdfButton({ entries, filters, total, query, className }: AuditPdfButtonProps) {
  const toast = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const empty = entries.length === 0;

  const onClick = async () => {
    if (empty || busy) return;
    setBusy(true);
    const filename = csvFilename('audit-trail').replace(/\.csv$/, '.pdf');
    try {
      const { downloadAuditPdf } = await import('./auditPdf');
      const n = await downloadAuditPdf(entries, filters, { filename, generatedBy: user ? fullName(user) : null, total, query });
      toast.success(`Exported ${formatNumber(n)} ${n === 1 ? 'entry' : 'entries'} as a PDF`, filename);
      reportExport('pdf', filename, n, 'audit-trail', user?.id);
    } catch (e) {
      toast.error('Could not make the PDF', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      leftIcon={<FileDown aria-hidden />}
      loading={busy}
      disabled={empty}
      title={empty ? 'Nothing on this page to download' : query && total !== undefined ? 'Every entry that matches the filters, newest first (up to 2,000)' : 'The entries on this page, as filtered'}
      onClick={() => void onClick()}
      className={className}
    >
      Download PDF
    </Button>
  );
}
