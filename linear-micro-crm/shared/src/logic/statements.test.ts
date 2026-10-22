import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateConfirmedToWeeks,
  detectStatementColumns,
  findStatementDates,
  findStatementTable,
  formatStatementPeriod,
  isCancelledStatus,
  mappingByHeader,
  matchPersonByName,
  normalisePersonName,
  parsePeriodText,
  parseStatementCount,
  parseStatementDate,
  parseStatementMoney,
  parseStatementPeriod,
  personNameKeys,
  resolveStatementColumn,
  statementHeaderField,
  statementLines,
  statementRowsFromTable,
  statementTotalConfirmed,
  statementWeekStarts,
  type PdfTextItem,
} from './statements.ts';

/** A positioned item as pdfjs gives it (10 pt text, width ≈ 5 pt per character). */
const item = (str: string, x: number, y: number, page = 1, height = 10): PdfTextItem => ({ str, x, y, width: str.length * 5, height, page });

test('statementLines: same baseline → one line, wide gaps → cells, top to bottom, page by page', () => {
  const lines = statementLines([
    item('Jordan', 140, 700),
    item('Lee', 172, 700), // 140 + 30 = 170 → a 2 pt gap: the same cell, with a space
    item('BCN-1042', 40, 700.4), // the same line (0.4 pt off)
    item('18', 300, 700),
    item(' ', 200, 700), // whitespace items are ignored
    item('Fundraiser ID', 40, 720),
    item('Page 2', 40, 780, 2),
  ]);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0]!.cells.map((c) => c.text), ['Fundraiser ID']);
  assert.deepEqual(lines[1]!.cells.map((c) => c.text), ['BCN-1042', 'Jordan Lee', '18']);
  assert.equal(lines[1]!.text, 'BCN-1042  Jordan Lee  18');
  assert.equal(lines[2]!.page, 2);
});

test('statementLines: per-glyph items join without spaces', () => {
  const glyphs = 'Total'.split('').map((ch, i) => ({ str: ch, x: 40 + i * 5, y: 500, width: 5, height: 10, page: 1 }));
  assert.deepEqual(statementLines(glyphs)[0]!.cells.map((c) => c.text), ['Total']);
});

test('header words → fields', () => {
  const cases: [string, string | null][] = [
    ['Fundraiser ID', 'ref'], ['Fundraiser name', 'name'], ['Fundraiser', 'name'], ['Name', 'name'], ['Agent no.', 'ref'],
    ['Sign-ups', 'gross'], ['Signups', 'gross'], ['Subs', 'gross'], ['Successful sign-ups', 'confirmed'], ['Paid subs', 'confirmed'],
    ['Net', 'confirmed'], ['Cancelled', 'cancelled'], ['Cancellations', 'cancelled'], ['Lapsed', 'cancelled'],
    ['Amount', 'amount'], ['Commission (£)', 'amount'], ['Amount paid', 'amount'], ['Sign-up date', 'date'], ['Date', 'date'],
    ['Status', 'status'], ['Period', 'period'], ['Week ending', 'period'], ['Donor ID', null], ['Supporter name', null],
    ['Campaign', null], ['Cancelled (£)', null], ['Postcode', null], ['', null],
  ];
  for (const [text, field] of cases) assert.equal(statementHeaderField(text), field, text);
});

test('detectStatementColumns: the first column per field; a "Paid" column of money is the amount', () => {
  assert.deepEqual(detectStatementColumns(['Fundraiser ID', 'Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount']), {
    ref: 0, name: 1, gross: 2, cancelled: 3, confirmed: 4, amount: 5,
  });
  const headers = ['Name', 'Sign-ups', 'Paid'];
  assert.deepEqual(detectStatementColumns(headers), { name: 0, gross: 1, confirmed: 2 });
  assert.deepEqual(detectStatementColumns(headers, [['Jordan Lee', '18', '£160.00'], ['Sam Cole', '12', '£120.00']]), { name: 0, gross: 1, amount: 2 });
  assert.deepEqual(detectStatementColumns([]), {});
});

/** A small statement page: title, period, header, three rows, a total and a footer. */
function bcnPage(): PdfTextItem[] {
  const cols = [40, 130, 290, 360, 430, 500];
  const row = (cells: string[], y: number, page = 1) => cells.map((c, i) => item(c, cols[i]!, y, page)).filter((i) => i.str);
  return [
    item('Breast Cancer Now', 40, 800, 1, 16),
    item('Face-to-face commission statement', 40, 780),
    item('Period: 05/10/2026 to 11/10/2026', 40, 765),
    ...row(['Fundraiser ID', 'Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount'], 730),
    ...row(['BCN-1042', 'Jordan Lee', '18', '2', '16', '£160.00'], 712),
    ...row(['BCN-1043', "Sam O'Brien", '12', '0', '12', '£120.00'], 698),
    item('Registered charity 1160558', 40, 684), // a note line inside the table area: one cell, skipped
    ...row(['BCN-1050', 'Lee, Chloe', '7', '', '7', '£70.00'], 670),
    ...row(['Total', '', '37', '2', '35', '£350.00'], 650),
    item('Page 1 of 1', 40, 40),
  ];
}

test('findStatementTable: the header, the rows in its columns, the total and the preamble', () => {
  const t = findStatementTable(statementLines(bcnPage()))!;
  assert.ok(t);
  assert.deepEqual(t.headers, ['Fundraiser ID', 'Fundraiser name', 'Sign-ups', 'Cancelled', 'Paid subs', 'Amount']);
  assert.deepEqual(t.rows, [
    ['BCN-1042', 'Jordan Lee', '18', '2', '16', '£160.00'],
    ['BCN-1043', "Sam O'Brien", '12', '0', '12', '£120.00'],
    ['BCN-1050', 'Lee, Chloe', '7', '', '7', '£70.00'],
  ]);
  assert.deepEqual(t.totals, ['Total', '', '37', '2', '35', '£350.00']);
  assert.deepEqual(t.preamble, ['Breast Cancer Now', 'Face-to-face commission statement', 'Period: 05/10/2026 to 11/10/2026']);
  assert.equal(findStatementTable(statementLines([item('Dear Matt, thanks for a great month', 40, 700)])), null);
});

test('findStatementTable: a header split over two lines is joined; a repeated header on page 2 re-anchors the columns', () => {
  const items = [
    item('Fundraiser', 40, 730), item('Successful', 200, 730), item('Cancelled', 300, 730),
    item('name', 40, 719), item('sign-ups', 200, 719),
    item('Ruby Fletcher', 40, 700), item('9', 210, 700), item('1', 310, 700),
    // page 2: the same header, 20 pt further right
    item('Fundraiser', 60, 780, 2), item('Successful', 220, 780, 2), item('Cancelled', 320, 780, 2),
    item('name', 60, 769, 2), item('sign-ups', 220, 769, 2),
    item('Noah Simmons', 60, 750, 2), item('4', 230, 750, 2), item('0', 330, 750, 2),
  ];
  const t = findStatementTable(statementLines(items))!;
  assert.deepEqual(t.headers, ['Fundraiser name', 'Successful sign-ups', 'Cancelled']);
  assert.deepEqual(t.rows, [['Ruby Fletcher', '9', '1'], ['Noah Simmons', '4', '0']]);
  assert.equal(t.totals, null);
});

test('counts, money, statuses and dates as statements write them', () => {
  assert.equal(parseStatementCount('18'), 18);
  assert.equal(parseStatementCount('1,204'), 1204);
  assert.equal(parseStatementCount('(2)'), 2);
  assert.equal(parseStatementCount('16.0'), 16);
  assert.equal(parseStatementCount(''), null);
  assert.equal(parseStatementCount('–'), null);
  assert.equal(parseStatementCount('n/a'), null);
  assert.equal(parseStatementMoney('£1,234.50'), 1234.5);
  assert.equal(parseStatementMoney('(20.00)'), -20);
  assert.equal(parseStatementMoney('-£20.00'), -20);
  assert.equal(parseStatementMoney('£-20'), -20);
  assert.equal(parseStatementMoney('160'), 160);
  assert.equal(parseStatementMoney('sixteen'), null);
  assert.equal(isCancelledStatus('Cancelled'), true);
  assert.equal(isCancelledStatus('DD cancelled by donor'), true);
  assert.equal(isCancelledStatus('Lapsed'), true);
  assert.equal(isCancelledStatus('Active'), false);
  assert.equal(isCancelledStatus(''), false);
  assert.equal(parseStatementDate('05/10/2026'), '2026-10-05');
  assert.equal(parseStatementDate('5.10.26'), '2026-10-05');
  assert.equal(parseStatementDate('2026-10-05'), '2026-10-05');
  assert.equal(parseStatementDate('Mon 5 October 2026'), '2026-10-05');
  assert.equal(parseStatementDate('5th Oct 2026'), '2026-10-05');
  assert.equal(parseStatementDate('October 5, 2026'), '2026-10-05');
  assert.equal(parseStatementDate('31/02/2026'), null, 'no 31 February');
  assert.equal(parseStatementDate('soon'), null);
  assert.deepEqual(findStatementDates('From 28/09/2026 to 04/10/2026').map((d) => d.iso), ['2026-09-28', '2026-10-04']);
});

test('the period, however the statement writes it', () => {
  assert.deepEqual(parsePeriodText('Period: 05/10/2026 to 11/10/2026'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(parsePeriodText('Statement period 05.10.2026 - 11.10.2026'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(parsePeriodText('Week ending 11 October 2026'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(parsePeriodText('w/c 5 Oct 2026'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(parsePeriodText('1–31 October 2026'), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(parsePeriodText('28 Sep – 4 Oct 2026'), { start: '2026-09-28', end: '2026-10-04' });
  assert.deepEqual(parsePeriodText('28 Dec – 3 Jan 2027'), { start: '2026-12-28', end: '2027-01-03' });
  assert.deepEqual(parsePeriodText('Commission statement for September 2026'), { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(parsePeriodText('Printed 12/10/2026'), null, 'one date that is not a week');
  assert.equal(parsePeriodText('01/01/2026 to 31/12/2026'), null, 'a year is not a statement period');
  assert.equal(parsePeriodText('11/10/2026 to 05/10/2026'), null, 'backwards');
  assert.deepEqual(parseStatementPeriod(['Breast Cancer Now', 'Printed 12/10/2026', 'Period: 05/10/2026 to 11/10/2026']), { start: '2026-10-05', end: '2026-10-11' });
  assert.equal(parseStatementPeriod(['Breast Cancer Now', 'Thank you']), null);
});

test('statementRowsFromTable (totals): confirmed = the paid count, else sign-ups − cancelled', () => {
  const t = findStatementTable(statementLines(bcnPage()))!;
  const mapping = detectStatementColumns(t.headers, t.rows);
  const read = statementRowsFromTable(t, mapping);
  assert.equal(read.layout, 'totals');
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.drafts.map((d) => [d.fundraiserRef, d.name, d.confirmed, d.cancelled, d.amount]), [
    ['BCN-1042', 'Jordan Lee', 16, 2, 160],
    ['BCN-1043', "Sam O'Brien", 12, 0, 120],
    ['BCN-1050', 'Lee, Chloe', 7, 0, 70], // a blank "Cancelled" with 7 sign-ups and 7 paid → 0
  ]);
  assert.equal(read.drafts[0]!.raw['Paid subs'], '16');
  assert.equal(statementTotalConfirmed(t.headers, t.totals, mapping), 35);
  // no paid column: 18 sign-ups − 2 cancelled = 16
  const noPaid = statementRowsFromTable({ headers: ['Name', 'Sign-ups', 'Cancelled'], rows: [['Jordan Lee', '18', '2'], ['Note: figures to Sunday', '', '']] }, { name: 0, gross: 1, cancelled: 2 });
  assert.deepEqual(noPaid.drafts.map((d) => [d.name, d.confirmed, d.cancelled]), [['Jordan Lee', 16, 2]]);
  assert.equal(statementTotalConfirmed(['Name', 'Sign-ups', 'Cancelled'], ['Total', '30', '4'], { name: 0, gross: 1, cancelled: 2 }), 26);
});

test('statementRowsFromTable (per-sub): one row per sign-up, cancelled by its status; row periods read too', () => {
  const read = statementRowsFromTable(
    {
      headers: ['Sign-up date', 'Donor ref', 'Fundraiser', 'Status'],
      rows: [
        ['01/09/2026', 'D-1', 'Ruby Fletcher', 'Active'],
        ['02/09/2026', 'D-2', 'Ruby Fletcher', 'Cancelled'],
        ['bad date', 'D-3', 'Ruby Fletcher', ''],
      ],
    },
    detectStatementColumns(['Sign-up date', 'Donor ref', 'Fundraiser', 'Status']),
  );
  assert.equal(read.layout, 'per-sub');
  assert.deepEqual(read.drafts.map((d) => [d.saleDate, d.name, d.confirmed, d.cancelled, d.fundraiserRef]), [
    ['2026-09-01', 'Ruby Fletcher', 1, 0, null],
    ['2026-09-02', 'Ruby Fletcher', 0, 1, null],
  ]);
  const periods = statementRowsFromTable({ headers: ['Name', 'Week', 'Paid'], rows: [['Ella Brooks', 'w/c 05/10/2026', '6']] }, { name: 0, period: 1, confirmed: 2 });
  assert.deepEqual([periods.drafts[0]!.periodStart, periods.drafts[0]!.periodEnd, periods.drafts[0]!.confirmed], ['2026-10-05', '2026-10-11', 6]);
});

test('statementRowsFromTable: problems in plain words when a column is missing', () => {
  assert.deepEqual(statementRowsFromTable({ headers: ['Postcode', 'Total'], rows: [['M1 1AA', '3']] }, {}).problems, [
    'There is no column with the fundraiser’s name or ID.',
    'There is no column with the number of subs, or with each sign-up’s date or status.',
  ]);
  const saved = statementRowsFromTable({ headers: ['Name', 'Paid'], rows: [['Jordan Lee', '4']] }, { name: 'Name', confirmed: 'Paid', ref: 'Fundraiser no.' });
  assert.deepEqual(saved.problems, ['The saved columns use “Fundraiser no.” for fundraiser id, but this statement has no such column.']);
  assert.equal(saved.drafts.length, 1, 'the rows are still read');
});

test('a mapping by header text survives a new column; resolveStatementColumn', () => {
  const v1 = ['ID', 'Name', 'Paid subs'];
  const byHeader = mappingByHeader(v1, { ref: 0, name: 1, confirmed: 2 });
  assert.deepEqual(byHeader, { ref: 'ID', name: 'Name', confirmed: 'Paid subs' });
  const v2 = ['ID', 'Team', 'Name', 'Paid  SUBS'];
  assert.equal(resolveStatementColumn(v2, byHeader.confirmed), 3);
  assert.equal(resolveStatementColumn(v2, 9), null);
  assert.equal(resolveStatementColumn(v2, undefined), null);
});

test('allocateConfirmedToWeeks: cancellations off the latest week first; extra subs on the latest (hand-computed)', () => {
  const w = (weekStart: string, logged: number) => ({ weekStart, logged });
  // 18 logged in one week, 16 confirmed → 2 cancelled in that week
  assert.deepEqual(allocateConfirmedToWeeks([w('2026-10-05', 18)], 16), [{ weekStart: '2026-10-05', logged: 18, confirmed: 16 }]);
  // 5 + 6 + 7 = 18 logged, 14 confirmed → 4 cancelled, all from the last week: 7 → 3
  assert.deepEqual(allocateConfirmedToWeeks([w('2026-09-14', 6), w('2026-09-07', 5), w('2026-09-21', 7)], 14).map((x) => x.confirmed), [5, 6, 3]);
  // 5 + 6 + 2 = 13 logged, 9 confirmed → 4 cancelled: the last week 2 → 0, then 6 → 4
  assert.deepEqual(allocateConfirmedToWeeks([w('2026-09-07', 5), w('2026-09-14', 6), w('2026-09-21', 2)], 9).map((x) => x.confirmed), [5, 4, 0]);
  // more confirmed than logged: 3 + 4 = 7 logged, 9 confirmed → +2 on the last week
  assert.deepEqual(allocateConfirmedToWeeks([w('2026-09-07', 3), w('2026-09-14', 4)], 9).map((x) => x.confirmed), [3, 6]);
  // confirmed 0 → every week 0; nothing logged and nothing confirmed → zeros
  assert.deepEqual(allocateConfirmedToWeeks([w('2026-09-07', 3), w('2026-09-14', 4)], 0).map((x) => x.confirmed), [0, 0]);
  assert.deepEqual(allocateConfirmedToWeeks([], 5), []);
});

test('statementWeekStarts: every pay week a period touches', () => {
  assert.deepEqual(statementWeekStarts('2026-10-05', '2026-10-11'), ['2026-10-05']);
  assert.deepEqual(statementWeekStarts('2026-09-01', '2026-09-30'), ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
});

test('names: exact full name only, "Last, First" too, never when two people share it', () => {
  const people = [
    { id: 1, firstName: 'Jordan', lastName: 'Lee' },
    { id: 2, firstName: 'Sam', lastName: "O'Brien" },
    { id: 3, firstName: 'Chloe', lastName: 'Lee' },
    { id: 4, firstName: 'Alex', lastName: 'Ward' },
    { id: 5, firstName: 'Alex', lastName: 'Ward' },
  ];
  assert.equal(normalisePersonName("O'Brien,  Sam"), 'obrien sam');
  assert.deepEqual(personNameKeys('Lee, Chloe'), ['lee chloe', 'chloe lee']);
  assert.equal(matchPersonByName('Jordan Lee', people), 1);
  assert.equal(matchPersonByName('JORDAN  LEE', people), 1);
  assert.equal(matchPersonByName('Sam OBrien', people), 2);
  assert.equal(matchPersonByName('Lee, Chloe', people), 3);
  assert.equal(matchPersonByName('J. Lee', people), null, 'initials are not a full name');
  assert.equal(matchPersonByName('Jordan', people), null);
  assert.equal(matchPersonByName('Alex Ward', people), null, 'two people with that name');
  assert.equal(matchPersonByName(null, people), null);
});

test('formatStatementPeriod', () => {
  assert.equal(formatStatementPeriod('2026-10-05', '2026-10-11'), '5–11 Oct 2026');
  assert.equal(formatStatementPeriod('2026-09-28', '2026-10-04'), '28 Sep – 4 Oct 2026');
  assert.equal(formatStatementPeriod('2026-09-01', '2026-09-30'), 'September 2026');
  assert.equal(formatStatementPeriod('2026-12-28', '2027-01-03'), '28 Dec 2026 – 3 Jan 2027');
  assert.equal(formatStatementPeriod('2026-10-05', '2026-10-05'), '5 Oct 2026');
  assert.equal(formatStatementPeriod(null, '2026-10-05'), 'Period not stated');
});
