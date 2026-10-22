// Release 1.3 — OWNED BY P8 venue-insights. "Venue report": the venue page as a PDF (features/venues/venueReport.ts, on
// P4's lib/pdf primitives). Mounted in pages/VenueDetail.tsx in the page header's actions ONLY while lib/pdf
// PDF_EXPORTS_READY is true (the foundation's rule: no PDF button before P4 lands), in an ErrorBoundary with
// fallback={null}. The report's code loads on the first tap.
import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { VenueProfile } from '@lm/shared';
import { Button, useToast } from '@/components/ui';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';

export function VenueReportButton({ venue }: { venue: VenueProfile }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const { downloadVenueReport } = await import('./venueReport');
      await downloadVenueReport(venue, todayISO());
    } catch (e) {
      toast.error('Could not make the venue report', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" className="max-sm:h-10" onClick={() => void download()} loading={busy} leftIcon={<FileText className="h-4 w-4" aria-hidden />} data-venue-report>
      Venue report
    </Button>
  );
}
