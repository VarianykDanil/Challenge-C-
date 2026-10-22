// Release 1.3 — /venues (every staff role) — OWNED BY P8 venue-insights. Every venue the team has worked, sorted by
// sales per shift, shifts or last visit, with a search; each opens its profile (/venues/:key). Figures are company-wide
// aggregates (no named rows), so every role sees the same list. Export: CSV now, PDF too once P4 lands (ExportButton).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, MapPinned, Search } from 'lucide-react';
import { VENUE_RULES, VENUE_SORTS, type VenueSortKey, type VenueSummary } from '@lm/shared';
import { Badge, EmptyState, Input, PageHeader, SegmentedControl } from '@/components/ui';
import { useCampaigns } from '@/api/hooks';
import { useVenues } from '@/api/venues';
import { ErrorState, ExportButton, ListSkeleton } from '@/features/common';
import { COPY } from '@/content/copy';
import { csvDate, csvFilename, type CsvColumn } from '@/lib/csv';
import { formatDateShort, formatDecimal, formatNumber, pluralise } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

const SORT_OPTIONS: { value: VenueSortKey; label: string }[] = [
  { value: 'sales_per_shift', label: 'Sales a shift' },
  { value: 'shifts', label: 'Shifts' },
  { value: 'last_visit', label: 'Last visit' },
];

const SORT_WORDS: Record<VenueSortKey, string> = { sales_per_shift: 'sales per shift', shifts: 'shifts', last_visit: 'last visit' };

const stopsPerSale = (v: VenueSummary) => (v.sales > 0 && v.stops ? v.stops / v.sales : null);

const CSV_COLUMNS: CsvColumn<VenueSummary>[] = [
  { key: 'venue', header: 'Venue' },
  { key: 'city', header: 'City' },
  { key: 'salesPerShift', header: 'Sales per shift' },
  { key: 'shifts', header: 'Shifts' },
  { key: 'eventCount', header: 'Visits' },
  { key: 'sales', header: 'Sales' },
  { key: 'stops', header: 'Stops', format: (_, v) => String(v.stops ?? '') },
  { key: 'stopsPerSale', header: 'Stops per sale', format: (_, v) => { const s = stopsPerSale(v); return s == null ? '' : String(Math.round(s * 10) / 10); } },
  { key: 'lastVisit', header: 'Last visit', format: (_, v) => csvDate(v.lastVisit) },
  { key: 'nextVisit', header: 'Next visit', format: (_, v) => csvDate(v.nextVisit ?? null) },
  { key: 'campaigns', header: 'Campaigns', format: (_, v) => v.campaigns.join(' ') },
];

export function VenuesPage() {
  usePageTitle(COPY.nav.venues.title);
  const [params, setParams] = useSearchParams();
  const raw = params.get('sort');
  const sort: VenueSortKey = VENUE_SORTS.includes(raw as VenueSortKey) ? (raw as VenueSortKey) : 'sales_per_shift';
  const [query, setQuery] = useState('');
  const q = useVenues(sort);
  const campaigns = useCampaigns();
  const colour = useMemo(() => new Map((campaigns.data ?? []).map((c) => [c.code, c.color])), [campaigns.data]);

  const all = q.data ?? [];
  const needle = query.trim().toLowerCase();
  const rows = needle ? all.filter((v) => `${v.venue} ${v.city}`.toLowerCase().includes(needle)) : all;
  // the company's figures are every venue's together: each counted shift belongs to exactly one venue
  const company = useMemo(() => {
    const shifts = all.reduce((n, v) => n + v.shifts, 0);
    const sales = all.reduce((n, v) => n + v.sales, 0);
    const stops = all.reduce((n, v) => n + (v.stops ?? 0), 0);
    return { shifts, salesPerShift: shifts ? sales / shifts : 0, stopsPerSale: sales ? stops / sales : null };
  }, [all]);
  const best = rows.reduce((m, v) => Math.max(m, v.salesPerShift), 0);

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/events" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Events</Link>}
        title={COPY.nav.venues.title}
        description={COPY.nav.venues.description}
        actions={
          <ExportButton
            filename={csvFilename('venues')}
            rows={rows}
            columns={CSV_COLUMNS}
            pdfTitle="Venues"
            pdfFilters={[`Sorted by ${SORT_WORDS[sort]}`, ...(needle ? [`Search: ${query.trim()}`] : [])]}
            auditWhat="venues"
          />
        }
      />

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 md:flex-row md:items-center md:justify-between" data-venues-filters>
        <SegmentedControl
          aria-label="Sort venues by"
          options={SORT_OPTIONS}
          value={sort}
          onChange={(v) => setParams((p) => { const next = new URLSearchParams(p); if (v === 'sales_per_shift') next.delete('sort'); else next.set('sort', v); return next; }, { replace: true })}
          fullWidth
          className="max-sm:h-11 md:w-auto"
        />
        <div className="md:w-72">
          <Input aria-label="Search venues" type="search" placeholder="Search venue or town" value={query} onChange={(e) => setQuery(e.target.value)} leftIcon={<Search className="h-4 w-4" aria-hidden />} />
        </div>
      </div>

      {q.isLoading ? (
        <ListSkeleton rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={<MapPinned className="h-8 w-8" aria-hidden />} title="No venues yet" description="Venues appear here once an event has been held or booked at them." />
      ) : (
        <div className="space-y-3">
          <div className="space-y-0.5 text-xs text-muted">
            <p>
              {pluralise(rows.length, 'venue')}{needle ? ` matching “${query.trim()}”` : ''}. Company-wide: {formatDecimal(company.salesPerShift)} sales a shift
              {company.stopsPerSale ? ` and a sale every ${formatNumber(Math.round(company.stopsPerSale))} stops` : ''} over {pluralise(company.shifts, 'shift')}; the tick on each bar marks it.
            </p>
            {sort === 'sales_per_shift' && <p>Venues with fewer than {VENUE_RULES.rankMinShifts} shifts come after the rest: too few shifts to rank.</p>}
          </div>
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">No venue matches “{query.trim()}”.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3" data-venue-cards>
              {rows.map((v) => <VenueCard key={v.key} venue={v} best={best} companyRate={company.salesPerShift} colour={colour} />)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function VenueCard({ venue: v, best, companyRate, colour }: { venue: VenueSummary; best: number; companyRate: number; colour: Map<string, string> }) {
  const sps = stopsPerSale(v);
  return (
    <li>
      <Link
        to={`/venues/${v.key}`}
        className="flex h-full flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm transition hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${v.venue}, ${v.city}: ${v.shifts ? `${formatDecimal(v.salesPerShift)} sales a shift over ${pluralise(v.shifts, 'shift')}` : 'no shifts yet'}`}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-fg">{v.venue}</span>
            <span className="block truncate text-xs text-muted">{v.city}</span>
          </span>
          {v.shifts > 0 ? (
            <span className="shrink-0 text-right">
              <span className="kpi-number block text-xl leading-none text-fg">{formatDecimal(v.salesPerShift)}</span>
              <span className="text-[11px] text-muted">sales a shift</span>
            </span>
          ) : (
            <Badge tone="neutral" size="sm">No shifts yet</Badge>
          )}
        </span>
        {v.shifts > 0 && (
          // decorative: sales a shift against the best venue listed; the tick marks the company-wide figure
          <span className="relative block h-1.5 w-full rounded-full bg-surface-3/80" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, (v.salesPerShift / Math.max(best, 0.01)) * 100)}%` }} />
            {companyRate > 0 && best > 0 && <span className="absolute -inset-y-0.5 w-0.5 rounded-full bg-fg/60" style={{ left: `${Math.min(100, (companyRate / best) * 100)}%` }} />}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {v.shifts > 0 && <span>{pluralise(v.shifts, 'shift')} · {pluralise(v.eventCount, 'visit')}{v.shifts < VENUE_RULES.rankMinShifts ? ' (few yet)' : ''}</span>}
          {sps != null && <span>a sale every {formatNumber(Math.round(sps))} stops</span>}
          {v.lastVisit && <span>last {formatDateShort(v.lastVisit)}</span>}
          {v.nextVisit && (
            <span className="inline-flex items-center gap-1 font-medium text-primary"><CalendarClock className="h-3 w-3" aria-hidden />next {formatDateShort(v.nextVisit)}</span>
          )}
        </span>
        {v.campaigns.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {v.campaigns.map((c) => <Badge key={c} tone="neutral" dot color={colour.get(c)} size="sm">{c}</Badge>)}
          </span>
        )}
      </Link>
    </li>
  );
}
