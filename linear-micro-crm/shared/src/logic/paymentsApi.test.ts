// Release 1.4 — package A (API providers): what the three API ways to pay say about themselves. Each says plainly
// what is done outside Linear Hub (connect steps), what live needs (its own keys), what Matt approves and what happens
// while payments are on their way — the copy the Settings → Payments cards and the payment page show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_PROVIDERS, abilityChecklist, paymentProviderInfo } from './payments.ts';

const API = ['revolut', 'wise', 'truelayer'] as const;

test('each API provider: how to connect (steps outside Linear Hub included), what live needs, what happens after approving', () => {
  for (const id of API) {
    const p = paymentProviderInfo(id)!;
    assert.ok(p.connectSteps && p.connectSteps.length >= 3, `${id} connect steps`);
    assert.ok(p.connectSteps.some((s) => /sandbox/i.test(s)), `${id}: says test mode uses the sandbox`);
    assert.match(p.liveNote ?? '', /live/i, `${id} live note`);
    assert.ok((p.waitingNote ?? '').length > 40, `${id} waiting note`);
    for (const text of [...p.connectSteps, p.liveNote ?? '', p.waitingNote ?? '', p.approveNote ?? '']) {
      assert.doesNotMatch(text, /[✓✗]/, 'plain words, the page draws ticks');
      assert.doesNotMatch(text, /\b(payslip|TODO)\b/i);
    }
  }
  // the bank file says what to do itself (download, upload, mark paid): none of these
  const file = paymentProviderInfo('bank_file')!;
  assert.equal(file.connectSteps, undefined);
  assert.equal(file.waitingNote, undefined);
});

test('Revolut: pays from Linear Hub; a certificate and Enable access happen in Revolut, the code works for 2 minutes', () => {
  const p = paymentProviderInfo('revolut')!;
  assert.equal(p.abilities.paysFromApp, true);
  assert.equal(p.abilities.confirmsAutomatically, true);
  assert.equal(p.abilities.checksBalance, true);
  const steps = p.connectSteps!.join(' ');
  assert.match(steps, /Settings → APIs → Business API/);
  assert.match(steps, /Enable access/);
  assert.match(steps, /2 minutes/);
  assert.match(p.waitingNote!, /approve/i, 'payments waiting for an approver in Revolut are said plainly');
  assert.equal(p.approveNote, undefined, 'Revolut pays as soon as it is approved: the page says that already');
});

test('Wise: Linear Hub creates the transfers; Matt pays (funds) them in Wise — said on the card, when approving and while waiting', () => {
  const p = paymentProviderInfo('wise')!;
  assert.equal(p.abilities.paysFromApp, false, 'a personal token cannot fund transfers for a UK business');
  assert.equal(p.abilities.needsBankApproval, true);
  assert.equal(p.abilities.checksBalance, false);
  assert.match(p.summary, /pay \(fund\) them in Wise/);
  assert.match(p.abilities.limits, /does not let an API token pay/);
  assert.match(p.approveNote ?? '', /Nobody is paid until you open Wise and pay/);
  assert.match(p.waitingNote!, /open Wise and pay/i);
  assert.match(p.waitingNote!, /cancels/i, 'Wise cancels transfers not paid in time');
  const lines = Object.fromEntries(abilityChecklist(p.abilities).map((l) => [l.key, l.ok]));
  assert.equal(lines.paysFromApp, false);
  assert.equal(lines.needsBankApproval, true);
});

test('TrueLayer: pays from the merchant account Matt tops up; fees per payout from the agreement; signing key made on a computer', () => {
  const p = paymentProviderInfo('truelayer')!;
  assert.equal(p.abilities.paysFromApp, true);
  assert.match(p.abilities.fees, /check your TrueLayer agreement/);
  assert.match(p.abilities.limits, /top it up/);
  assert.match(p.connectSteps!.join(' '), /upload the public key in the TrueLayer Console/);
  assert.match(p.waitingNote!, /merchant account/);
});

test('the list keeps its order and ids (additive fields only)', () => {
  assert.deepEqual(PAYMENT_PROVIDERS.map((p) => p.id), ['bank_file', 'revolut', 'wise', 'truelayer']);
});
