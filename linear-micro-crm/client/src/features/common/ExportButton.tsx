// "Export ▾" for card and page header action areas: a menu with **CSV** (a spreadsheet, opens in Excel) and **PDF**
// (to print or share) built from the same columns and rows. Shows the label from `sm` up and collapses to the icon on
// phones (the label stays as the accessible name).
// Release 1.3 — OWNED BY P4 pdf-everywhere. The PDF comes from lib/pdf exportTablePdf (jsPDF loads in its own chunk on
// the first PDF, and starts loading when the menu opens); its title comes from the file name, its subtitle from the
// page heading and its filter lines from the file name and the filters set on screen beside the button (shared
// pdfHeadingFor, features/pdf/report.ts screenFiltersNear; `pdfScreenFilters` when the filters are not beside the
// button) unless `pdfTitle` / `pdfFilters` say better. Every export is
// reported to the audit trail (POST /audit/events; a report made without signal waits on the device and is sent when
// the signal is back). The menu opens above the toast stack, so a toast never covers its items.
// `pdf={false}`, or PDF_EXPORTS_READY false, leaves the single CSV button. The props are the contract: every call site
// keeps working unchanged.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText } from 'lucide-react';
import clsx from 'clsx';
import { pdfFilenameFor, pdfHeadingFor } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Dropdown, Tooltip, useToast, type ButtonSize, type DropdownItem, type TooltipSide } from '@/components/ui';
import { armExportReports, pageHeadingNear, reportExport, screenFiltersNear } from '@/features/pdf/report';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/csv';
import { toISODate } from '@/lib/dates';
import { formatNumber, fullName } from '@/lib/format';
import { PDF_EXPORTS_READY, exportTablePdf, preloadPdf } from '@/lib/pdf';

/** Button sizes under 40 px tall. */
const BELOW_40: ReadonlySet<ButtonSize> = new Set<ButtonSize>(['xs', 'sm', 'icon-sm', 'icon-xs']);

export interface ExportButtonProps<T extends object> {
  /** Visible text (from `sm` up) and the button's accessible name. */
  label?: string;
  /** Full file name including `.csv` — build it with `csvFilename()`. The PDF gets the same name ending in `.pdf`. */
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
  /**
   * Release 1.3 (P4): lines under the title — the filters on screen. Default: what the file name says (status, team,
   * dates) plus the drop-downs and search box set in the button's own filter bar (report.ts screenFiltersNear).
   */
  pdfFilters?: string[];
  /**
   * Release 1.3 fix round (I3): the filters set on screen, in words ("Source: Indeed", "Team: Deansgate"), for a
   * button that sits away from its filter bar (a board column) or a view whose scope is not a control (a rep's own
   * team). Used instead of what is read beside the button, and printed the same way: with what the file name says
   * (a line with the same label gives way to it) and the date range last. Ignored when `pdfFilters` is given.
   */
  pdfScreenFilters?: string[];
  /** Release 1.3 (P4): a totals row for the PDF, keyed by column key (formatted). */
  pdfTotals?: Partial<Record<string, string>>;
  /** Release 1.3 (P9): what the audit trail calls this export, e.g. "gauges-by-team" (default: from `filename`). */
  auditWhat?: string;
}

const rowsLabel = (n: number) => `${formatNumber(n)} row${n === 1 ? '' : 's'}`;


/** A menu item's two lines: the format, and what it is for (also keeps the item at least 40 px tall). */
function ItemLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="block py-0.5">
      <span className="block font-medium text-fg">{title}</span>
      <span className="block text-xs text-muted">{hint}</span>
    </span>
  );
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
  pdf = true,
  pdfTitle,
  pdfFilters,
  pdfScreenFilters,
  pdfTotals,
  auditWhat,
}: ExportButtonProps<T>) {
  const toast = useToast();
  const { user } = useAuth();
  const anchor = useRef<HTMLSpanElement>(null);
  const [busy, setBusy] = useState(false);
  const ownerId = user?.id ?? null;
  // send any export reports that waited on this device for want of signal
  useEffect(() => armExportReports(ownerId), [ownerId]);
  const empty = rows.length === 0;
  const iconOnly = size.startsWith('icon');
  const withPdf = PDF_EXPORTS_READY && pdf;
  // The smaller sizes grow to 40 x 40 on phones so they are easy to tap; from `sm` up they keep their size.
  const tapClass = clsx(!iconOnly && 'px-2.5 sm:px-3', BELOW_40.has(size) && (iconOnly ? 'max-sm:h-10 max-sm:w-10' : 'max-sm:h-10 max-sm:min-w-10'), className);

  const exportCsv = () => {
    if (empty) return;
    try {
      downloadCsv(filename, toCsv(rows, columns));
      toast.success(`Exported ${rowsLabel(rows.length)}`, filename);
      reportExport('csv', filename, rows.length, auditWhat, ownerId);
    } catch (e) {
      toast.error('Could not export', e instanceof Error ? e.message : undefined);
    }
  };

  const exportPdf = async () => {
    if (empty || busy) return;
    setBusy(true);
    const snapshot = rows; // exactly the rows on screen when the item was picked
    const pdfName = pdfFilenameFor(filename);
    try {
      const heading = pdfHeadingFor({
        filename,
        pageHeading: pageHeadingNear(anchor.current),
        today: toISODate(new Date()),
        screenFilters: pdfScreenFilters ?? screenFiltersNear(anchor.current),
      });
      const subtitle = pdfTitle ? (heading.subtitle && heading.subtitle !== pdfTitle ? heading.subtitle : undefined) : heading.subtitle;
      await exportTablePdf({
        title: pdfTitle ?? heading.title,
        subtitle,
        filters: pdfFilters ?? heading.filters,
        columns,
        rows: snapshot,
        totals: pdfTotals,
        filename: pdfName,
        generatedBy: user ? fullName(user) : null,
      });
      toast.success(`Exported ${rowsLabel(snapshot.length)} as a PDF`, pdfName);
      reportExport('pdf', pdfName, snapshot.length, auditWhat, ownerId);
    } catch (e) {
      toast.error('Could not make the PDF', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  // "Export CSV" (the default) reads "Export" once the menu offers both formats; a custom label stays as given.
  const menuLabel = !withPdf ? label : label === 'Export CSV' ? 'Export' : label.replace(/\s+CSV$/i, '');

  if (!withPdf || empty) {
    return (
      // The bubble is absolutely positioned and would widen the page on phones, where nothing hovers anyway.
      <Tooltip content={empty ? emptyHint : 'Download as CSV (Excel)'} side={tooltipSide} className="max-sm:[&_[role=tooltip]]:hidden">
        <Button
          variant="outline"
          size={size}
          disabled={disabled || empty}
          onClick={exportCsv}
          aria-label={menuLabel}
          title={empty ? emptyHint : undefined}
          leftIcon={iconOnly ? undefined : <Download aria-hidden />}
          className={tapClass}
        >
          {iconOnly ? <Download aria-hidden /> : <span className="hidden sm:inline">{menuLabel}</span>}
        </Button>
      </Tooltip>
    );
  }

  const items: DropdownItem[] = [
    { label: <ItemLabel title="CSV" hint="Spreadsheet · opens in Excel" />, icon: <FileSpreadsheet />, onSelect: exportCsv },
    { label: <ItemLabel title="PDF" hint="To print or share" />, icon: <FileText />, onSelect: () => void exportPdf() },
  ];

  return (
    <span ref={anchor} className="inline-flex">
      <Dropdown
        align="end"
        width={232}
        items={items}
        // near the foot of the window the menu opens upwards, where the toasts sit: keep it above them
        aboveToasts
        onOpenChange={(open) => open && preloadPdf()}
        trigger={
          <Button
            variant="outline"
            size={size}
            disabled={disabled || busy}
            loading={busy}
            aria-label={busy ? `${menuLabel}: making the PDF` : menuLabel}
            leftIcon={iconOnly ? undefined : <Download aria-hidden />}
            className={tapClass}
          >
            {iconOnly ? (
              busy ? null : <Download aria-hidden />
            ) : (
              // label and chevron from `sm` up; a phone shows the icon only (the label is the accessible name)
              <span className="hidden items-center gap-1 sm:inline-flex">{menuLabel}<ChevronDown className="-mr-0.5 opacity-70" aria-hidden /></span>
            )}
          </Button>
        }
      />
    </span>
  );
}
