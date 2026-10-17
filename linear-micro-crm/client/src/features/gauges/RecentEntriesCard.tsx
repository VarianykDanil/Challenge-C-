// "Recent entries" for one person: pages through GET /gauges (limit + offset, total from X-Total-Count) with a
// "Load more" button. Falls back to the rows the performance payload carries when the viewer may not call /gauges
// for that person (reps only read their own) or when the server does not page yet.
import type { GaugeEntryWithMeta } from '@lm/shared';
import { Button, Card, CardHeader } from '@/components/ui';
import { GAUGES_PAGE_SIZE, useGaugesPaged } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ExportButton } from '@/features/common';
import { csvFilename, sortRows } from '@/lib/csv';
import type { DateRange } from '@/lib/dates';
import { formatNumber, formatRangeLabel } from '@/lib/format';
import { GaugeEntriesTable } from './GaugeEntriesTable';
import { gaugeEntryCsvColumns } from './csv';

export function RecentEntriesCard({ userId, range, fallback, who }: {
  /** Whose entries; without it (or a range) the card shows `fallback` only. */
  userId?: number;
  range?: DateRange;
  /** The latest entries from the performance payload, shown when paging is not available. */
  fallback: GaugeEntryWithMeta[];
  /** Name used in the export file name. */
  who: string;
}) {
  const me = useCurrentUser();
  const mayPage = userId != null && !!range && (me.role !== 'rep' || userId === me.id);
  const q = useGaugesPaged({ userId: userId ?? null, from: range?.from, to: range?.to }, { enabled: mayPage });
  const pages = q.data?.pages ?? [];
  const paged = mayPage && !q.isError;
  const rows = paged ? pages.flatMap((p) => p.rows) : fallback;
  const total = pages.length ? pages[pages.length - 1]!.total : null;
  const loading = paged && q.isPending;
  const remaining = total != null ? Math.max(0, total - rows.length) : 0;

  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="p-5 pb-3">
        <CardHeader
          title="Recent entries"
          description={paged && range ? `Days logged ${formatRangeLabel(range.from, range.to)}${total != null ? ` · ${formatNumber(total)} entr${total === 1 ? 'y' : 'ies'}` : ''}` : 'Latest days logged'}
          className="mb-0"
          actions={<ExportButton filename={csvFilename(`gauges-${who}-entries`, range)} rows={sortRows(rows, (r) => r.date, 'desc')} columns={gaugeEntryCsvColumns()} disabled={loading} />}
        />
      </div>
      <GaugeEntriesTable rows={rows} loading={loading} showPerson={false} bare className="border-t border-border" emptyMessage={paged ? 'No days logged in this range' : 'No gauge entries yet'} />
      {paged && q.hasNextPage && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted">
          <span>Showing {formatNumber(rows.length)} of {formatNumber(total ?? rows.length)}</span>
          <Button size="sm" variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load {formatNumber(Math.min(GAUGES_PAGE_SIZE, remaining))} more
          </Button>
        </div>
      )}
    </Card>
  );
}
