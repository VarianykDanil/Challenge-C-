// "Payroll spreadsheet": one pay week's unpaid runs (pending and failed transfers) as a CSV for the accountant or payroll
// software to map — not a file in any product's own import layout (GET /finance/payroll/export, admin only;
// server/src/routes/payExport.ts). Everyone, or the self-billed field people and the office staff apart.
// Mounted in pages/Finance.tsx in the "Runs to pay" card header, before "Export CSV", in an ErrorBoundary.
// `runs` are the runs the card lists: every week among them (newest first) is a choice, failed transfers included.
import { useMemo, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import clsx from 'clsx';
import { PAY_EXPORT_LABEL, PAY_EXPORT_PEOPLE, PAY_EXPORT_PEOPLE_LABELS, payExportFilename, type PayExportPeople, type PayrollRunWithUser } from '@lm/shared';
import { Button, Dropdown, useToast, type DropdownItem } from '@/components/ui';
import { payExportUrl } from '@/api/search';
import { downloadCsv } from '@/lib/csv';
import { formatDateShort, formatNumber } from '@/lib/format';

export interface PayExportButtonProps {
  runs: PayrollRunWithUser[];
  className?: string;
}

export function PayExportButton({ runs, className }: PayExportButtonProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const weeks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.weekStart, (counts.get(r.weekStart) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [runs]);

  const download = async (weekStart: string, people: PayExportPeople) => {
    setBusy(true);
    const filename = payExportFilename(weekStart, people);
    try {
      const res = await fetch(payExportUrl(weekStart, people), { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${res.status}`);
      }
      const csv = await res.text();
      const rows = Number(res.headers.get('X-Total-Count') ?? 0);
      downloadCsv(filename, csv);
      toast.success(`Exported ${formatNumber(rows)} run${rows === 1 ? '' : 's'} to the payroll spreadsheet`, filename);
    } catch (e) {
      toast.error('Could not make the payroll spreadsheet', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (weeks.length === 0) return null;

  const items: DropdownItem[] = weeks.flatMap(([weekStart, count], wi) =>
    PAY_EXPORT_PEOPLE.map((people, pi) => ({
      label: (
        <span className="flex min-w-0 flex-col">
          <span>{PAY_EXPORT_PEOPLE_LABELS[people]}</span>
          <span className="text-xs text-muted">Week of {formatDateShort(weekStart)}{people === 'all' ? ` · ${count} ${count === 1 ? 'run' : 'runs'}` : ''}</span>
        </span>
      ),
      onSelect: () => { void download(weekStart, people); },
      separatorBefore: wi > 0 && pi === 0,
      disabled: busy,
    })),
  );

  return (
    <Dropdown
      align="end"
      width={280}
      header={<p className="px-2.5 py-1.5 text-xs text-muted">{PAY_EXPORT_LABEL}: one week’s unpaid runs. Each row adds up, with corrections and VAT in their own columns.</p>}
      items={items}
      trigger={(
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label="Payroll spreadsheet (CSV)"
          leftIcon={<FileSpreadsheet aria-hidden />}
          className={clsx('px-2.5 max-sm:h-10 max-sm:min-w-10 sm:px-3', className)}
          data-pay-export=""
        >
          <span className="hidden sm:inline">Payroll spreadsheet</span>
        </Button>
      )}
    />
  );
}
