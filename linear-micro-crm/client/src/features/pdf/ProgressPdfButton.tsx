// Release 1.3 slot — OWNED BY P4 pdf-everywhere (laid down by r3-foundation; renders nothing until P4 pdf-everywhere fills it).
// "Download PDF" of a person's learning progress (checklist, progression, required videos). Mounted in
// pages/LearningProgress.tsx in the page header's actions only while lib/pdf PDF_EXPORTS_READY is true, in an
// ErrorBoundary with fallback={null}.
export interface ProgressPdfButtonProps {
  /** Omitted: the signed-in person. */
  userId?: number;
  className?: string;
}

export function ProgressPdfButton(_props: ProgressPdfButtonProps) {
  return null;
}
