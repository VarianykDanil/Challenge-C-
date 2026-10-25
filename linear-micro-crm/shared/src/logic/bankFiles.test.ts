// Release 1.4 — package P (bank payment file): every file format Linear Hub makes, cell by cell, with hand-written
// expected files. All bank details are obviously fake (00-00-00 / 0000000x): the repository is public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_FILE_FORMATS,
  BANK_FILE_FORMAT_IDS,
  bankAmount,
  bankFileFormat,
  bankFileName,
  bankPayeeName,
  bankReference,
  buildBankFile,
  type BankFileRow,
} from './bankFiles.ts';
import { PAYMENT_REFERENCE_MAX } from './payments.ts';

const row = (over: Partial<BankFileRow> = {}): BankFileRow => ({
  key: 1,
  payeeName: 'Jordan Lee',
  sortCode: '000000',
  accountNumber: '00000001',
  amountPence: 94550,
  reference: 'LINEAR 05OCT JL',
  ...over,
});

/** Every cell of a CSV body (the files never quote: no cell holds a comma, a quote or a line break). */
const cells = (body: string) => body.replace(/\r\n$/, '').split('\r\n').map((l) => l.split(','));

test('the formats: general Faster Payments file first, then the bank templates that were checked against the bank', () => {
  assert.deepEqual([...BANK_FILE_FORMAT_IDS], ['generic', 'starling', 'revolut']);
  assert.deepEqual(BANK_FILE_FORMATS.map((f) => f.id), [...BANK_FILE_FORMAT_IDS]);
  for (const f of BANK_FILE_FORMATS) {
    assert.ok(f.label && f.summary && f.uploadSteps && f.iconKey, f.id);
    assert.ok(f.referenceMax <= PAYMENT_REFERENCE_MAX, `${f.id}: within the Faster Payments reference`);
    assert.ok(f.headers.length >= 5, f.id);
    if (f.id !== 'generic') {
      assert.ok(f.sources.length >= 1, `${f.id} records where its layout comes from`);
      for (const s of f.sources) assert.match(s, /^https:\/\/(help\.starlingbank\.com|www\.starlingbank\.com|developer\.revolut\.com|help\.revolut\.com)\//, `${f.id}: the bank's own pages`);
    }
  }
  assert.equal(bankFileFormat('starling')?.bank, 'Starling Bank');
  assert.equal(bankFileFormat('revolut')?.iconKey, 'revolut');
  assert.equal(bankFileFormat('generic')?.iconKey, 'bank');
  assert.equal(bankFileFormat('mt940'), null);
  assert.equal(bankFileFormat('__proto__'), null);
});

test('amounts: whole pence to pounds with two decimals, exactly, no £ and no thousands separator', () => {
  assert.equal(bankAmount(94550), '945.50');
  assert.equal(bankAmount(115), '1.15');
  assert.equal(bankAmount(5), '0.05');
  assert.equal(bankAmount(100), '1.00');
  assert.equal(bankAmount(123456789), '1234567.89');
  assert.throws(() => bankAmount(1.5), RangeError);
  assert.throws(() => bankAmount(Number.NaN), RangeError);
});

test('references: upper case, only characters every UK bank takes, at most 18', () => {
  assert.equal(bankReference('LINEAR 05OCT JL'), 'LINEAR 05OCT JL');
  assert.equal(bankReference('linear 05oct jl'), 'LINEAR 05OCT JL');
  assert.equal(bankReference('LINEAR 05OCT Ó’B'), 'LINEAR 05OCT OB');
  assert.equal(bankReference('PAY, "WEEK" 41; £20'), 'PAY WEEK 41 20');
  assert.equal(bankReference('  LINEAR    05OCT   JL  '), 'LINEAR 05OCT JL');
  assert.equal(bankReference('LINEAR 05OCT JORDAN LEE-SMITH'), 'LINEAR 05OCT JORDA');
  assert.equal(bankReference('LINEAR 05OCT JORDAN LEE-SMITH').length, 18);
  assert.equal(bankReference('ABCDEFGHIJKLMNOPQ RST'), 'ABCDEFGHIJKLMNOPQ', 'no space left at the end after cutting');
  assert.equal(bankReference('=HYPERLINK("x")'), 'HYPERLINKX');
  assert.equal(bankReference('-2+3 CMD'), '23 CMD');
  assert.equal(bankReference('LINEAR 05/10 A.B-C'), 'LINEAR 05/10 A.B-C');
  assert.equal(bankReference('LINEAR 05OCT', 10), 'LINEAR 05O');
  for (const r of ['@SUM(A1)', '+cmd', '\tTAB', '’quote', '…']) assert.match(bankReference(`${r} X`), /^[A-Z0-9][A-Z0-9 ./-]*$/);
});

test('payee names: accents folded, only bank-safe characters, nothing a spreadsheet would run, cut to the format limit', () => {
  assert.equal(bankPayeeName('Jordan Lee', 70), 'Jordan Lee');
  assert.equal(bankPayeeName('Siobhán Ó Súilleabháin', 70), 'Siobhan O Suilleabhain');
  assert.equal(bankPayeeName("Conor O'Neill-Smith", 70), 'Conor ONeill-Smith');
  assert.equal(bankPayeeName('Łukasz Wójcik', 70), 'Lukasz Wojcik');
  assert.equal(bankPayeeName('Smith & Jones', 70), 'Smith and Jones');
  assert.equal(bankPayeeName('  Jordan    Lee ', 70), 'Jordan Lee');
  assert.equal(bankPayeeName('=HYPERLINK("http://x","y")', 70), 'HYPERLINKhttpxy');
  assert.equal(bankPayeeName('-2+3+cmd|" /C calc"!A0', 70), '23cmd C calcA0');
  assert.equal(bankPayeeName('@SUM(A1:A2)', 70), 'SUMA1A2');
  assert.equal(bankPayeeName('+44 Lee', 70), '44 Lee');
  assert.equal(bankPayeeName('＝cmd Lee', 70), 'cmd Lee', 'a full-width equals sign is folded, then dropped');
  assert.equal(bankPayeeName('.-/ Lee', 70), 'Lee', 'starts with a letter or a digit');
  assert.equal(bankPayeeName('Иван Петров', 70), 'Ivan Petrov');
  assert.equal(bankPayeeName('Alexandra Montgomery-Fitzwilliam', 18), 'Alexandra Montgome');
  assert.equal(bankPayeeName('Alexandra Montgomery', 10), 'Alexandra', 'no space left at the end after cutting');
  assert.equal(bankPayeeName('李小龍', 70), '', 'nothing a bank takes');
});

test('the general Faster Payments file: header, then payee name, sort code, account number, amount, reference', () => {
  const out = buildBankFile('generic', [row(), row({ key: 2, payeeName: 'Rita Rep', accountNumber: '00000002', amountPence: 6350, reference: 'LINEAR 05OCT RR' })]);
  assert.equal(
    out.body,
    'Payee name,Sort code,Account number,Amount,Reference\r\n'
      + 'Jordan Lee,000000,00000001,945.50,LINEAR 05OCT JL\r\n'
      + 'Rita Rep,000000,00000002,63.50,LINEAR 05OCT RR\r\n',
  );
  assert.deepEqual(out.included, [1, 2]);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.format.id, 'generic');
});

test('Starling Bank: sort code, account number, name, reference, amount, with the header row', () => {
  const out = buildBankFile('starling', [row()]);
  assert.equal(out.body, 'Payee Sort Code,Payee Account Number,Payee Name,Payment Reference,Amount\r\n000000,00000001,Jordan Lee,LINEAR 05OCT JL,945.50\r\n');
  const f = bankFileFormat('starling')!;
  assert.equal(f.nameMax, 255);
  assert.equal(f.referenceMax, 18);
  assert.equal(f.maxAmountPence, 25_000_000, 'at most £250,000 in one payment of a bulk file');
  const big = buildBankFile('starling', [row({ amountPence: 25_000_001 }), row({ key: 2, amountPence: 25_000_000 })]);
  assert.deepEqual(big.included, [2]);
  assert.match(big.rejected[0]!.reason, /Starling Bank takes at most £250,000\.00 in one payment/);
});

test('Revolut Business: the documented file payment columns, an individual in the UK paid in pounds', () => {
  const out = buildBankFile('revolut', [row()]);
  assert.equal(
    out.body,
    'Name,Recipient type,Account number,Sort code,Recipient bank country,Currency,Amount,Payment reference\r\n'
      + 'Jordan Lee,INDIVIDUAL,00000001,000000,GB,GBP,945.50,LINEAR 05OCT JL\r\n',
  );
  const f = bankFileFormat('revolut')!;
  assert.equal(f.nameMax, 80);
  assert.equal(f.maxRows, 1000);
  // an individual needs a first and a last name
  const one = buildBankFile('revolut', [row({ payeeName: 'Prince' }), row({ key: 2 })]);
  assert.deepEqual(one.included, [2]);
  assert.equal(one.rejected[0]!.key, 1);
  assert.match(one.rejected[0]!.reason, /Revolut Business needs the first and last name on the account/);
});

test('rows a bank would refuse are left out of the file with a plain reason; the rest still go', () => {
  const out = buildBankFile('generic', [
    row({ key: 1, payeeName: '李小龍' }),
    row({ key: 2, sortCode: '12345' }),
    row({ key: 3, accountNumber: '1234567X' }),
    row({ key: 4, amountPence: 0 }),
    row({ key: 5, amountPence: -100 }),
    row({ key: 6 }),
    row({ key: 7, reference: '' }),
  ]);
  assert.deepEqual(out.included, [6, 7]);
  assert.deepEqual(out.rejected.map((r) => r.key), [1, 2, 3, 4, 5]);
  assert.match(out.rejected[0]!.reason, /no letters a bank accepts/);
  assert.match(out.rejected[1]!.reason, /sort code/i);
  assert.match(out.rejected[2]!.reason, /account number/i);
  assert.match(out.rejected[3]!.reason, /Nothing to pay/);
  for (const r of out.rejected) assert.doesNotMatch(r.reason, /0000000/, 'never an account number in a reason');
  // an empty reference falls back to LINEAR
  assert.equal(cells(out.body)[2]![4], 'LINEAR');
  // nothing left: an empty file is not made
  const none = buildBankFile('generic', [row({ amountPence: 0 })]);
  assert.equal(none.body, '');
  assert.deepEqual(none.included, []);
});

test('a format with a row limit: the rows over it are left out, never split silently', () => {
  const rows = Array.from({ length: 1002 }, (_, i) => row({ key: i + 1, accountNumber: String(i).padStart(8, '0') }));
  const out = buildBankFile('revolut', rows);
  assert.equal(out.included.length, 1000);
  assert.deepEqual(out.rejected.map((r) => r.key), [1001, 1002]);
  assert.match(out.rejected[0]!.reason, /at most 1,000 payments in one file/);
});

test('the formula guard: no cell of any file starts with a character a spreadsheet runs', () => {
  const nasty = ['=HYPERLINK("http://evil","x") Lee', '+cmd|" /C calc"!A0 Lee', '-2+3+cmd Lee', '@SUM(1+1) Lee', '\t=1+1 Lee', '\r=1 Lee', '＝1+1 Lee', '−1+1 Lee'];
  for (const id of BANK_FILE_FORMAT_IDS) {
    const out = buildBankFile(id, nasty.map((n, i) => row({ key: i + 1, payeeName: n, reference: n })));
    assert.equal(out.included.length, nasty.length, id);
    for (const line of cells(out.body)) {
      for (const cell of line) assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `${id}: ${JSON.stringify(cell)}`);
    }
    assert.doesNotMatch(out.body, /["\t]/, `${id}: no quotes or tabs at all`);
    assert.ok(out.body.split('\r\n').every((l) => !l.includes('\n')), `${id}: CRLF only`);
  }
});

test('lengths: names cut to the format, references to 18, every row the same number of columns', () => {
  const long = 'Alexandra Catherine Montgomery-Fitzwilliam Llewellyn-Bowen Smythe Ashworth';
  for (const id of BANK_FILE_FORMAT_IDS) {
    const f = bankFileFormat(id)!;
    const out = buildBankFile(id, [row({ payeeName: long, reference: 'LINEAR 05OCT ALEXANDRA CATHERINE' })]);
    const [head, line] = cells(out.body);
    assert.equal(line!.length, head!.length, id);
    const name = line![f.headers.findIndex((h) => /name/i.test(h))]!;
    assert.ok(name.length <= f.nameMax, `${id} name ${name.length}`);
    assert.ok(line!.some((c) => c === 'LINEAR 05OCT ALEXA'), `${id} reference cut to 18`);
  }
});

test('file names: letters, digits and dashes, with the batch, the date and the format', () => {
  assert.equal(bankFileName('starling', 12, '2026-10-23'), 'linear-hub-payment-12-2026-10-23-starling.csv');
  assert.equal(bankFileName('generic', 3, '2026-10-23'), 'linear-hub-payment-3-2026-10-23-faster-payments.csv');
  assert.match(bankFileName('revolut', 7, '2026-10-23'), /^[a-z0-9.-]+$/);
});
