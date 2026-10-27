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
  // the bank file says what to do itself (download, upload, mark paid); its connect steps (CLM-3, MON-6)
  // say it starts in test mode, the 1p test file comes before the first real run, and which layouts are documented
  const file = paymentProviderInfo('bank_file')!;
  const steps = file.connectSteps!.join(' ');
  assert.match(steps, /test mode/);
  assert.match(steps, /TEST/);
  assert.match(steps, /1p test file/);
  assert.match(steps, /PAY FOR REAL/);
  assert.match(steps, /own published guide/);
  assert.equal(file.waitingNote, undefined);
});

test('CLAIMS-MISSED-3: Wise says plainly that Linear Hub creates the transfers, you fund them, unfunded ones come back', () => {
  const p = paymentProviderInfo('wise')!;
  for (const text of [p.summary, p.abilities.limits, p.approveNote!, p.waitingNote!]) {
    assert.match(text, /fund/i, text);
  }
  assert.match(p.summary, /creates the transfers/);
  assert.match(p.summary, /back to Runs to pay/);
  assert.match(p.waitingNote!, /back to Runs to pay/);
  assert.match(p.approveNote!, /creates the transfers/);
  // MON-5 / CLM-1: every API provider says the sandbox payment comes first and the first live run is small
  for (const id of ['revolut', 'wise', 'truelayer']) {
    const q = paymentProviderInfo(id)!;
    assert.match(q.connectSteps!.join(' '), /test payment through the sandbox first/, id);
    assert.match(q.liveNote!, /first live run small/, id);
  }
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
  // "fund" everywhere, and what happens to transfers nobody funds
  assert.match(p.summary, /you fund them in Wise/);
  assert.match(p.abilities.limits, /does not let an API token fund/);
  assert.match(p.approveNote ?? '', /nobody is paid until you fund them in Wise/);
  assert.match(p.waitingNote!, /open Wise and fund/i);
  assert.match(p.waitingNote!, /cancelled by Wise/i, 'Wise cancels transfers not funded in time');
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
