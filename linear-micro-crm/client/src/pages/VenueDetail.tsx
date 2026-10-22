// Release 1.3 — /venues/:key (every staff role) — OWNED BY P8 venue-insights. One venue's numbers: per shift against
// the company, the law of averages (the scatter, the fitted rate, the three stop groups, how steady each ratio is from
// visit to visit), your own numbers here, by campaign and weekday (each against the same campaign / weekday
// company-wide: the six gauges per shift and the five steps), named people for the admin and a leader (own team), and
// every event at the venue. Reps see aggregates only (the server sends no named rows to them). Export: the events as
// CSV (and PDF once P4 lands), and — only while lib/pdf PDF_EXPORTS_READY is true — the whole page as a Venue report.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowLeft, CalendarDays, MapPinned, Sigma, Users } from 'lucide-react';
import { GAUGE_KEYS, GAUGE_LABELS, isVenueKey, type FunnelRatios, type GaugeTotals, type VenueProfile, type VenueStabilityKey } from '@lm/shared';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, KpiTile, PageHeader, SegmentedControl, Skeleton } from '@/components/ui';
import { BarsChart } from '@/components/charts';
import { useVenue } from '@/api/venues';
import { ApiError } from '@/api/client';
import { ErrorState, EventStatusBadge, EventTypeBadge, ExportButton, KpiSkeletons } from '@/features/common';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { DirectionsLink } from '@/features/events';
import { LawOfAveragesChart } from '@/features/venues/LawOfAveragesChart';
import { VenueReportButton } from '@/features/venues/VenueReportButton';
import { STABILITY_LABELS, STABILITY_TEXT, STABILITY_TONE, WEEKDAY_LONG, WEEKDAY_SHORT } from '@/features/venues/venueCopy';
import { COPY } from '@/content/copy';
import { csvFilename, csvDate, type CsvColumn } from '@/lib/csv';
import { PDF_EXPORTS_READY } from '@/lib/pdf';
import { formatDate, formatDateShort, formatDecimal, formatNumber, formatPct, pluralise } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { todayISO } from '@/lib/dates';
import { NotFoundPage } from './NotFound';

type VenueEvent = VenueProfile['events'][number];

const EVENT_COLUMNS: CsvColumn<VenueEvent>[] = [
  { key: 'date', header: 'Date', format: (v) => csvDate(v) },
  { key: 'name', header: 'Event' },
  { key: 'teamName', header: 'Team' },
  { key: 'campaignCode', header: 'Campaign' },
  { key: 'status', header: 'Status' },
  { key: 'people', header: 'People logged' },
  { key: 'sales', header: 'Sales' },
  { key: 'booked', header: 'Booked', format: (_, e) => (e.booked == null ? '' : String(e.booked)) },
];

/** relativeChange as a fraction, null when there is nothing to compare with. */
const delta = (here: number, company: number) => (company > 0 ? here / company - 1 : null);

const STABILITY_ORDER: VenueStabilityKey[] = ['overallConversion', 'stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale'];

export function VenueDetailPage() {
  const { key = '' } = useParams();
  const valid = isVenueKey(key);
  const q = useVenue(valid ? key : null);
  const v = q.data;
  usePageTitle(v ? v.venue : COPY.nav.venues.title);

  if (!valid || (q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400))) return <NotFoundPage />;

  const back = <Link to="/venues" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10"><ArrowLeft className="h-3 w-3" aria-hidden /> Venues</Link>;
  if (q.isError) return (<><PageHeader breadcrumbs={back} title={COPY.nav.venues.title} /><ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this venue" /></>);

  return (
    <>
      <PageHeader
        breadcrumbs={back}
        title={v ? v.venue : <Skeleton className="h-7 w-56" />}
        description={
          v ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><MapPinned className="h-3.5 w-3.5" aria-hidden />{v.city}<DirectionsLink variant="text" venue={v.venue} city={v.city} className="-my-1.5 ml-0.5" /></span>
              <span>{pluralise(v.eventCount, 'visit')} · {pluralise(v.shifts, 'shift')}</span>
              {v.lastVisit && <span>Last visit {formatDateShort(v.lastVisit)}</span>}
              {v.nextVisit && <span className="font-medium text-primary">Next {formatDateShort(v.nextVisit)}</span>}
            </span>
          ) : undefined
        }
        actions={
          v ? (
            <>
              {PDF_EXPORTS_READY && <ErrorBoundary name="venue-report" fallback={null}><VenueReportButton venue={v} /></ErrorBoundary>}
              <ExportButton filename={csvFilename(`venue-${v.key}`)} rows={v.events} columns={EVENT_COLUMNS} label="Export events" pdfTitle={`${v.venue}, ${v.city}: events`} auditWhat="venue-events" />
            </>
          ) : undefined
        }
      />
      {!v ? (
        <div className="space-y-6"><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><KpiSkeletons count={4} /></div><Skeleton className="h-72" /></div>
      ) : (
        <VenueBody v={v} />
      )}
    </>
  );
}

function VenueBody({ v }: { v: VenueProfile }) {
  const law = v.lawOfAverages;
  const sps = law.stopsPerSale ?? null;
  const companySps = v.company.ratios.stopsPerSale;
  const companySales = v.company.salesPerShift ?? v.company.perShift.sales;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Sales a shift" value={v.shifts ? formatDecimal(v.salesPerShift) : '—'} delta={v.shifts ? delta(v.salesPerShift, companySales) : null} deltaLabel="vs company" hint={`Company ${formatDecimal(companySales)}`} />
        <KpiTile label="Stops per sale" value={sps ? formatNumber(Math.round(sps)) : '—'} delta={sps && companySps ? delta(sps, companySps) : null} invertDelta deltaLabel="vs company" hint={companySps ? `Company ${formatNumber(Math.round(companySps))}` : undefined} />
        <KpiTile label="Stops a shift" value={v.shifts ? formatNumber(Math.round(v.perShift.stops)) : '—'} delta={v.shifts ? delta(v.perShift.stops, v.company.perShift.stops) : null} deltaLabel="vs company" hint={`Company ${formatNumber(Math.round(v.company.perShift.stops))}`} />
        <KpiTile label="Shifts" value={formatNumber(v.shifts)} hint={`${pluralise(v.eventCount, 'visit')}${v.campaigns.length ? ` · ${v.campaigns.join(', ')}` : ''}`} />
      </div>

      <LawCard v={v} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <CompareCard v={v} />
        <div className="space-y-6">
          {v.you && <YouCard v={v} />}
          <CampaignCard v={v} />
          <WeekdayCard v={v} />
        </div>
      </div>

      <div className={clsx('grid grid-cols-1 items-start gap-6', v.people && 'lg:grid-cols-2')}>
        {v.people && <PeopleCard v={v} />}
        <EventsCard v={v} />
      </div>
    </div>
  );
}

/** The law of averages: the sentence, the scatter, the three stop groups and how steady each ratio is. */
function LawCard({ v }: { v: VenueProfile }) {
  const law = v.lawOfAverages;
  const bands = law.bands ?? [];
  const fewest = bands.find((b) => b.band === 'fewest');
  const most = bands.find((b) => b.band === 'most');
  const ratio = fewest && most && fewest.salesPerShift > 0 ? most.salesPerShift / fewest.salesPerShift : null;
  return (
    <Card data-law-of-averages>
      <CardHeader icon={<Sigma />} title="The law of averages" description={`Every shift logged at ${v.venue}: more stops, more sales, at a steady rate.`} />
      <p className="max-w-3xl font-display text-lg font-semibold leading-snug text-fg sm:text-xl">{law.sentence}</p>
      <div className="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <LawOfAveragesChart points={law.points} fittedRate={law.fittedRate} bands={bands} />
          {law.pointsCapped && <p className="mt-1 text-xs text-muted">The chart shows the {formatNumber(law.points.length)} most recent shifts; every figure uses all {formatNumber(v.shifts)}.</p>}
        </div>
        <div className="min-w-0 space-y-4">
          {bands.length > 0 && (
            <section aria-labelledby="venue-bands">
              <h4 id="venue-bands" className="eyebrow mb-2 text-muted">Shifts in three groups by stops</h4>
              <ul className="grid grid-cols-3 gap-2">
                {bands.map((b) => (
                  <li key={b.band} className="rounded-lg border border-border bg-surface-2/60 p-2.5">
                    <span className="block text-[11px] font-medium text-muted">{b.band === 'fewest' ? 'Fewest stops' : b.band === 'most' ? 'Most stops' : 'Middle'}</span>
                    <span className="block text-[11px] text-muted">{formatNumber(b.minStops)}–{formatNumber(b.maxStops)} stops</span>
                    <span className="kpi-number block text-xl text-fg">{formatDecimal(b.salesPerShift)}</span>
                    <span className="block text-[11px] text-muted">sales a shift</span>
                  </li>
                ))}
              </ul>
              {ratio != null && ratio > 1.05 && (
                <p className="mt-2 text-xs text-muted">
                  The busiest shifts (about {formatNumber(Math.round(most!.avgStops))} stops) sold {formatDecimal(ratio)} times as much as the quietest (about {formatNumber(Math.round(fewest!.avgStops))}): the rate holds, so volume is the lever.
                </p>
              )}
            </section>
          )}
          {law.steadiness && Object.keys(law.steadiness).length > 0 && (
            <section aria-labelledby="venue-stability">
              <h4 id="venue-stability" className="eyebrow mb-2 text-muted">How steady each step is, visit to visit</h4>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {STABILITY_ORDER.filter((k) => law.steadiness?.[k]).map((k) => {
                  const label = law.steadiness![k]!;
                  const cv = law.stability[k as keyof typeof law.stability];
                  const chance = law.chanceCv?.[k];
                  const rate = k === 'overallConversion' ? v.ratios.overallConversion : v.ratios[k as keyof typeof v.ratios];
                  return (
                    <li key={k} className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5 text-sm">
                      <span className="min-w-0">
                        <span className="text-fg">{STABILITY_LABELS[k]}</span>{' '}
                        <span className="tabular text-xs text-muted">{typeof rate === 'number' ? formatPct(rate, k === 'overallConversion' ? 1 : 0) : ''}</span>
                        {cv != null && chance != null && (
                          <span className="block text-[11px] text-muted">spread {formatPct(cv)} from visit to visit · luck alone about {formatPct(chance)}</span>
                        )}
                      </span>
                      <Badge tone={STABILITY_TONE[label]} size="sm">{STABILITY_TEXT[label]}</Badge>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-muted">Steady: the visits differ by no more than luck alone would explain{law.visits ? ` (over ${pluralise(law.visits, 'visit')})` : ''}.</p>
            </section>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The six gauges per shift and the five steps of a group, here against the same group company-wide. */
interface Figures {
  perShift: GaugeTotals;
  ratios: FunnelRatios;
}

const RATIO_ROWS: [keyof FunnelRatios, string][] = [
  ['stopToTable', 'Stop → table'],
  ['tableToPresentation', 'Table → presentation'],
  ['presentationToClose', 'Presentation → close'],
  ['closeToTap', 'Close → tap'],
  ['tapToSale', 'Tap → sale'],
];

/** Gauge by gauge per shift, then the stage ratios, "Here" against "Company" (an arrow when a step is 5% off). */
function CompareTable({ here, company, label }: { here: Figures; company: Figures; label?: string }) {
  return (
    <table className="w-full text-sm" aria-label={label}>
      <thead className="border-y border-border bg-surface-2 text-xs text-muted">
        <tr><th scope="col" className="px-5 py-2 text-left font-medium">Per shift</th><th scope="col" className="px-3 py-2 text-right font-medium">Here</th><th scope="col" className="px-5 py-2 text-right font-medium">Company</th></tr>
      </thead>
      <tbody className="divide-y divide-border">
        {GAUGE_KEYS.map((k) => (
          <tr key={k}>
            <th scope="row" className="px-5 py-2 text-left font-normal text-fg">{GAUGE_LABELS[k]}</th>
            <td className="tabular px-3 py-2 text-right font-semibold text-fg">{formatDecimal(here.perShift[k])}</td>
            <td className="tabular px-5 py-2 text-right text-muted">{formatDecimal(company.perShift[k])}</td>
          </tr>
        ))}
      </tbody>
      <thead className="border-y border-border bg-surface-2 text-xs text-muted">
        <tr><th scope="col" className="px-5 py-2 text-left font-medium">Step</th><th scope="col" className="px-3 py-2 text-right font-medium">Here</th><th scope="col" className="px-5 py-2 text-right font-medium">Company</th></tr>
      </thead>
      <tbody className="divide-y divide-border">
        {RATIO_ROWS.map(([k, rowLabel]) => {
          const h = here.ratios[k] as number | null;
          const c = company.ratios[k] as number | null;
          // an arrow only when the step is more than 5% (relative) above or below the company's
          const rel = h != null && c != null && c > 0 ? h / c - 1 : 0;
          const diff = Math.abs(rel) > 0.05 ? rel : 0;
          return (
            <tr key={k}>
              <th scope="row" className="px-5 py-2 text-left font-normal text-fg">{rowLabel}</th>
              <td className="tabular px-3 py-2 text-right font-semibold text-fg">
                {h == null ? '—' : formatPct(h)}
                {diff !== 0 && (
                  <span className={clsx('ml-1 text-xs font-normal', diff > 0 ? 'text-success' : 'text-warning')}>
                    <span aria-hidden>{diff > 0 ? '▲' : '▼'}</span>
                    <span className="sr-only">{diff > 0 ? ' above the company' : ' below the company'}</span>
                  </span>
                )}
              </td>
              <td className="tabular px-5 py-2 text-right text-muted">{c == null ? '—' : formatPct(c)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Per shift here against the company, gauge by gauge, then the stage ratios. */
function CompareCard({ v }: { v: VenueProfile }) {
  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="p-5 pb-3"><CardHeader className="mb-0" title="A shift here and company-wide" description={`Averages per shift: ${pluralise(v.shifts, 'shift')} here, ${pluralise(v.company.shifts ?? 0, 'shift')} company-wide.`} /></div>
      <CompareTable here={v} company={v.company} label="A shift here and company-wide" />
    </Card>
  );
}

function YouCard({ v }: { v: VenueProfile }) {
  const you = v.you!;
  const yourSps = you.ratios.stopsPerSale;
  return (
    <Card tone="primary" data-venue-you>
      <CardHeader title="Your numbers here" description={`${pluralise(you.shifts, 'shift')} at ${v.venue}.`} className="mb-3" />
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-muted">Sales a shift</dt><dd className="kpi-number text-xl text-fg">{formatDecimal(you.salesPerShift)}</dd><dd className="text-[11px] text-muted">venue {formatDecimal(v.salesPerShift)}</dd></div>
        <div><dt className="text-xs text-muted">Stops a shift</dt><dd className="kpi-number text-xl text-fg">{formatNumber(Math.round(you.perShift.stops))}</dd><dd className="text-[11px] text-muted">venue {formatNumber(Math.round(v.perShift.stops))}</dd></div>
        <div><dt className="text-xs text-muted">Stops per sale</dt><dd className="kpi-number text-xl text-fg">{yourSps ? formatNumber(Math.round(yourSps)) : '—'}</dd><dd className="text-[11px] text-muted">venue {v.ratios.stopsPerSale ? formatNumber(Math.round(v.ratios.stopsPerSale)) : '—'}</dd></div>
      </dl>
    </Card>
  );
}

function CampaignCard({ v }: { v: VenueProfile }) {
  const [code, setCode] = useState<string | null>(null);
  if (!v.byCampaign.length) return null;
  const chosen = v.byCampaign.find((c) => c.code === code) ?? v.byCampaign[0]!;
  return (
    <Card padded={false} className="min-w-0 overflow-hidden" data-venue-campaigns>
      <div className="p-5 pb-3">
        <CardHeader title="By campaign" description="Per shift at this venue, against the same campaign company-wide." className="mb-3" />
        <ul className="divide-y divide-border">
          {v.byCampaign.map((c) => (
            <li key={c.campaignId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2"><Badge tone="neutral" dot color={c.color}>{c.code}</Badge><span className="truncate text-muted">{c.name}</span></span>
              <span className="ml-auto shrink-0 text-right">
                <span className="tabular font-semibold text-fg">{formatDecimal(c.salesPerShift ?? c.perShift.sales)}</span> <span className="text-xs text-muted">sales a shift · {pluralise(c.shifts, 'shift')}</span>
                {c.company && <span className="block text-[11px] text-muted">{formatDecimal(c.company.salesPerShift)} company-wide</span>}
              </span>
            </li>
          ))}
        </ul>
        {v.byCampaign.length > 1 && (
          <SegmentedControl
            className="mt-3 max-w-full"
            aria-label="Campaign to compare"
            value={chosen.code}
            onChange={setCode}
            options={v.byCampaign.map((c) => ({ value: c.code, label: c.code }))}
          />
        )}
      </div>
      {chosen.ratios && chosen.company && (
        <>
          <p className="px-5 pb-2 text-xs text-muted">{chosen.code}: {pluralise(chosen.shifts, 'shift')} here, {pluralise(chosen.company.shifts, 'shift')} company-wide.</p>
          <CompareTable here={{ perShift: chosen.perShift, ratios: chosen.ratios }} company={chosen.company} label={`${chosen.code} here and company-wide`} />
        </>
      )}
    </Card>
  );
}

function WeekdayCard({ v }: { v: VenueProfile }) {
  const [picked, setPicked] = useState<string | null>(null);
  const data = v.byWeekday.map((d) => ({ label: WEEKDAY_SHORT[d.weekday] ?? String(d.weekday), value: d.salesPerShift }));
  const best = [...v.byWeekday].filter((d) => d.shifts >= 3).sort((a, b) => b.salesPerShift - a.salesPerShift)[0];
  // the day compared below: the one picked, else the one with the most shifts here
  const busiest = [...v.byWeekday].sort((a, b) => b.shifts - a.shifts || a.weekday - b.weekday)[0];
  const chosen = v.byWeekday.find((d) => String(d.weekday) === picked) ?? busiest;
  return (
    <Card padded={false} className="min-w-0 overflow-hidden" data-venue-weekdays>
      <div className="p-5 pb-3">
        <CardHeader icon={<CalendarDays />} title="By weekday" description={best ? `${WEEKDAY_LONG[best.weekday]} sell best here: ${formatDecimal(best.salesPerShift)} a shift over ${pluralise(best.shifts, 'shift')}.` : 'Sales a shift on each day of the week.'} />
        <BarsChart data={data} label="Sales a shift" valueFormatter={(n) => formatDecimal(n)} height={200} emptyMessage="No shifts logged here yet" />
        {v.byWeekday.length > 1 && (
          <SegmentedControl
            className="mt-3 max-w-full"
            aria-label="Weekday to compare"
            value={chosen ? String(chosen.weekday) : ''}
            onChange={setPicked}
            options={v.byWeekday.map((d) => ({ value: String(d.weekday), label: WEEKDAY_SHORT[d.weekday] ?? String(d.weekday) }))}
          />
        )}
      </div>
      {chosen?.perShift && chosen.ratios && chosen.company && (
        <>
          <p className="px-5 pb-2 text-xs text-muted">{WEEKDAY_LONG[chosen.weekday]}: {pluralise(chosen.shifts, 'shift')} here, {pluralise(chosen.company.shifts, 'shift')} company-wide.</p>
          <CompareTable here={{ perShift: chosen.perShift, ratios: chosen.ratios }} company={chosen.company} label={`${WEEKDAY_LONG[chosen.weekday]} here and company-wide`} />
        </>
      )}
    </Card>
  );
}

function PeopleCard({ v }: { v: VenueProfile }) {
  const people = v.people ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, 8);
  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="p-5 pb-3"><CardHeader className="mb-0" icon={<Users />} title="People here" description="Who has worked this venue: shown to the office and leaders only." /></div>
      {people.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">Nobody you lead has worked here yet.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead className="border-y border-border bg-surface-2 text-xs text-muted">
              <tr><th scope="col" className="px-5 py-2 text-left font-medium">Person</th><th scope="col" className="px-2 py-2 text-right font-medium">Shifts</th><th scope="col" className="px-2 py-2 text-right font-medium">Sales a shift</th><th scope="col" className="px-5 py-2 text-right font-medium max-sm:hidden">Stops per sale</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((p) => (
                <tr key={p.userId}>
                  <th scope="row" className="px-5 py-2 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2"><Avatar name={p.name} color={p.avatarColor} size="sm" /><span className="min-w-0 truncate text-fg">{p.name}</span></span>
                  </th>
                  <td className="tabular px-2 py-2 text-right text-muted">{formatNumber(p.shifts)}</td>
                  <td className="tabular px-2 py-2 text-right font-semibold text-fg">{formatDecimal(p.salesPerShift)}</td>
                  <td className="tabular px-5 py-2 text-right text-muted max-sm:hidden">{p.stopsPerSale ? formatNumber(Math.round(p.stopsPerSale)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {people.length > 8 && (
            <div className="border-t border-border px-5 py-2"><Button variant="ghost" size="sm" className="max-sm:h-10" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${formatNumber(people.length)}`}</Button></div>
          )}
        </>
      )}
    </Card>
  );
}

function EventsCard({ v }: { v: VenueProfile }) {
  const today = todayISO();
  const [all, setAll] = useState(false);
  const { upcoming, past } = useMemo(() => {
    const up = v.events.filter((e) => e.date >= today && e.status !== 'completed' && e.status !== 'cancelled').reverse();
    return { upcoming: up, past: v.events.filter((e) => !up.includes(e)) };
  }, [v.events, today]);
  const pastShown = all ? past : past.slice(0, 10);
  if (!v.events.length) return <Card><EmptyState size="sm" icon={<CalendarDays className="h-6 w-6" aria-hidden />} title="No events here yet" className="border-0" /></Card>;
  const row = (e: VenueEvent) => (
    <li key={e.id}>
      <Link to={`/events/${e.id}`} className="flex min-h-11 items-center gap-3 px-5 py-2 text-sm hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-fg">{formatDate(e.date)}</span>
          <span className="block truncate text-xs text-muted">{e.campaignCode} · {e.teamName}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted">
          {e.status && (e.status === 'scheduled' || e.status === 'cancelled' || e.status === 'live') ? <EventStatusBadge status={e.status} /> : <EventTypeBadge type={e.type} />}
          <span className="tabular">{e.people > 0 ? `${formatNumber(e.sales)} sales · ${pluralise(e.people, 'person', 'people')}` : e.booked ? `${formatNumber(e.booked)} booked` : upcoming.includes(e) ? 'Nobody booked yet' : 'Nobody logged'}</span>
        </span>
      </Link>
    </li>
  );
  return (
    <Card padded={false} className="min-w-0 overflow-hidden">
      <div className="p-5 pb-3"><CardHeader className="mb-0" icon={<CalendarDays />} title="Events here" description={`${pluralise(v.events.length, 'event')} at ${v.venue}.`} /></div>
      {upcoming.length > 0 && (
        <>
          <h4 className="eyebrow border-t border-border bg-surface-2 px-5 py-1.5 text-muted">Coming up</h4>
          <ul className="divide-y divide-border">{upcoming.map(row)}</ul>
        </>
      )}
      {past.length > 0 && (
        <>
          <h4 className="eyebrow border-t border-border bg-surface-2 px-5 py-1.5 text-muted">Earlier</h4>
          <ul className="divide-y divide-border">{pastShown.map(row)}</ul>
          {past.length > 10 && (
            <div className="border-t border-border px-5 py-2"><Button variant="ghost" size="sm" className="max-sm:h-10" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${formatNumber(past.length)}`}</Button></div>
          )}
        </>
      )}
    </Card>
  );
}
