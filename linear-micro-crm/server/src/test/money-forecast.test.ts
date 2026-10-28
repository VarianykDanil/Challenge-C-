/**
 * CLM-9: the pay estimate talks about a bonus only when the pay rule has one. Under the base-or-commission rule there
 * is no automatic bonus (bonuses are added by hand), so the demo rep's estimate says how many more subs beat the base
 * instead, and never "N more sales unlock your bonus".
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.ts';

let srv: TestServer;

before(async () => {
  srv = await startTestServer({ seed: true });
});
after(() => srv.close());

test('the demo rep: no bonus distance, the base-or-commission line instead', async () => {
  const rep = await srv.login('rep');
  let checked = 0;
  for (const path of ['/finance/me', '/me/insights']) {
    const r = await rep.get(path);
    assert.equal(r.status, 200, path);
    const f = r.json.forecast;
    if (!f) continue; // no estimate on this answer (e.g. no team event days)
    assert.equal(f.bonusLikelihood, 'none', path);
    assert.deepEqual([f.bonusThreshold, f.bonusAmount, f.bonusGap], [0, 0, 0], path);
    assert.ok(f.rule, `${path}: the rule's line (subs to beat the base) replaces the bonus line`);
    assert.equal(typeof f.rule.subsToBeatBase, 'number');
    checked++;
  }
  assert.ok(checked > 0, 'an estimate was checked');
});
