// P2 invoices: the pure rules, with hand-computed fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WeekPayBreakdown } from '../types/pay.ts';
import {
  canDisputeInvoice,
  deemedAcceptanceMoment,
  deemedAcceptedAt,
  effectiveInvoiceStatus,
  formatInvoiceNumber,
  formatUtr,
  formatVatNumber,
  invoiceDeadline,
  invoiceDeadlineText,
  invoiceLinesFor,
  invoiceLinesFromBreakdown,
  invoiceLinesFromRun,
  invoiceLineNote,
  invoiceLinesTotal,
  invoiceMoney,
  isInvoicePayable,
  isInvoicedRole,
  normalisePostcode,
  normaliseUtr,
  normaliseVatNumber,
  sameInvoicePayment,
  selfBillingAgreementText,
  selfBillingNote,
} from './invoices.ts';

test('number and the deemed-accepted moment (STABLE)', () => {
  assert.equal(formatInvoiceNumber(2026, 123), 'LM-SB-2026-000123');
  assert.equal(formatInvoiceNumber(2027, 1), 'LM-SB-2027-000001');
  // payday Fri 23 Oct 2026 → 12:00 Thu 22 Oct
  assert.equal(deemedAcceptedAt('2026-10-23'), '2026-10-22T12:00:00');
  // across a month end: payday Fri 1 Jan 2027 → Thu 31 Dec 2026
  assert.equal(deemedAcceptedAt('2027-01-01'), '2026-12-31T12:00:00');
  assert.equal(deemedAcceptedAt('not a date'), null);
});

test('who is invoiced: the field people only', () => {
  assert.equal(isInvoicedRole('rep'), true);
  assert.equal(isInvoicedRole('leader'), true);
  assert.equal(isInvoicedRole('recruiter'), false);
  assert.equal(isInvoicedRole('admin'), false);
  assert.equal(isInvoicedRole('client'), false);
  assert.equal(isInvoicedRole(undefined), false);
});

test('deadline: 12:00 the day before payday, or 24 hours after issue when issued later — whichever is later', () => {
  // issued Mon 19 Oct 07:00 for payday Fri 23 Oct → Thu 22 Oct 12:00 (the usual case)
  assert.equal(invoiceDeadline('2026-10-23', '2026-10-19T07:00:00'), '2026-10-22T12:00:00');
  // reissued Wed 21 Oct 11:00 → Thu 22 Oct 12:00 still (more than a day's notice)
  assert.equal(invoiceDeadline('2026-10-23', '2026-10-21T11:00:00'), '2026-10-22T12:00:00');
  // exactly 24 hours before the usual deadline: the same moment
  assert.equal(invoiceDeadline('2026-10-23', '2026-10-21T12:00:00'), '2026-10-22T12:00:00');
  // reissued Wed 21 Oct 16:30 → 24 hours: Thu 22 Oct 16:30
  assert.equal(invoiceDeadline('2026-10-23', '2026-10-21T16:30:00'), '2026-10-22T16:30:00');
  // reissued Thu 22 Oct 13:05:42 → Fri 23 Oct 13:06 (rounded up to the whole minute: never under 24 hours)
  assert.equal(invoiceDeadline('2026-10-23', '2026-10-22T13:05:42'), '2026-10-23T13:06:00');
  // reissued on payday itself (a statement applied on Friday 08:30) → Sat 24 Oct 08:30: NOT accepted at once
  const payday = invoiceDeadline('2026-10-23', '2026-10-23T08:30:00');
  assert.equal(payday, '2026-10-24T08:30:00');
  assert.equal(effectiveInvoiceStatus('issued', payday, '2026-10-23T08:30:00'), 'issued');
  assert.equal(canDisputeInvoice('issued', payday, '2026-10-23T17:00:00', false), true, 'the person can still say something is wrong on payday');
  assert.equal(effectiveInvoiceStatus('issued', payday, '2026-10-24T08:30:00'), 'deemed_accepted');
  // an old unpaid run invoiced late (payday Fri 4 Sep long gone) → 24 hours from issue, not its old payday
  assert.equal(invoiceDeadline('2026-09-04', '2026-10-21T15:00:00'), '2026-10-22T15:00:00');
  // across a month and a year end
  assert.equal(invoiceDeadline('2027-01-01', '2026-12-31T18:45:00'), '2027-01-01T18:45:00');
  // the deadline is never before the usual one, nor less than 24 hours after issue (any issue time over two weeks)
  for (let h = 0; h < 24 * 14; h += 7) {
    const issued = new Date(Date.UTC(2026, 9, 12, 0, 13) + h * 3_600_000).toISOString().slice(0, 19);
    const d = invoiceDeadline('2026-10-23', issued);
    assert.ok(d >= '2026-10-22T12:00:00', `${issued} → ${d}`);
    assert.ok(Date.parse(`${d}Z`) - Date.parse(`${issued}Z`) >= 24 * 3_600_000, `${issued} → ${d}`);
  }
  // never after the usual deadline when issued in good time
  assert.ok(invoiceDeadline('2026-10-23', '2026-10-12T07:00:00') === deemedAcceptedAt('2026-10-23'));
  // a bad issue time falls back to the usual deadline
  assert.equal(invoiceDeadline('2026-10-23', 'garbage'), '2026-10-22T12:00:00');
});

test('deadline in words: "12:00 Thu 22 Oct"; 00:00 reads as midnight on the day before', () => {
  assert.equal(invoiceDeadlineText('2026-10-22T12:00:00'), '12:00 Thu 22 Oct');
  assert.equal(invoiceDeadlineText('2026-10-23T13:06:00'), '13:06 Fri 23 Oct');
  assert.equal(invoiceDeadlineText('2026-10-23T00:00:00'), 'midnight on Thu 22 Oct');
  assert.equal(invoiceDeadlineText('2027-01-01T00:00:00'), 'midnight on Thu 31 Dec');
  assert.equal(invoiceDeadlineText(null), '—');
  assert.equal(invoiceDeadlineText('nope'), '—');
});

test('a deemed acceptance is never dated before the version existed', () => {
  assert.equal(deemedAcceptanceMoment('2026-10-22T12:00:00', '2026-10-19T07:00:00'), '2026-10-22T12:00:00');
  // a row stored by an earlier build: deadline (old payday) before the issue time → the issue time
  assert.equal(deemedAcceptanceMoment('2026-05-08T00:00:00', '2026-10-21T15:00:12'), '2026-10-21T15:00:12');
});

test('the same payment: total and paid lines; "Not paid" lines and wording do not count', () => {
  const v1 = baseWeek();
  const lines1 = invoiceLinesFromBreakdown(v1);
  const total = invoiceLinesTotal(lines1);
  // 2 more subs cancelled on a week paid as the base: only the not-paid commission line changes
  const lines2 = lines1.map((l) => (l.kind === 'commission' ? { ...l, description: 'BCN: 14 subs × £10.00 (18 logged, 4 cancelled)', quantity: 14, amount: 140 } : l));
  assert.equal(sameInvoicePayment({ total, lines: lines1 }, { total, lines: lines2 }), true);
  // a paid line's wording only (e.g. "confirmed by BCN"): the same payment
  const lines3 = lines1.map((l) => (l.kind === 'bonus' ? { ...l, description: 'Bonus: best week of the month' } : l));
  assert.equal(sameInvoicePayment({ total, lines: lines1 }, { total, lines: lines3 }), true);
  // the total moves: a new version
  const lines4 = lines1.map((l) => (l.kind === 'bonus' ? { ...l, amount: 50 } : l));
  assert.equal(sameInvoicePayment({ total, lines: lines1 }, { total: invoiceLinesTotal(lines4), lines: lines4 }), false);
  // the same total paid differently (base → commission at the same £254): a new version
  const lines5 = lines1.map((l) => (l.kind === 'base' ? { ...l, paid: false } : l.kind === 'commission' ? { ...l, amount: 254, quantity: 25, unitPrice: 10.16, paid: true } : l));
  assert.equal(invoiceLinesTotal(lines5), total);
  assert.equal(sameInvoicePayment({ total, lines: lines1 }, { total, lines: lines5 }), false);
});

test('effective status: an issued invoice past its deadline counts as deemed accepted', () => {
  const deadline = '2026-10-22T12:00:00';
  assert.equal(effectiveInvoiceStatus('issued', deadline, '2026-10-22T11:59:59'), 'issued');
  assert.equal(effectiveInvoiceStatus('issued', deadline, '2026-10-22T12:00:00'), 'deemed_accepted');
  // a disputed invoice is held: the deadline never accepts it
  assert.equal(effectiveInvoiceStatus('disputed', deadline, '2026-10-23T09:00:00'), 'disputed');
  assert.equal(effectiveInvoiceStatus('accepted', deadline, '2026-10-23T09:00:00'), 'accepted');
  assert.equal(isInvoicePayable('accepted'), true);
  assert.equal(isInvoicePayable('deemed_accepted'), true);
  assert.equal(isInvoicePayable('resolved'), true);
  assert.equal(isInvoicePayable('issued'), false);
  assert.equal(isInvoicePayable('disputed'), false);
  assert.equal(isInvoicePayable(undefined), false);
});

test('disputes: only before the deadline, while unpaid, from issued or accepted', () => {
  const d = '2026-10-22T12:00:00';
  assert.equal(canDisputeInvoice('issued', d, '2026-10-21T15:00:00', false), true);
  assert.equal(canDisputeInvoice('accepted', d, '2026-10-21T15:00:00', false), true);
  assert.equal(canDisputeInvoice('issued', d, '2026-10-22T12:00:00', false), false, 'deadline passed');
  assert.equal(canDisputeInvoice('issued', d, '2026-10-21T15:00:00', true), false, 'paid');
  assert.equal(canDisputeInvoice('disputed', d, '2026-10-21T15:00:00', false), false, 'already disputed');
  assert.equal(canDisputeInvoice('resolved', d, '2026-10-21T15:00:00', false), false, 'the office already answered');
});

test('lines from a 1.2 run: 4 days × £60 + 10 sales × £45 + £75 bonus − £20 deductions = £745.00', () => {
  const lines = invoiceLinesFromRun({ daysWorked: 4, sales: 10, teamSales: 0, basePay: 240, commission: 450, bonus: 75, overrides: 0, deductions: 20, gross: 745 });
  assert.deepEqual(lines, [
    { kind: 'base', description: 'Base: 4 days × £60.00', quantity: 4, unitPrice: 60, amount: 240, paid: true },
    { kind: 'commission', description: 'Commission: 10 sales × £45.00', quantity: 10, unitPrice: 45, amount: 450, paid: true },
    { kind: 'bonus', description: 'Bonus', amount: 75, paid: true },
    { kind: 'deduction', description: 'Deductions', amount: -20, paid: true },
  ]);
  assert.equal(invoiceLinesTotal(lines), 745);
});

test('lines from a run: overrides, earlier-week corrections, an inexact rate and a balancing line', () => {
  // leader: 3 days × £70 = £210; 7 sales for £301 (= £43.00 each); 20 team sales × £8 = £160 overrides;
  // −£20 correction from an earlier week; gross written as £652.00 → 210 + 301 + 160 − 20 = 651, so £1.00 balances.
  const lines = invoiceLinesFromRun({ daysWorked: 3, sales: 7, teamSales: 20, basePay: 210, commission: 301, bonus: 0, overrides: 160, deductions: 0, gross: 652, adjustmentsTotal: -20 });
  assert.deepEqual(lines.map((l) => [l.kind, l.description, l.amount]), [
    ['base', 'Base: 3 days × £70.00', 210],
    ['commission', 'Commission: 7 sales × £43.00', 301],
    ['override', 'Team overrides: 20 team sales', 160],
    ['correction', 'Corrections from earlier weeks', -20],
    ['adjustment', 'Other adjustments', 1],
  ]);
  assert.equal(invoiceLinesTotal(lines), 652);
  const odd = invoiceLinesFromRun({ daysWorked: 1, sales: 3, teamSales: 0, basePay: 63.5, commission: 100, bonus: 0, overrides: 0, deductions: 0, gross: 163.5 });
  assert.equal(odd[0]!.description, 'Base: 1 day × £63.50');
  assert.equal(odd[1]!.description, 'Commission: 3 sales', '£33.333… is not a price: no "× rate"');
  assert.equal(odd[1]!.unitPrice, undefined);
});

/** A P1 breakdown for 4 days at £63.50 (base £254.00) vs 16 confirmed subs × £10 (commission £160.00): paid the base. */
function baseWeek(): Pick<WeekPayBreakdown, 'lines' | 'weekStart'> {
  return {
    weekStart: '2026-10-12',
    lines: [
      { kind: 'base', label: '4 days × £63.50', quantity: 4, rate: 63.5, amount: 254, paid: true },
      { kind: 'commission', label: 'BCN: 16 subs × £10.00 (18 logged, 2 cancelled)', quantity: 16, rate: 10, amount: 160, paid: false, campaignId: 1, campaignCode: 'BCN' },
      { kind: 'bonus', label: 'Bonus: top performer', amount: 25, paid: true },
      { kind: 'adjustment', label: 'Correction for w/c 5 Oct: 2 cancelled by BCN', amount: -20, paid: true, sourceWeekStart: '2026-10-05' },
      { kind: 'deduction', label: 'Uniform', amount: 12.5, paid: true },
    ],
  };
}

test('lines from P1\'s breakdown: the base paid, the commission shown as not paid, corrections, a positive deduction made negative', () => {
  const lines = invoiceLinesFromBreakdown(baseWeek());
  assert.deepEqual(lines.map((l) => [l.kind, l.amount, l.paid]), [
    ['base', 254, true],
    ['commission', 160, false],
    ['bonus', 25, true],
    ['correction', -20, true],
    ['deduction', -12.5, true],
  ]);
  assert.equal(lines[1]!.campaignId, 1);
  assert.equal(lines[1]!.unitPrice, 10);
  assert.equal(lines[3]!.sourceWeekStart, '2026-10-05');
  // 254 + 25 − 20 − 12.50 = £246.50 (the £160 commission is listed, not paid)
  assert.equal(invoiceLinesTotal(lines), 246.5);
});

test('Release 1.3.1 fix: each line keeps the breakdown\'s note (why it is what it is), never one its description already says', () => {
  const week: Pick<WeekPayBreakdown, 'lines' | 'weekStart'> = {
    weekStart: '2026-10-12',
    lines: [
      { kind: 'base', label: '4 days × £63.50', quantity: 4, rate: 63.5, amount: 254, paid: false },
      { kind: 'commission', label: 'CHN: 6 subs × £45.00', quantity: 6, rate: 45, amount: 270, paid: true, campaignId: 2, campaignCode: 'CHN', note: '7 logged, 1 cancelled by CHN' },
      { kind: 'commission', label: 'BCN: 3 subs × £10.00', quantity: 3, rate: 10, amount: 30, paid: true, campaignId: 1, campaignCode: 'BCN', note: 'not yet confirmed by BCN' },
      { kind: 'bonus', label: 'Bonus: top seller in September', amount: 50, paid: true, adjustmentId: 7, note: 'top seller in September' },
      { kind: 'adjustment', label: 'Correction for w/c 5 Oct', amount: -10, paid: true, sourceWeekStart: '2026-10-05', adjustmentId: 8, note: '1 cancelled by BCN: paid for 10, confirmed 9' },
      { kind: 'adjustment', label: 'Adjustment', amount: 5, paid: true, adjustmentId: 9, note: '  ' },
      { kind: 'deduction', label: 'Deductions', amount: 12.5, paid: true },
    ],
  };
  const lines = invoiceLinesFromBreakdown(week);
  assert.deepEqual(lines.map((l) => l.note), [
    undefined,
    '7 logged, 1 cancelled by CHN',
    'not yet confirmed by BCN',
    undefined, // the bonus's note is its description already ("Bonus: top seller in September")
    '1 cancelled by BCN: paid for 10, confirmed 9',
    undefined, // nothing to say
    undefined,
  ]);
  assert.ok(!('note' in lines[0]!), 'a line without a note has no note key (stored invoices look as before)');
  // as the invoice shows it, under the description: sentence case; nothing for a line without one
  assert.deepEqual(lines.map(invoiceLineNote), [null, '7 logged, 1 cancelled by CHN', 'Not yet confirmed by BCN', null, '1 cancelled by BCN: paid for 10, confirmed 9', null, null]);
  assert.equal(invoiceLineNote({}), null, 'an invoice stored before 1.3.1 (no notes) reads as before');
  // a note is wording: the same payment with or without it, so a note alone never makes a new version
  const total = invoiceLinesTotal(lines);
  const without = lines.map(({ note: _note, ...l }) => l);
  assert.equal(sameInvoicePayment({ total, lines }, { total, lines: without }), true);
});

test('invoiceLinesFor: the breakdown when it adds up to the run, else the run\'s own figures', () => {
  const run = { daysWorked: 4, sales: 18, teamSales: 0, basePay: 254, commission: 0, bonus: 25, overrides: 0, deductions: 12.5, gross: 246.5, adjustmentsTotal: -20 };
  const fromBreakdown = invoiceLinesFor(run, baseWeek());
  assert.equal(fromBreakdown.source, 'breakdown');
  assert.equal(fromBreakdown.total, 246.5);
  // a breakdown that no longer matches the stored run (e.g. computed after a change) is not used
  const stale = invoiceLinesFor({ ...run, gross: 266.5, adjustmentsTotal: 0 }, baseWeek());
  assert.equal(stale.source, 'run');
  assert.equal(stale.total, 266.5);
  assert.equal(invoiceLinesTotal(stale.lines), 266.5);
  // no breakdown (P1 not there, or a week it cannot explain): the run's figures
  assert.equal(invoiceLinesFor(run, null).source, 'run');
  assert.equal(invoiceLinesFor(run, { weekStart: '2026-10-12', lines: [] }).source, 'run');
});

test('money and the words on the invoice', () => {
  assert.equal(invoiceMoney(1234.5), '£1,234.50');
  assert.equal(invoiceMoney(-0), '£0.00');
  assert.equal(selfBillingNote('Linear MCR Limited'), 'Self-billed invoice issued by Linear MCR Limited on behalf of the supplier under a self-billing agreement.');
  const a = selfBillingAgreementText('Linear MCR Limited');
  assert.equal(a.version, '2026-10');
  assert.match(a.body, /12:00 the day before payday/);
  assert.match(a.body, /at least 24 hours/);
  assert.match(a.body, /not to send your own invoices/);
  assert.ok(a.body.split('\n\n').length >= 8, 'paragraphs separated by blank lines');
});

test('supplier details: postcode, UTR and VAT number formats', () => {
  assert.equal(normalisePostcode('m14 5qt'), 'M14 5QT');
  assert.equal(normalisePostcode('SK11AA'), 'SK1 1AA');
  assert.equal(normalisePostcode('  wa14   1ab '), 'WA14 1AB');
  assert.equal(normalisePostcode('M1'), null);
  assert.equal(normalisePostcode('12345'), null);
  assert.equal(normalisePostcode(''), null);
  assert.equal(normaliseUtr('12345 67890'), '1234567890');
  assert.equal(normaliseUtr('123456789'), null);
  assert.equal(formatUtr('1234567890'), '12345 67890');
  assert.equal(normaliseVatNumber('gb 123 4567 89'), 'GB123456789');
  assert.equal(normaliseVatNumber('123456789'), 'GB123456789');
  assert.equal(normaliseVatNumber('GB123456789012'), 'GB123456789012');
  assert.equal(normaliseVatNumber('FR123'), null);
  assert.equal(formatVatNumber('GB123456789'), 'GB 123 4567 89');
});
