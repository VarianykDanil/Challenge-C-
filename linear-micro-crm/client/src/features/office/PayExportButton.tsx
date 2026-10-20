// Release 1.2 — U5 office-tools. "Export for payroll": one pay week's unpaid runs (pending and failed transfers) as a
// CSV for Xero Payroll or Sage Payroll (GET /finance/payroll/export, admin only; server/src/routes/payExport.ts).
// Mounted in pages/Finance.tsx in the "Runs to pay" card header, before "Export CSV", in an ErrorBoundary.
// `runs` are the runs the card lists: their weeks (newest first, at most four) are the choices.
import { useMemo, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import clsx from 'clsx';
import { PAY_EXPORT_FORMATS, PAY_EXPORT_FORMAT_LABELS, payExportFilename, type PayExportFormat, type PayrollRunWithUser } from '@lm/shared';
import { Button, Dropdown, useToast, type DropdownItem } from '@/components/ui';
import { payExportUrl } from '@/api/search';
import { downloadCsv } from '@/lib/csv';
import { formatDateShort, formatNumber } from '@/lib/format';

export interface PayExportButtonProps {
  runs: PayrollRunWithUser[];
  className?: string;
}

const MAX_WEEKS = 4;

export function PayExportButton({ runs, className }: PayExportButtonProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const weeks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.weekStart, (counts.get(r.weekStart) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, MAX_WEEKS);
  }, [runs]);

  const download = async (weekStart: string, format: PayExportFormat) => {
    setBusy(true);
    const filename = payExportFilename(weekStart, format);
    try {
      const res = await fetch(payExportUrl(weekStart, format), { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${res.status}`);
      }
      const csv = await res.text();
      const rows = Number(res.headers.get('X-Total-Count') ?? 0);
      downloadCsv(filename, csv);
      toast.success(`Exported ${formatNumber(rows)} run${rows === 1 ? '' : 's'} for ${PAY_EXPORT_FORMAT_LABELS[format]}`, filename);
    } catch (e) {
      toast.error('Could not export for payroll', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (weeks.length === 0) return null;

  const items: DropdownItem[] = weeks.flatMap(([weekStart, count], wi) =>
    PAY_EXPORT_FORMATS.map((format, fi) => ({
      label: (
        <span className="flex min-w-0 flex-col">
          <span>{PAY_EXPORT_FORMAT_LABELS[format]}</span>
          <span className="text-xs text-muted">Week of {formatDateShort(weekStart)} · {count} {count === 1 ? 'run' : 'runs'}</span>
        </span>
      ),
      onSelect: () => { void download(weekStart, format); },
      separatorBefore: wi > 0 && fi === 0,
      disabled: busy,
    })),
  );

  return (
    <Dropdown
      align="end"
      width={260}
      header={<p className="px-2.5 py-1.5 text-xs text-muted">Unpaid runs of one week, as a CSV your payroll software imports</p>}
      items={items}
      trigger={(
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label="Export for payroll"
          leftIcon={<FileSpreadsheet aria-hidden />}
          className={clsx('px-2.5 sm:px-3', className)}
          data-pay-export=""
        >
          <span className="hidden sm:inline">Export for payroll</span>
        </Button>
      )}
    />
  );
}
