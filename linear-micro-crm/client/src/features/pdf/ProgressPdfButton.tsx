// Release 1.3 slot — OWNED BY P4 pdf-everywhere (laid down by r3-foundation).
// "Download PDF" of a person's learning progress (checklist, progression, required videos). Mounted in
// pages/LearningProgress.tsx in the page header's actions only while lib/pdf PDF_EXPORTS_READY is true, in an
// ErrorBoundary with fallback={null}. The PDF builder (and jsPDF) load on the first click.
import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { Button, useToast } from '@/components/ui';
import { errorMessage } from '@/features/common/QueryStates';
import { fullName } from '@/lib/format';
import { reportExport } from './report';

export interface ProgressPdfButtonProps {
  /** Omitted: the signed-in person. */
  userId?: number;
  className?: string;
}

export function ProgressPdfButton({ userId, className }: ProgressPdfButtonProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { downloadProgressPdf } = await import('./progressPdf');
      const { filename, rows, name } = await downloadProgressPdf(qc, { userId, meId: user.id, meRole: user.role, generatedBy: fullName(user) });
      toast.success(userId ? `Exported ${name}’s progress as a PDF` : 'Exported your progress as a PDF', filename);
      reportExport('pdf', filename, rows, 'learning-progress', user.id);
    } catch (e) {
      toast.error('Could not make the PDF', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" leftIcon={<FileDown aria-hidden />} loading={busy} onClick={() => void onClick()} className={className}>
      Download PDF
    </Button>
  );
}
