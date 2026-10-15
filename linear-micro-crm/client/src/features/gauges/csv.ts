// CSV column sets for the gauge tables (summary rows and individual entries).
import type { GaugeEntryWithMeta, GaugeGroupBy, GaugeSummaryRow } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_LABELS, POSITION_LABELS, RATIO_KEYS, RATIO_LABELS, funnelRatios, isCheckInOnTime } from '@lm/shared';
import { csvDate, csvDateTime, csvDecimal, csvLabel, csvPct, csvYesNo, type CsvColumn } from '@/lib/csv';

const GROUP_HEADER: Record<GaugeGroupBy, string> = { user: 'Person', team: 'Team', campaign: 'Campaign', day: 'Day', week: 'Week (w/c)' };
const pct1 = csvPct(1);

/**
 * Columns for `GaugeSummaryTable` rows: the group label, days (or rep-days), the six gauges, sales per
 * day, overall conversion and the five stage ratios as `12.3%` strings.
 */
export function gaugeSummaryCsvColumns(groupBy: GaugeGroupBy, perRep = groupBy !== 'user'): CsvColumn<GaugeSummaryRow>[] {
  const isTime = groupBy === 'day' || groupBy === 'week';
  return [
    isTime ? { key: 'key', header: GROUP_HEADER[groupBy], format: csvDate } : { key: 'label', header: GROUP_HEADER[groupBy] },
    { key: 'days', header: perRep ? 'Rep-days' : 'Days' },
    ...GAUGE_KEYS.map((k): CsvColumn<GaugeSummaryRow> => ({ key: k, header: GAUGE_LABELS[k] })),
    { key: 'salesPerDay', header: perRep ? 'Sales per rep-day' : 'Sales per day', format: csvDecimal(2) },
    { key: 'overallConversion', header: 'Conversion (sales ÷ stops)', format: (_, r) => pct1(r.ratios.overallConversion) },
    ...RATIO_KEYS.map((k): CsvColumn<GaugeSummaryRow> => ({ key: k, header: RATIO_LABELS[k], format: (_, r) => pct1(r.ratios[k]) })),
  ];
}

/**
 * Columns for `GaugeEntriesTable` rows. Every context column is included (date, rep, event, campaign) so
 * a file still reads on its own even when the table on screen hides one of them.
 */
export function gaugeEntryCsvColumns(): CsvColumn<GaugeEntryWithMeta>[] {
  return [
    { key: 'date', header: 'Date', format: csvDate },
    { key: 'userName', header: 'Rep' },
    { key: 'userPosition', header: 'Position', format: csvLabel(POSITION_LABELS) },
    { key: 'teamName', header: 'Team' },
    { key: 'eventName', header: 'Event' },
    { key: 'campaignName', header: 'Campaign' },
    ...GAUGE_KEYS.map((k): CsvColumn<GaugeEntryWithMeta> => ({ key: k, header: GAUGE_LABELS[k] })),
    { key: 'overallConversion', header: 'Conversion (sales ÷ stops)', format: (_, r) => pct1(funnelRatios(r).overallConversion) },
    { key: 'checkedInAt', header: 'Checked in', format: csvDateTime },
    { key: 'checkInOnTime', header: 'Check-in on time', format: (_, r) => csvYesNo(isCheckInOnTime(r.date, r.eventStartTime, r.checkedInAt)) },
  ];
}
