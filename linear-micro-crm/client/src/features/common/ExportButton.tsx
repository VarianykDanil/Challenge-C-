// "Download as CSV" button for card and page header action areas. Shows the label from `sm` up and
// collapses to the icon on phones (the label stays as the accessible name).
// Release 1.3 — OWNED BY P4 pdf-everywhere: P4 turns it into "Export ▾ CSV / PDF" (lib/pdf exportTablePdf, from the
// same columns and rows) once lib/pdf PDF_EXPORTS_READY is true, and reports every export to the audit trail
// (api/auditEvents.ts reportAuditEvent). The props below are the contract: every call site keeps working unchanged
// (the PDF title defaults to one derived from the file name); `pdf*` props refine the PDF where a page knows better.
import { Download } from 'lucide-react';
import clsx from 'clsx';
import { Button, Tooltip, useToast, type ButtonSize, type TooltipSide } from '@/components/ui';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/csv';
import { formatNumber } from '@/lib/format';

/** Button sizes under 40 px tall. */
const BELOW_40: ReadonlySet<ButtonSize> = new Set<ButtonSize>(['xs', 'sm', 'icon-sm', 'icon-xs']);

export interface ExportButtonProps<T extends object> {
  /** Visible text (from `sm` up) and the button's accessible name. */
  label?: string;
  /** Full file name including `.csv` — build it with `csvFilename()`. */
  filename: string;
  /** Exactly the rows on screen, in the order they should appear in the file. */
  rows: T[];
  columns: CsvColumn<T>[];
  disabled?: boolean;
  size?: ButtonSize;
  className?: string;
  /** Tooltip while there is nothing to export. */
  emptyHint?: string;
  /** Where the tooltip opens; `bottom` by default so it is not clipped by a card's top edge. */
  tooltipSide?: TooltipSide;
  /** Release 1.3 (P4): false leaves PDF out of the menu for this table (default: offered once PDF_EXPORTS_READY). */
  pdf?: boolean;
  /** Release 1.3 (P4): the PDF's title (default: derived from `filename`). */
  pdfTitle?: string;
  /** Release 1.3 (P4): lines under the title — the filters on screen. */
  pdfFilters?: string[];
  /** Release 1.3 (P4): a totals row for the PDF, keyed by column key (formatted). */
  pdfTotals?: Partial<Record<string, string>>;
  /** Release 1.3 (P9): what the audit trail calls this export, e.g. "gauges-by-team" (default: from `filename`). */
  auditWhat?: string;
}

export function ExportButton<T extends object>({
  label = 'Export CSV',
  filename,
  rows,
  columns,
  disabled,
  size = 'sm',
  className,
  emptyHint = 'Nothing to export yet',
  tooltipSide = 'bottom',
}: ExportButtonProps<T>) {
  const toast = useToast();
  const empty = rows.length === 0;
  const iconOnly = size.startsWith('icon');

  const onClick = () => {
    if (empty) return;
    try {
      downloadCsv(filename, toCsv(rows, columns));
      toast.success(`Exported ${formatNumber(rows.length)} row${rows.length === 1 ? '' : 's'}`, filename);
    } catch (e) {
      toast.error('Could not export', e instanceof Error ? e.message : undefined);
    }
  };

  return (
    // The bubble is absolutely positioned and would widen the page on phones, where nothing hovers anyway.
    <Tooltip content={empty ? emptyHint : 'Download as CSV (Excel)'} side={tooltipSide} className="max-sm:[&_[role=tooltip]]:hidden">
      <Button
        variant="outline"
        size={size}
        disabled={disabled || empty}
        onClick={onClick}
        aria-label={label}
        title={empty ? emptyHint : undefined}
        leftIcon={iconOnly ? undefined : <Download aria-hidden />}
        // The smaller sizes grow to 40 x 40 on phones so they are easy to tap; from `sm` up they keep their size.
        className={clsx(!iconOnly && 'px-2.5 sm:px-3', BELOW_40.has(size) && (iconOnly ? 'max-sm:h-10 max-sm:w-10' : 'max-sm:h-10 max-sm:min-w-10'), className)}
      >
        {iconOnly ? <Download aria-hidden /> : <span className="hidden sm:inline">{label}</span>}
      </Button>
    </Tooltip>
  );
}
