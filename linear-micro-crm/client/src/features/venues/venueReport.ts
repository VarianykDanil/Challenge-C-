// Release 1.3 — P8 venue-insights: the venue report as a PDF, on P4's page-PDF primitives (lib/pdf pdfDocument: header,
// headings, paragraphs, key values, tables, footer; "Page x of y" and the brand come from P4). Loaded on demand by
// VenueReportButton (its own chunk), which shows only while lib/pdf PDF_EXPORTS_READY is true. The report holds exactly
// what the venue page shows the reader — aggregates for everyone, named people only when the page has them (the admin;
// a leader's own team) — and reports itself to the audit trail as a PDF export.
import { GAUGE_KEYS, GAUGE_LABELS, type FunnelRatios, type GaugeTotals, type VenueProfile, type VenueStabilityKey } from '@lm/shared';
import { reportAuditEvent } from '@/api/auditEvents';
import { pdfDocument } from '@/lib/pdf';
import type { CsvColumn } from '@/lib/csv';
import { formatDate, formatDecimal, formatNumber, formatPct, pluralise } from '@/lib/format';
import { STABILITY_LABELS, STABILITY_TEXT, WEEKDAY_LONG } from './venueCopy';

interface CompareRow {
  label: string;
  here: string;
  company: string;
}

const COMPARE_COLUMNS: CsvColumn<CompareRow>[] = [
  { key: 'label', header: 'Per shift' },
  { key: 'here', header: 'Here' },
  { key: 'company', header: 'Company' },
];

const RATIO_ROWS: [keyof FunnelRatios, string][] = [
  ['stopToTable', 'Stop → table'],
  ['tableToPresentation', 'Table → presentation'],
  ['presentationToClose', 'Presentation → close'],
  ['closeToTap', 'Close → tap'],
  ['tapToSale', 'Tap → sale'],
];

const pct = (n: number | null | undefined) => (typeof n === 'number' ? formatPct(n) : '—');

/** The six gauges per shift and the five steps, here against the company (or a campaign / weekday company-wide). */
function compareRows(here: { perShift: GaugeTotals; ratios: FunnelRatios }, company: { perShift: GaugeTotals; ratios: FunnelRatios }): CompareRow[] {
  return [
    ...GAUGE_KEYS.map((k) => ({ label: GAUGE_LABELS[k], here: formatDecimal(here.perShift[k]), company: formatDecimal(company.perShift[k]) })),
    ...RATIO_ROWS.map(([k, label]) => ({ label, here: pct(here.ratios[k] as number | null), company: pct(company.ratios[k] as number | null) })),
  ];
}

interface GroupRow {
  group: string;
  shifts: number;
  perShift: GaugeTotals;
  stopsPerSale: number | null;
  companySales: number | null;
  companyStopsPerSale: number | null;
}

const GROUP_COLUMNS: CsvColumn<GroupRow>[] = [
  { key: 'group', header: 'Group' },
  { key: 'shifts', header: 'Shifts', format: (_, r) => formatNumber(r.shifts) },
  ...GAUGE_KEYS.map((k): CsvColumn<GroupRow> => ({ key: k, header: GAUGE_LABELS[k], format: (_, r) => formatDecimal(r.perShift[k]) })),
  { key: 'stopsPerSale', header: 'Stops per sale', format: (_, r) => (r.stopsPerSale ? formatNumber(Math.round(r.stopsPerSale)) : '—') },
  { key: 'companySales', header: 'Company sales a shift', format: (_, r) => (r.companySales == null ? '—' : formatDecimal(r.companySales)) },
  { key: 'companyStopsPerSale', header: 'Company stops per sale', format: (_, r) => (r.companyStopsPerSale ? formatNumber(Math.round(r.companyStopsPerSale)) : '—') },
];

interface StabilityRow {
  step: string;
  rate: string;
  spread: string;
  luck: string;
  verdict: string;
}

const STABILITY_COLUMNS: CsvColumn<StabilityRow>[] = [
  { key: 'step', header: 'Step' },
  { key: 'rate', header: 'Rate here' },
  { key: 'spread', header: 'Spread visit to visit' },
  { key: 'luck', header: 'Luck alone' },
  { key: 'verdict', header: 'Verdict' },
];

const STABILITY_ORDER: VenueStabilityKey[] = ['overallConversion', 'stopToTable', 'tableToPresentation', 'presentationToClose', 'closeToTap', 'tapToSale'];

type VenueEvent = VenueProfile['events'][number];
const EVENT_COLUMNS: CsvColumn<VenueEvent>[] = [
  { key: 'date', header: 'Date', format: (_, e) => formatDate(e.date) },
  { key: 'name', header: 'Event' },
  { key: 'teamName', header: 'Team', format: (_, e) => e.teamName ?? '' },
  { key: 'campaignCode', header: 'Campaign' },
  { key: 'people', header: 'People logged', format: (_, e) => formatNumber(e.people) },
  { key: 'sales', header: 'Sales', format: (_, e) => formatNumber(e.sales) },
];

interface PersonRow {
  name: string;
  shifts: number;
  salesPerShift: number;
  stopsPerSale: number | null;
}

const PEOPLE_COLUMNS: CsvColumn<PersonRow>[] = [
  { key: 'name', header: 'Person' },
  { key: 'shifts', header: 'Shifts', format: (_, p) => formatNumber(p.shifts) },
  { key: 'salesPerShift', header: 'Sales a shift', format: (_, p) => formatDecimal(p.salesPerShift) },
  { key: 'stopsPerSale', header: 'Stops per sale', format: (_, p) => (p.stopsPerSale ? formatNumber(Math.round(p.stopsPerSale)) : '—') },
];

/** "venue-report-golden-square--warrington-2026-10-21.pdf" */
export const venueReportFilename = (v: Pick<VenueProfile, 'key'>, today: string) => `venue-report-${v.key}-${today}.pdf`;

/** Builds and downloads the venue report (throws PdfUnavailableError when the PDF chunk cannot load). */
export async function downloadVenueReport(v: VenueProfile, today: string): Promise<void> {
  const law = v.lawOfAverages;
  const filename = venueReportFilename(v, today);
  const campaigns: GroupRow[] = v.byCampaign.map((c) => ({
    group: c.name ? `${c.code} — ${c.name}` : c.code,
    shifts: c.shifts,
    perShift: c.perShift,
    stopsPerSale: c.ratios?.stopsPerSale ?? null,
    companySales: c.company?.salesPerShift ?? null,
    companyStopsPerSale: c.company?.ratios.stopsPerSale ?? null,
  }));
  const weekdays: GroupRow[] = v.byWeekday
    .filter((d) => d.perShift)
    .map((d) => ({
      group: WEEKDAY_LONG[d.weekday] ?? String(d.weekday),
      shifts: d.shifts,
      perShift: d.perShift!,
      stopsPerSale: d.ratios?.stopsPerSale ?? null,
      companySales: d.company?.salesPerShift ?? null,
      companyStopsPerSale: d.company?.ratios.stopsPerSale ?? null,
    }));
  const stability: StabilityRow[] = STABILITY_ORDER.filter((k) => law.steadiness?.[k]).map((k) => {
    const rate = k === 'overallConversion' ? v.ratios.overallConversion : v.ratios[k as keyof FunnelRatios];
    return {
      step: STABILITY_LABELS[k],
      rate: typeof rate === 'number' ? formatPct(rate, k === 'overallConversion' ? 1 : 0) : '—',
      spread: pct(law.stability[k as keyof typeof law.stability]),
      luck: pct(law.chanceCv?.[k]),
      verdict: STABILITY_TEXT[law.steadiness![k]!],
    };
  });

  const doc = await pdfDocument({ orientation: 'landscape', title: `${v.venue}, ${v.city}: venue report` });
  doc
    .header({
      title: `${v.venue}, ${v.city}`,
      subtitle: 'Venue report',
      meta: [
        ['Visits', formatNumber(v.eventCount)],
        ['Shifts', formatNumber(v.shifts)],
        ['Last visit', v.lastVisit ? formatDate(v.lastVisit) : '—'],
        ['Next visit', v.nextVisit ? formatDate(v.nextVisit) : '—'],
      ],
    })
    .heading('The law of averages')
    .paragraph(law.sentence)
    .keyValues([
      ['Sales a shift', `${formatDecimal(v.salesPerShift)} (company ${formatDecimal(v.company.salesPerShift ?? v.company.perShift.sales)})`],
      ['Stops per sale', `${law.stopsPerSale ? formatNumber(Math.round(law.stopsPerSale)) : '—'} (company ${v.company.ratios.stopsPerSale ? formatNumber(Math.round(v.company.ratios.stopsPerSale)) : '—'})`],
      ...(law.bands ?? []).map((b): [string, string] => [
        b.band === 'fewest' ? 'Fewest stops' : b.band === 'most' ? 'Most stops' : 'Middle',
        `${formatNumber(b.minStops)}–${formatNumber(b.maxStops)} stops: ${formatDecimal(b.salesPerShift)} sales a shift (${pluralise(b.shifts, 'shift')})`,
      ]),
    ])
    .heading(`A shift here and company-wide (${pluralise(v.shifts, 'shift')} here, ${pluralise(v.company.shifts ?? 0, 'shift')} company-wide)`)
    .table(COMPARE_COLUMNS, compareRows(v, v.company));
  if (campaigns.length) doc.heading('By campaign: per shift here, against the same campaign company-wide').table(GROUP_COLUMNS, campaigns);
  if (weekdays.length) doc.heading('By weekday: per shift here, against the same weekday company-wide').table(GROUP_COLUMNS, weekdays);
  if (stability.length) doc.heading('How steady each step is, visit to visit').table(STABILITY_COLUMNS, stability).paragraph('Steady: the visits differ by no more than luck alone would explain.', { muted: true });
  if (v.people?.length) doc.heading('People here').table(PEOPLE_COLUMNS, v.people);
  doc.heading(`Events here (${pluralise(v.events.length, 'event')})`).table(EVENT_COLUMNS, v.events).footer(`Linear Hub · ${v.venue}, ${v.city} · venue report · figures are averages of finished shifts`).save(filename);
  reportAuditEvent({ kind: 'export', format: 'pdf', what: 'venue-report', rows: v.events.length, filename });
}
