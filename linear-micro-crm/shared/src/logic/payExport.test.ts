import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayrollRunWithUser } from '../types.ts';
import {
  PAY_EXPORT_COLUMNS,
  PAY_EXPORT_HEADERS,
  isPayExportFormat,
  payExportCell,
  payExportCsv,
  payExportFilename,
  payExportMoney,
  payExportRows,
  ukDate,
} from './payExport.ts';

function run(over: Partial<PayrollRunWithUser> = {}): PayrollRunWithUser {
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
    ...over,
  };
}

test('isPayExportFormat accepts xero and sage only', () => {
  assert.equal(isPayExportFormat('xero'), true);
  assert.equal(isPayExportFormat('sage'), true);
  assert.equal(isPayExportFormat('XERO'), false);
  assert.equal(isPayExportFormat('csv'), false);
  assert.equal(isPayExportFormat(undefined), false);
});

test('payExportRows maps a run to the eleven columns without recalculating anything', () => {
  const [row] = payExportRows([run()]);
  assert.deepEqual(row, {
    employeeName: 'Jordan Lee',
    employeeId: 'LM-0010',
    periodStart: '2026-10-12',
    periodEnd: '2026-10-18',
    gross: 924.5,
    base: 300,
    commission: 540,
    bonus: 100,
    overrides: 0,
    deductions: 15.5,
    reference: 'PAY-202642-LM-0010',
  });
  assert.equal(PAY_EXPORT_COLUMNS.length, 11);
  for (const f of ['xero', 'sage'] as const) assert.equal(PAY_EXPORT_HEADERS[f].length, PAY_EXPORT_COLUMNS.length);
});

test('payExportRows keeps the order given and rounds money to pennies', () => {
  const rows = payExportRows([run({ userName: 'B', gross: 10.005 }), run({ userName: 'A', commission: 0.1 + 0.2 })]);
  assert.deepEqual(rows.map((r) => r.employeeName), ['B', 'A']);
  assert.equal(rows[0]!.gross, 10.01);
  assert.equal(rows[1]!.commission, 0.3);
});

test('payExportCsv (xero): Xero header names, UK dates, two-decimal money, CRLF, no BOM, no totals line', () => {
  const csv = payExportCsv(payExportRows([run()]), 'xero');
  assert.equal(csv.charCodeAt(0), 'E'.charCodeAt(0), 'no byte-order mark');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, 'header, one row, then the final CRLF');
  assert.equal(lines[2], '');
  assert.equal(lines[0], 'Employee Name,Employee ID,Period Start Date,Period End Date,Gross Pay,Base Pay,Commission,Bonus,Overrides,Deductions,Reference');
  assert.equal(lines[1], 'Jordan Lee,LM-0010,12/10/2026,18/10/2026,924.50,300.00,540.00,100.00,0.00,15.50,PAY-202642-LM-0010');
});

test('payExportCsv (sage): Sage header names, same columns and values', () => {
  const csv = payExportCsv(payExportRows([run()]), 'sage');
  const [header, line] = csv.split('\r\n');
  assert.equal(header, 'Employee Name,Employee Reference,Period Start,Period End,Gross Pay,Basic Pay,Commission,Bonus,Overrides,Deductions,Payment Reference');
  assert.equal(line, 'Jordan Lee,LM-0010,12/10/2026,18/10/2026,924.50,300.00,540.00,100.00,0.00,15.50,PAY-202642-LM-0010');
});

test('payExportCsv with no rows is the header line alone', () => {
  assert.equal(payExportCsv([], 'xero'), `${PAY_EXPORT_HEADERS.xero.join(',')}\r\n`);
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
  const csv = payExportCsv(payExportRows([run({ userName: '=cmd|"/c calc"!A1', reference: '@ref' })]), 'xero');
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
  assert.equal(payExportFilename('2026-10-12', 'sage'), 'linear-hub-payroll-sage-2026-10-12.csv');
});
