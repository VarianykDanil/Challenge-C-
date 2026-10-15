// "Download as CSV" button for card and page header action areas. Shows the label from `sm` up and
// collapses to the icon on phones (the label stays as the accessible name).
import { Download } from 'lucide-react';
import clsx from 'clsx';
import { Button, Tooltip, useToast, type ButtonSize, type TooltipSide } from '@/components/ui';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/csv';
import { formatNumber } from '@/lib/format';

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
        className={clsx(!iconOnly && 'px-2.5 sm:px-3', className)}
      >
        {iconOnly ? <Download aria-hidden /> : <span className="hidden sm:inline">{label}</span>}
      </Button>
    </Tooltip>
  );
}
