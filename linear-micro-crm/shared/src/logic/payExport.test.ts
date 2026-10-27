import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_EXPORT_COLUMNS,
  PAY_EXPORT_FORMAT_LABELS,
  PAY_EXPORT_HEADER,
  PAY_EXPORT_LABEL,
  isPayExportFormat,
  isPayExportPeople,
  payExportRowAddsUp,
  payExportCell,
  payExportCsv,
  payExportFilename,
  payExportMoney,
  payExportRows,
  ukDate,
  type PayExportRun,
} from './payExport.ts';

function run(over: Partial<PayExportRun> = {}): PayExportRun {
  return {
    id: 1,
    userId: 10,
    weekStart: '2026-10-12',
    weekEnd: '2026-10-18',
    daysWorked: 5,
    sales: 12,
    teamSales: 0,
    basePay: 300,
    commission: 540,
    bonus: 100,
    overrides: 0,
    deductions: 15.5,
    gross: 924.5,
    dueDate: '2026-10-23',
    paidDate: null,
    status: 'pending',
    reference: 'PAY-202642-LM-0010',
    userName: 'Jordan Lee',
    employeeId: 'LM-0010',
    position: 'field_rep',
    teamName: 'North Crew',
    onTime: null,
    role: 'rep',
    ...over,
  };
}

test('isPayExportFormat: csv, and xero / sage from older links (the same file)', () => {
  assert.equal(isPayExportFormat('csv'), true);
  assert.equal(isPayExportFormat('xero'), true);
  assert.equal(isPayExportFormat('sage'), true);
  assert.equal(isPayExportFormat('XERO'), false);
  assert.equal(isPayExportFormat(undefined), false);
  assert.equal(isPayExportPeople('self_billed'), true);
  assert.equal(isPayExportPeople('everyone'), false);
});

test('the label promises no import: a spreadsheet for the accountant or payroll software (MON-4, CLM-10)', () => {
  assert.equal(PAY_EXPORT_LABEL, 'Payroll spreadsheet (CSV) for your accountant or payroll software');
  for (const f of ['csv', 'xero', 'sage'] as const) assert.equal(PAY_EXPORT_FORMAT_LABELS[f], PAY_EXPORT_LABEL);
  assert.ok(!/xero|sage/i.test(PAY_EXPORT_HEADER.join(',')));
});

test('payExportRows maps a run to the columns without recalculating anything; the row adds up', () => {
  const [row] = payExportRows([run()]);
  assert.deepEqual(row, {
    employeeName: 'Jordan Lee',
    employeeId: 'LM-0010',
    worker: 'Self-employed (self-billed)',
    periodStart: '2026-10-12',
    periodEnd: '2026-10-18',
    base: 300,
    commission: 540,
    bonus: 100,
    overrides: 0,
    deductions: 15.5,
    adjustments: 0,
    gross: 924.5,
    vat: 0,
    totalToPay: 924.5,
    invoiceNumber: '',
    reference: 'PAY-202642-LM-0010',
  });
  assert.equal(PAY_EXPORT_COLUMNS.length, PAY_EXPORT_HEADER.length);
  assert.equal(payExportRowAddsUp(row!), true);
});

test('MON-4: a correction from an earlier week is its own column, so every row adds up to the gross', () => {
  // the review's probe: gross 246.50 with base 254.00 — a £7.50 correction taken off
  const [row] = payExportRows([run({ basePay: 254, commission: 0, bonus: 0, deductions: 0, gross: 246.5, adjustmentsTotal: -7.5 })]);
  assert.equal(row!.adjustments, -7.5);
  assert.equal(payExportRowAddsUp(row!), true);
  assert.equal(payExportRowAddsUp({ ...row!, adjustments: 0 }), false, 'without the column it would not');
});

test('MON-7: VAT from the self-billed invoice, and what is paid; office staff say so', () => {
  const [vat, office] = payExportRows([
    run({ invoice: { id: 1, number: 'LM-SB-2026-000001', status: 'accepted', version: 1, issuedAt: '', acceptedAt: null, disputedAt: null, deemedAcceptedAt: '', total: 924.5, vatAmount: 184.9 } }),
    run({ role: 'recruiter', userName: 'Rae Recruiter', basePay: 317.5, commission: 0, bonus: 0, deductions: 0, gross: 317.5 }),
  ]);
  assert.equal(vat!.vat, 184.9);
  assert.equal(vat!.totalToPay, 1109.4);
  assert.equal(vat!.invoiceNumber, 'LM-SB-2026-000001');
  assert.equal(payExportRowAddsUp(vat!), true);
  assert.equal(office!.worker, 'Office staff');
  assert.equal(office!.totalToPay, 317.5);
});

test('payExportRows keeps the order given and rounds money to pennies', () => {
  const rows = payExportRows([run({ userName: 'B', gross: 10.005 }), run({ userName: 'A', commission: 0.1 + 0.2 })]);
  assert.deepEqual(rows.map((r) => r.employeeName), ['B', 'A']);
  assert.equal(rows[0]!.gross, 10.01);
  assert.equal(rows[1]!.commission, 0.3);
});

test('payExportCsv: plain header names, UK dates, two-decimal money, CRLF, no BOM, no totals line', () => {
  const csv = payExportCsv(payExportRows([run()]));
  assert.equal(csv.charCodeAt(0), 'N'.charCodeAt(0), 'no byte-order mark');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, 'header, one row, then the final CRLF');
  assert.equal(lines[2], '');
  assert.equal(lines[0], 'Name,Employee ID,Worker,Period start,Period end,Base pay,Commission,Bonus,Overrides,Deductions,Adjustments,Gross pay,VAT,Total to pay,Invoice number,Payment reference');
  assert.equal(lines[1], 'Jordan Lee,LM-0010,Self-employed (self-billed),12/10/2026,18/10/2026,300.00,540.00,100.00,0.00,15.50,0.00,924.50,0.00,924.50,,PAY-202642-LM-0010');
});

test('payExportCsv with no rows is the header line alone', () => {
  assert.equal(payExportCsv([]), `${PAY_EXPORT_HEADER.join(',')}\r\n`);
});

test('formula injection: names starting with = + - @ TAB or CR are neutralised; plain numbers are not', () => {
  assert.equal(payExportCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(payExportCell('+44 7700 900123'), "'+44 7700 900123");
  assert.equal(payExportCell('-2+3+cmd|calc'), "'-2+3+cmd|calc");
  assert.equal(payExportCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(payExportCell('\tTabbed'), `'\tTabbed`);
  assert.equal(payExportCell('-12.50'), '-12.50', 'a negative amount stays a number');
  assert.equal(payExportCell('O\'Brien, Seán'), `"O'Brien, Seán"`, 'commas are quoted, accents kept');
  assert.equal(payExportCell(' padded '), '" padded "');
  const csv = payExportCsv(payExportRows([run({ userName: '=cmd|"/c calc"!A1', reference: '@ref' })]));
  const line = csv.split('\r\n')[1]!;
  assert.ok(line.startsWith(`"'=cmd|""/c calc""!A1",`), line);
  assert.ok(line.endsWith(",'@ref"), line);
});

test('ukDate, payExportMoney and payExportFilename', () => {
  assert.equal(ukDate('2026-01-05'), '05/01/2026');
  assert.equal(ukDate('garbage'), 'garbage');
  assert.equal(payExportMoney(1234.5), '1234.50');
  assert.equal(payExportMoney(0), '0.00');
  assert.equal(payExportMoney(Number.NaN), '0.00');
  assert.equal(payExportMoney(-3.456), '-3.46');
  assert.equal(payExportFilename('2026-10-12'), 'linear-hub-payroll-2026-10-12.csv');
  assert.equal(payExportFilename('2026-10-12', 'self_billed'), 'linear-hub-payroll-2026-10-12-self-billed.csv');
  assert.equal(payExportFilename('2026-10-12', 'office'), 'linear-hub-payroll-2026-10-12-office.csv');
});
