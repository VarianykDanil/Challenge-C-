// Release 1.3 — P4 pdf-everywhere: the pure CSV / PDF export helpers, with hand-worked fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDF_PORTRAIT_MAX_COLUMNS,
  PDF_WINANSI_EXTRAS,
  asciiFold,
  exportWhatFor,
  isNumericCell,
  isNumericColumn,
  parseExportFilename,
  pdfCellText,
  pdfDate,
  pdfDateRange,
  pdfDateShort,
  pdfDateTime,
  pdfFilenameFor,
  pdfGeneratedLine,
  pdfHeadingFor,
  pdfInfoText,
  pdfMoney,
  pdfNumber,
  pdfOrientationFor,
  pdfPageLabel,
  pdfSafeText,
  toPdfText,
} from './exportFormat.ts';

test('orientation: portrait up to six columns, landscape from seven', () => {
  assert.equal(PDF_PORTRAIT_MAX_COLUMNS, 6);
  assert.equal(pdfOrientationFor(1), 'portrait');
  assert.equal(pdfOrientationFor(6), 'portrait');
  assert.equal(pdfOrientationFor(7), 'landscape');
  assert.equal(pdfOrientationFor(19), 'landscape');
});

test('money as on screen: pounds, thousands separators, two places, the sign in front', () => {
  assert.equal(pdfMoney(1234.5), '£1,234.50');
  assert.equal(pdfMoney(63.5 * 4), '£254.00');
  assert.equal(pdfMoney(0), '£0.00');
  assert.equal(pdfMoney(-0), '£0.00');
  assert.equal(pdfMoney(-12.5), '-£12.50');
  // 0.1 + 0.2 = 0.30000000000000004 → rounded to the penny
  assert.equal(pdfMoney(0.1 + 0.2), '£0.30');
  assert.equal(pdfMoney(1_000_000), '£1,000,000.00');
  assert.equal(pdfMoney(Number.NaN), '');
  assert.equal(pdfMoney(null), '');
});

test('counts as on screen: thousands separators, decimals kept as the CSV wrote them', () => {
  assert.equal(pdfNumber(1240), '1,240');
  assert.equal(pdfNumber('1240'), '1,240');
  assert.equal(pdfNumber('2.50'), '2.50');
  assert.equal(pdfNumber('12345.5'), '12,345.5');
  assert.equal(pdfNumber('-3'), '-3');
  assert.equal(pdfNumber('-1234'), '-1,234');
  assert.equal(pdfNumber('LM-0010'), 'LM-0010');
  assert.equal(pdfNumber(Number.POSITIVE_INFINITY), '');
});

test('dates as on screen: weekday, day, month, year — and nothing for a non-date', () => {
  // 21 Oct 2026 is a Wednesday; 1 Jan 2027 a Friday; 29 Feb 2028 a Tuesday
  assert.equal(pdfDate('2026-10-21'), 'Wed 21 Oct 2026');
  assert.equal(pdfDate('2027-01-01'), 'Fri 1 Jan 2027');
  assert.equal(pdfDate('2028-02-29'), 'Tue 29 Feb 2028');
  assert.equal(pdfDate('2026-02-29'), '');
  assert.equal(pdfDate('2026-10-21T09:30:00'), 'Wed 21 Oct 2026');
  assert.equal(pdfDate('21/10/2026'), '');
  assert.equal(pdfDate(''), '');
  assert.equal(pdfDate(null), '');
  assert.equal(pdfDateShort('2026-10-05'), '5 Oct 2026');
});

test('date-times: the CSV local time as on screen; a zoned timestamp is not guessed at', () => {
  assert.equal(pdfDateTime('2026-10-21 09:30'), '21 Oct 2026, 09:30');
  assert.equal(pdfDateTime('2026-10-21T17:05:00'), '21 Oct 2026, 17:05');
  assert.equal(pdfDateTime('2026-10-21T17:05:00.123'), '21 Oct 2026, 17:05');
  assert.equal(pdfDateTime('2026-10-21T17:05:00Z'), '');
  assert.equal(pdfDateTime('2026-13-01 10:00'), '');
  assert.equal(pdfDateTime('soon'), '');
});

test('date ranges as on screen', () => {
  assert.equal(pdfDateRange('2026-10-01', '2026-10-21'), '1 – 21 Oct 2026');
  assert.equal(pdfDateRange('2026-09-28', '2026-10-04'), '28 Sep – 4 Oct 2026');
  assert.equal(pdfDateRange('2026-12-28', '2027-01-03'), '28 Dec 2026 – 3 Jan 2027');
  assert.equal(pdfDateRange('2026-10-21', '2026-10-21'), 'Wed 21 Oct 2026');
  assert.equal(pdfDateRange('x', 'y'), 'x – y');
});

test('page labels', () => {
  assert.equal(pdfPageLabel(2, 5), 'Page 2 of 5');
});

test('drawable text: Latin-1 kept, typographic marks as WinAnsi bytes, accents stripped, symbols folded', () => {
  assert.equal(toPdfText('Zoë Brontë · £5 × 2 ÷ 4'), 'Zoë Brontë · £5 × 2 ÷ 4');
  assert.equal(toPdfText('a — b – c … “q” ‘s’ •'), 'a \x97 b \x96 c \x85 \x93q\x94 \x91s\x92 \x95');
  assert.equal(toPdfText('Łukasz Dąbrowski'), 'Lukasz Dabrowski');
  assert.equal(toPdfText('Ștefan Țurcanu'), 'Stefan Turcanu');
  assert.equal(toPdfText('sales 3 → 4'), 'sales 3 -> 4');
  assert.equal(toPdfText('−£12'), '-£12');
  assert.equal(toPdfText('≥ 14'), '>= 14');
  assert.equal(toPdfText('€10'), '\x8010');
  assert.equal(toPdfText('Great day 🎉'), 'Great day ?');
  assert.equal(toPdfText('漢字'), '??');
  assert.equal(toPdfText('a\tb\r\nc\u0007d​e f'), 'a b\ncde f');
  assert.equal(toPdfText('1 000'), '1 000');
  // every output character is a single byte
  for (const s of ['Łódź → Kraków — 3½ ✓', 'Ñandú 🙂', 'naïve café']) {
    for (const ch of toPdfText(s)) assert.ok(ch.charCodeAt(0) <= 0xff, `${JSON.stringify(s)}: ${ch.charCodeAt(0)}`);
  }
  // the WinAnsi extras all sit in 0x80–0x9F
  for (const byte of Object.values(PDF_WINANSI_EXTRAS)) assert.ok(byte >= 0x80 && byte <= 0x9f);
});

test('formula guard: what a spreadsheet would run gets an apostrophe; numbers, money and phones keep their sign', () => {
  assert.equal(pdfSafeText('=HYPERLINK("http://x","y")'), `'=HYPERLINK("http://x","y")`);
  assert.equal(pdfSafeText('+cmd|\' /C calc\'!A0'), `'+cmd|' /C calc'!A0`);
  assert.equal(pdfSafeText('-2+3+cmd|x'), `'-2+3+cmd|x`);
  assert.equal(pdfSafeText('@SUM(A1:A9)'), `'@SUM(A1:A9)`);
  assert.equal(pdfSafeText('\tcmd'), `' cmd`);
  assert.equal(pdfSafeText('-12.50'), '-12.50');
  assert.equal(pdfSafeText('-£12.50'), '-£12.50');
  assert.equal(pdfSafeText('+44 7700 900123'), '+44 7700 900123');
  assert.equal(pdfSafeText('-3'), '-3');
  assert.equal(pdfSafeText('Jordan Lee'), 'Jordan Lee');
  assert.equal(pdfSafeText('a=b'), 'a=b');
  assert.equal(pdfSafeText(''), '');
});

test('cells: the CSV text written the way the screen writes it', () => {
  assert.equal(pdfCellText('1234.50', 'money'), '£1,234.50');
  assert.equal(pdfCellText('-12.5', 'money'), '-£12.50');
  assert.equal(pdfCellText('', 'money'), '');
  assert.equal(pdfCellText('n/a', 'money'), 'n/a');
  assert.equal(pdfCellText('1240', 'number'), '1,240');
  assert.equal(pdfCellText('2026-10-21', 'date'), 'Wed 21 Oct 2026');
  assert.equal(pdfCellText('2026-10-21 09:30', 'datetime'), '21 Oct 2026, 09:30');
  assert.equal(pdfCellText('12.3%', 'percent'), '12.3%');
  // text: a bare ISO date or CSV timestamp reads as one; other text is guarded and drawable
  assert.equal(pdfCellText('2026-10-21'), 'Wed 21 Oct 2026');
  assert.equal(pdfCellText('2026-10-21 09:30'), '21 Oct 2026, 09:30');
  assert.equal(pdfCellText('=1+1'), `'=1+1`);
  assert.equal(pdfCellText('Field Representative'), 'Field Representative');
  assert.equal(pdfCellText('—'), '\x97');
});

test('numeric cells and columns are right-aligned', () => {
  for (const c of ['1,240', '£945.00', '-£12.50', '12.3%', '2.5', '0']) assert.ok(isNumericCell(c), c);
  for (const c of ['LM-0010', 'Wed 21 Oct 2026', 'Yes', '', '12 Oct']) assert.ok(!isNumericCell(c), c);
  assert.equal(isNumericColumn(['1', '2', '', '—', '\x97']), true);
  assert.equal(isNumericColumn(['1', 'two']), false);
  assert.equal(isNumericColumn(['', '—']), false);
});

test('file names: section and date stamp, the PDF name, the audit name', () => {
  assert.deepEqual(parseExportFilename('linear-hub-gauges-by-team-2026-10-01_2026-10-21.csv'), { section: 'gauges-by-team', from: '2026-10-01', to: '2026-10-21' });
  assert.deepEqual(parseExportFilename('linear-hub-payslips-2026-10-22.csv'), { section: 'payslips', from: '2026-10-22', to: '2026-10-22' });
  assert.deepEqual(parseExportFilename('notes.csv'), { section: 'notes', from: null, to: null });
  assert.equal(pdfFilenameFor('linear-hub-payslips-2026-10-22.csv'), 'linear-hub-payslips-2026-10-22.pdf');
  assert.equal(pdfFilenameFor('report'), 'report.pdf');
  assert.equal(pdfFilenameFor('x.pdf'), 'x.pdf');
  assert.equal(exportWhatFor('linear-hub-gauges-by-team-deansgate-2026-10-01_2026-10-21.csv'), 'gauges-by-team-deansgate');
  assert.equal(exportWhatFor('linear-hub-leaderboard-week-sales-2026-10-22.csv'), 'leaderboard-week-sales');
  assert.equal(exportWhatFor(''), 'export');
  assert.ok(exportWhatFor(`linear-hub-${'a-'.repeat(80)}2026-10-22.csv`).length <= 80);
});

test('PDF headings from the CSV file name (every CSV button in the app today)', () => {
  const today = '2026-10-22';
  const h = (filename: string, pageHeading?: string) => pdfHeadingFor({ filename, pageHeading, today });
  assert.deepEqual(h('linear-hub-leaderboard-week-sales-2026-10-22.csv', 'Leaderboard'), { title: 'Leaderboard', filters: ['This week', 'Ranked by sales'] });
  assert.deepEqual(h('linear-hub-gauges-by-team-2026-10-01_2026-10-21.csv', 'Gauges'), { title: 'Gauges by team', filters: ['1 – 21 Oct 2026'] });
  assert.deepEqual(h('linear-hub-gauges-by-user-deansgate-2026-10-19_2026-10-25.csv', 'Gauges'), { title: 'Gauges by person', filters: ['Team: Deansgate', '19 – 25 Oct 2026'] });
  // on a person's page the heading names them, so the name is not repeated as a filter
  assert.deepEqual(h('linear-hub-gauges-jordan-lee-entries-2026-09-28_2026-10-25.csv', 'Jordan Lee'), { title: 'Gauge entries', subtitle: 'Jordan Lee', filters: ['28 Sep – 25 Oct 2026'] });
  assert.deepEqual(h('linear-hub-gauges-jordan-lee-by-campaign-2026-10-01_2026-10-21.csv', 'Gauges'), { title: 'Gauges by campaign', filters: ['Person: Jordan Lee', '1 – 21 Oct 2026'] });
  assert.deepEqual(h('linear-hub-gauges-me-entries-2026-10-01_2026-10-21.csv', 'Gauges'), { title: 'Gauge entries', filters: ['1 – 21 Oct 2026'] });
  assert.deepEqual(h('linear-hub-team-directory-on-leave-2026-10-22.csv', 'Team'), { title: 'Team directory', filters: ['Status: On leave'] });
  assert.deepEqual(h('linear-hub-team-directory-all-2026-10-22.csv', 'Team'), { title: 'Team directory', filters: ['Everyone'] });
  assert.deepEqual(h('linear-hub-campaigns-active-2026-10-22.csv', 'Campaigns'), { title: 'Campaigns', filters: ['Status: Active'] });
  assert.deepEqual(h('linear-hub-payslips-2026-07-27_2026-10-18.csv', 'Finance'), { title: 'Payslips', subtitle: 'Finance', filters: ['27 Jul – 18 Oct 2026'] });
  assert.deepEqual(h('linear-hub-runs-to-pay-2026-10-22.csv', 'Finance'), { title: 'Runs to pay', subtitle: 'Finance', filters: [] });
  assert.deepEqual(h('linear-hub-candidates-open-2026-10-22.csv', 'Recruitment'), { title: 'Candidates', subtitle: 'Recruitment', filters: ['Open candidates'] });
  assert.deepEqual(h('linear-hub-hired-2026-10-01_2026-10-31.csv', 'Recruitment'), { title: 'Hired candidates', subtitle: 'Recruitment', filters: ['1 – 31 Oct 2026'] });
  // an event's page heading is its exact name, so the slugged one is dropped; a single date that is not today stays
  assert.deepEqual(h('linear-hub-event-golden-square-launch-2026-10-17.csv', 'Golden Square launch'), { title: 'Event gauges', subtitle: 'Golden Square launch', filters: ['Sat 17 Oct 2026'] });
  assert.deepEqual(h('linear-hub-weekly-money-flow-2026-07-27_2026-10-25.csv'), { title: 'Weekly money flow', filters: ['27 Jul – 25 Oct 2026'] });
  assert.deepEqual(h('linear-hub-something-new-2026-10-22.csv'), { title: 'Something new', filters: [] });
});

test('generated line from the device clock', () => {
  // 22 Oct 2026 is a Thursday
  assert.equal(pdfGeneratedLine(new Date(2026, 9, 22, 15, 4)), 'Generated Thu 22 Oct 2026, 15:04');
  assert.equal(pdfGeneratedLine(new Date(2026, 9, 22, 9, 0), 'Danil Varianyk'), 'Generated Thu 22 Oct 2026, 09:00 by Danil Varianyk');
});

// ───────────────────────────── Review fixes (r3 P4) ─────────────────────────────

test('formula guard runs on the text the PDF prints: invisible or look-alike first characters cannot hide a formula', () => {
  // zero-width space, word joiner, soft hyphen and BOM are dropped by the fold, so the guard must see what is left
  assert.equal(pdfSafeText('​=HYPERLINK("http://evil.example","click")'), `'=HYPERLINK("http://evil.example","click")`);
  assert.equal(pdfSafeText('⁠@SUM(A1:A9)'), `'@SUM(A1:A9)`);
  assert.equal(pdfSafeText('­+cmd|x'), `'+cmd|x`);
  assert.equal(pdfSafeText('﻿=1+1'), `'=1+1`);
  // a minus sign or hyphen that folds to "-" is a formula start once printed
  assert.equal(pdfSafeText('−2+3+cmd|calc'), `'-2+3+cmd|calc`);
  assert.equal(pdfSafeText('‐1+cmd|x'), `'-1+cmd|x`);
  // full-width signs fold to their ASCII selves
  assert.equal(pdfSafeText('＝SUM(A1)'), `'=SUM(A1)`);
  // spaces in front do not hide one either
  assert.equal(pdfSafeText(' =1+1'), `' =1+1`);
  assert.equal(pdfSafeText(' =1+1'), `' =1+1`);
  assert.equal(pdfSafeText('　=1+1'), `' =1+1`);
  // numbers keep their sign whichever minus they were written with
  assert.equal(pdfSafeText('−12.50'), '-12.50');
  assert.equal(pdfSafeText('−£12.50'), '-£12.50');
  assert.equal(pdfSafeText('​-3'), '-3');
  assert.equal(pdfSafeText(' -12.50'), ' -12.50');
  // and table cells go through the same guard
  assert.equal(pdfCellText('​=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(pdfCellText('−' + '2+3+cmd|calc'), `'-2+3+cmd|calc`);
  // whatever comes in, nothing printed starts with a formula character unless it is a plain number
  for (const lead of ['​', '‌', '‍', '⁠', '﻿', '­', '−', '‐', '‑', '‒', ' ', ' ', ' ', '　', '＝', '＋', '＠', '﹣']) {
    const out = pdfSafeText(`${lead}cmd|' /C calc'!A0`);
    assert.ok(!/^[\s ]*[=+\-@]/.test(out), `${JSON.stringify(lead)} → ${JSON.stringify(out)}`);
  }
});

test('document properties (title, subject) keep the real characters, cleaned of control and invisible ones', () => {
  assert.equal(pdfInfoText('St Ann’s Square – events'), 'St Ann’s Square – events');
  assert.equal(pdfInfoText('  Learning progress ·​ Łukasz O’Brien\t\u0085 '), 'Learning progress · Łukasz O’Brien');
  // a no-break space would read as € in PDFDocEncoding
  assert.equal(pdfInfoText('a b'), 'a b');
  assert.equal(pdfInfoText(''), '');
});

test('other alphabets are spelled in Latin letters, not printed as "?"', () => {
  assert.equal(toPdfText('Иван Петров'), 'Ivan Petrov');
  assert.equal(toPdfText('Юлия Щербакова'), 'Yuliya Shcherbakova');
  assert.equal(toPdfText('Олександр Їжак'), 'Oleksandr Yizhak');
  assert.equal(toPdfText('Ђорђе Јовановић'), 'Djordje Jovanovic');
  assert.equal(toPdfText('Γιώργος Παπαδόπουλος'), 'Giorgos Papadopoulos');
  assert.equal(toPdfText('Θεοδώρα Χατζή'), 'Theodora Chatzi');
  // letters the table does not know still print as "?"
  assert.equal(toPdfText('漢字 🎉'), '?? ?');
  for (const s of ['Щука', 'Ψυχή', 'Ёжик']) for (const ch of toPdfText(s)) assert.ok(ch.charCodeAt(0) < 0x80, `${s}: ${ch}`);
});

test('ASCII spelling for file names: accents, ligatures, Ł and other alphabets', () => {
  assert.equal(asciiFold('Łukasz O’Brien–Ștefan 😀'), "Lukasz O'Brien-Stefan ?");
  assert.equal(asciiFold('Straße Ærø Œuvre þing'), 'Strasse AEro OEuvre thing');
  assert.equal(asciiFold('Иван'), 'Ivan');
  assert.equal(asciiFold('Zoë'), 'Zoe');
});

test('PDF headings take the filters on screen, which win over what the file name says', () => {
  const today = '2026-10-22';
  // Team: a team and a position picked on screen, status from the file name
  assert.deepEqual(
    pdfHeadingFor({ filename: 'linear-hub-team-directory-active-2026-10-22.csv', pageHeading: 'Team', today, screenFilters: ['Team: Deansgate North', 'Position: Field rep', 'Search: “jo”'] }),
    { title: 'Team directory', filters: ['Status: Active', 'Team: Deansgate North', 'Position: Field rep', 'Search: “jo”'] },
  );
  // Gauges: the team is in the file name as a slug; the screen's exact name replaces it, the date range stays last
  assert.deepEqual(
    pdfHeadingFor({ filename: 'linear-hub-gauges-by-user-st-ann-s-2026-10-19_2026-10-25.csv', pageHeading: 'Gauges', today, screenFilters: ['Team: St Ann’s'] }),
    { title: 'Gauges by person', filters: ['Team: St Ann’s', '19 – 25 Oct 2026'] },
  );
  // the same line twice is printed once; empty lines are dropped
  assert.deepEqual(
    pdfHeadingFor({ filename: 'linear-hub-campaigns-active-2026-10-22.csv', pageHeading: 'Campaigns', today, screenFilters: ['Status: Active', ' '] }),
    { title: 'Campaigns', filters: ['Status: Active'] },
  );
});
