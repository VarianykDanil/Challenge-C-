/**
 * GET /me/attention (p5) on the small fixture: role scoping, resolution by a real write, the to-pay count matching
 * Runs to pay, the response cache and the query budget. Shapes and scoping only — never seeded names.
 * The business clock is pinned to a Thursday afternoon: a rep's own unlogged days are THIS PAY WEEK only, so on a
 * Monday the fixture's "yesterday" (a Sunday) would belong to last week and rightly ask for nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paydayForWeek, remainingFraction, type UserWithTeam } from '@lm/shared';
import { run, type Db } from '../db/connection.ts';
import { getUser } from '../db/queries.ts';
import { addDays, mondayOf, setBusinessClock, todayISO } from '../lib/dates.ts';
import { attentionNow, buildAttentionFeed } from '../routes/attention.ts';
import { addEvent, addGauge, funnelFrom, startTestServer, withSmart, type Json } from './helpers.ts';

// Thu 15 Oct 2026, 15:00 London (the server test script pins TZ=Europe/London). Monday 12 Oct starts this pay week.
const THURSDAY = new Date('2026-10-15T15:00:00');
setBusinessClock(THURSDAY);

const keysOf = (r: { json: Json }) => (r.json.items as Json[]).map((i) => i.key as string);

/** A payroll run inserted directly (no gauges behind it). */
function addRun(db: Db, p: { userId: number; weekStart: string; gross: number; status: 'pending' | 'failed' | 'paid' | 'late'; paidDate?: string | null; ref: string }): number {
  return run(
    db,
    `INSERT INTO payroll_runs (user_id, week_start, week_end, days_worked, sales, team_sales, base_pay, commission, bonus, overrides, deductions, gross, due_date, paid_date, status, reference)
     VALUES (?, ?, ?, 1, 0, 0, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)`,
    [p.userId, p.weekStart, addDays(p.weekStart, 6), p.gross, p.gross, paydayForWeek(p.weekStart), p.paidDate ?? null, p.status, p.ref],
  ).lastInsertRowid;
}

/** Count every SQL statement prepared or executed on `db` while `fn` runs. */
function countStatements<T>(db: Db, fn: () => T): { result: T; statements: number } {
  const proto = Object.getPrototypeOf(db) as { prepare: Db['prepare']; exec: Db['exec'] };
  let statements = 0;
  const prepare = db.prepare;
  const exec = db.exec;
  Object.assign(db, {
    prepare: (sql: string) => {
      statements++;
      return proto.prepare.call(db, sql);
    },
    exec: (sql: string) => {
      statements++;
      return proto.exec.call(db, sql);
    },
  });
  try {
    return { result: fn(), statements };
  } finally {
    Object.assign(db, { prepare, exec });
  }
}

test('rep: yesterday’s unlogged team-A event → gauges:event, gone after POST /gauges; never team-wide, payroll or recruitment keys', async () => {
  const srv = await startTestServer();
  try {
    const fx = srv.fixture!;
    const rep = await srv.login('rep');
    const key = `gauges:event:${fx.events.yesterdayA}:user:${fx.users.rep}`;
    const before = await rep.get('/me/attention');
    assert.equal(before.status, 200);
    const item = (before.json.items as Json[]).find((i) => i.key === key);
    assert.ok(item, `expected ${key} in ${keysOf(before).join(', ')}`);
    assert.equal(item.kind, 'gauges');
    assert.equal(item.severity, 'warning');
    assert.equal(item.href, `/gauges?log=1&eventId=${fx.events.yesterdayA}`);
    assert.match(item.body, /£60 base plus commission/, 'the rep’s own plan: £60 a day');
    // the rep's own team only: never team B's events
    const teamB = [fx.events.yesterdayB, fx.events.todayB, fx.events.tomorrowB];
    for (const i of before.json.items as Json[]) for (const id of teamB) assert.ok(!i.href.includes(`eventId=${id}`) && !i.href.endsWith(`/events/${id}`));

    const yesterday = addDays(fx.today, -1);
    const posted = await rep.post('/gauges', { eventId: fx.events.yesterdayA, userId: fx.users.rep, date: yesterday, ...funnelFrom(40, 2) });
    assert.ok(posted.status === 201 || posted.status === 200, `POST /gauges → ${posted.status} ${JSON.stringify(posted.json)}`);
    const after = await rep.get('/me/attention');
    assert.equal(after.headers.get('x-cache'), 'MISS', 'the write invalidated the cached feed');
    assert.ok(!keysOf(after).includes(key), 'resolved by logging');

    // even when the team has gaps, empty events and unpaid runs, a rep only ever hears about themself
    addGauge(srv.db, { eventId: fx.events.yesterdayB, userId: fx.users.repB, date: yesterday, stops: 30, sales: 0, table: 0 });
    addRun(srv.db, { userId: fx.users.repA2, weekStart: addDays(mondayOf(fx.today), -14), gross: 300, status: 'failed', ref: 'PAY-T-A2' });
    srv.resetCache();
    const mine = keysOf(await rep.get('/me/attention'));
    assert.ok(mine.every((k) => !/^(gauges:gap|gauges:odd|events:empty|events:behind|payroll:|recruitment:|security:)/.test(k)), mine.join(', '));
    assert.ok(mine.every((k) => !k.startsWith('gauges:event:') || k.endsWith(`:user:${fx.users.rep}`)));
  } finally {
    await srv.close();
  }
});

test('leader: own team only — a gap for team A’s missing rep, never team-B event ids; admin sees both teams', async () => {
  const srv = await startTestServer();
  try {
    const fx = srv.fixture!;
    const yesterday = addDays(fx.today, -1);
    addGauge(srv.db, { eventId: fx.events.yesterdayA, userId: fx.users.rep, date: yesterday, stops: 40, sales: 2 }); // repA2 has not logged
    srv.resetCache();
    const [leader, admin] = await Promise.all([srv.login('leader'), srv.login('admin')]);
    const l = await leader.get('/me/attention');
    assert.equal(l.status, 200);
    const gap = (l.json.items as Json[]).find((i) => i.key === `gauges:gap:${fx.events.yesterdayA}`);
    assert.ok(gap, keysOf(l).join(', '));
    assert.match(gap.title, /^2 of 3 have not logged/, 'the whole team counts: two reps and the leader');
    assert.equal(gap.count, 2, 'the missing count travels with the item');
    assert.match(gap.body, /: you and Rita\./, 'the leader is not chased by name');
    assert.equal(gap.href, `/gauges?log=1&eventId=${fx.events.yesterdayA}&userId=${fx.users.repA2}`);
    assert.equal(gap.actionLabel, 'Log for Rita');
    const teamB = new Set([fx.events.yesterdayB, fx.events.todayB, fx.events.tomorrowB].map(String));
    for (const i of l.json.items as Json[]) {
      const ids = [...String(i.key).matchAll(/:(\d+)/g), ...String(i.href).matchAll(/(?:eventId=|\/events\/)(\d+)/g)].map((m) => m[1]!);
      assert.ok(ids.every((id) => !teamB.has(id)), `${i.key} ${i.href}`);
    }
    // the admin sees team B too: yesterday's team-B event has no rows at all
    const a = keysOf(await admin.get('/me/attention'));
    assert.ok(a.includes(`events:empty:${fx.events.yesterdayB}`), a.join(', '));
    assert.ok(a.includes(`gauges:gap:${fx.events.yesterdayA}`));
    assert.ok(!keysOf(l).includes(`events:empty:${fx.events.yesterdayB}`));
  } finally {
    await srv.close();
  }
});

test('admin: payroll:to-pay counts exactly the runs GET /finance/payroll?status=pending,failed lists; repeat GET is a cache HIT', async () => {
  const srv = await startTestServer();
  try {
    const fx = srv.fixture!;
    const lastWeek = addDays(mondayOf(fx.today), -7);
    const twoWeeks = addDays(lastWeek, -7);
    // latest run = last completed week, so ensurePayrollMaterialised has nothing to add
    addRun(srv.db, { userId: fx.users.rep, weekStart: lastWeek, gross: 412.5, status: 'pending', ref: 'PAY-T-1' });
    addRun(srv.db, { userId: fx.users.repA2, weekStart: lastWeek, gross: 300, status: 'pending', ref: 'PAY-T-2' });
    addRun(srv.db, { userId: fx.users.repB, weekStart: twoWeeks, gross: 250.25, status: 'failed', ref: 'PAY-T-3' }); // overdue
    addRun(srv.db, { userId: fx.users.leader, weekStart: twoWeeks, gross: 500, status: 'paid', paidDate: addDays(twoWeeks, 11), ref: 'PAY-T-4' });
    addRun(srv.db, { userId: fx.users.repB, weekStart: addDays(mondayOf(fx.today), -7 * 14), gross: 99, status: 'pending', ref: 'PAY-T-5' }); // outside the window
    // a failed transfer is wages still owed whatever its age: on the card, in the count and in the total
    const oldFailed = addRun(srv.db, { userId: fx.users.repB, weekStart: addDays(mondayOf(fx.today), -7 * 20), gross: 100, status: 'failed', ref: 'PAY-T-6' });
    srv.resetCache();
    const admin = await srv.login('admin');
    const first = await admin.get('/me/attention');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    const toPay = (first.json.items as Json[]).find((i) => i.key === 'payroll:to-pay');
    assert.ok(toPay, keysOf(first).join(', '));
    const listed = await admin.get('/finance/payroll?status=pending,failed');
    assert.equal(listed.status, 200);
    const count = Number(/^(\d+) runs? to pay/.exec(toPay.title)?.[1]);
    assert.equal(count, listed.json.length);
    assert.equal(count, 4);
    assert.ok((listed.json as Json[]).some((r) => r.id === oldFailed), 'Runs to pay lists the 20-week-old failed transfer');
    assert.ok(!(listed.json as Json[]).some((r) => r.reference === 'PAY-T-5'), 'an old pending run keeps the 12-week default');
    assert.equal(toPay.count, listed.json.length, 'the summary count (client unread token) is the same number');
    assert.match(toPay.title, /£1,062\.75 · 2 failed transfers$/);
    // an explicit range still means that range
    const ranged = await admin.get(`/finance/payroll?status=pending,failed&from=${twoWeeks}&to=${fx.today}`);
    assert.ok(!(ranged.json as Json[]).some((r) => r.id === oldFailed), 'from/to given: only that range');
    assert.equal(toPay.severity, 'danger', 'one run is past its due date');
    assert.equal(toPay.href, '/finance?tab=company#runs');
    assert.ok(keysOf(first).includes('security:2fa'), 'the fixture admin has two-step off');
    const second = await admin.get('/me/attention');
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.deepEqual(second.json, first.json);

    // the rep whose run is in the list hears about their own pay only
    const rep = await srv.login('rep');
    const repKeys = keysOf(await rep.get('/me/attention'));
    assert.ok(repKeys.every((k) => !k.startsWith('payroll:')));
    // the rep with the old failed transfer is told the office sees it (it is on Runs to pay), not asked to chase it
    const bo = (await (await srv.login('repB')).get('/me/attention')).json.items as Json[];
    const owed = bo.find((i) => i.key === `pay:overdue:${oldFailed}`);
    assert.ok(owed, bo.map((i) => i.key).join(', '));
    assert.match(owed.body, /The office sees this too\.$/);
    // the paid leader run (paid 3 days after the week's payday) is an info item only while it is recent
    const leaderKeys = keysOf(await (await srv.login('leader')).get('/me/attention'));
    assert.ok(leaderKeys.every((k) => !k.startsWith('payroll:')));
  } finally {
    await srv.close();
  }
});

test('every role: at most 12 statements to build the feed; LM_SMART=0 → empty and disabled', async () => {
  const srv = await startTestServer({ seed: true });
  try {
    const now = attentionNow();
    for (const email of ['danil@linear-mcr.co.uk', 'amelia.hart@linear-mcr.co.uk', 'priya.shah@linear-mcr.co.uk', 'jordan.lee@linear-mcr.co.uk']) {
      const id = (srv.db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: number }).id;
      const me: UserWithTeam = { ...getUser(srv.db, id)!, twoFactorEnabled: false };
      const { result, statements } = countStatements(srv.db, () => buildAttentionFeed(srv.db, me, now));
      assert.ok(statements <= 12, `${me.role}: ${statements} statements`);
      assert.ok(result.items.length <= 20);
      assert.equal(result.disabled, undefined);
      const again = buildAttentionFeed(srv.db, me, now);
      assert.deepEqual(again, result, `${me.role}: deterministic`);
    }
    const rep = await srv.login('rep');
    await withSmart('0', async () => {
      srv.resetCache();
      const r = await rep.get('/me/attention');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.items, []);
      assert.equal(r.json.disabled, true);
    });
    srv.resetCache();
    const on = await rep.get('/me/attention');
    assert.equal(on.json.disabled, undefined);
    assert.ok(on.json.generatedAt.startsWith(todayISO().slice(0, 4)));
  } finally {
    await srv.close();
  }
});

test('rep: the whole pay week is asked for (Monday … yesterday), never a day of the week before', async () => {
  // Sunday 18 Oct: Monday 12 Oct is 6 days back, beyond the team rules' 3-day look-back, so the route must load it
  setBusinessClock(new Date('2026-10-18T15:00:00'));
  const srv = await startTestServer();
  try {
    const fx = srv.fixture!;
    assert.equal(fx.today, '2026-10-18');
    const monday = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-10-12' });
    const wednesday = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-10-14' });
    const lastSunday = addEvent(srv.db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-10-11' });
    srv.resetCache();
    const rep = await srv.login('rep');
    const keys = keysOf(await rep.get('/me/attention'));
    const own = (eventId: number) => `gauges:event:${eventId}:user:${fx.users.rep}`;
    assert.ok(keys.includes(own(monday)), `Monday of this week: ${keys.join(', ')}`);
    assert.ok(keys.includes(own(wednesday)));
    assert.ok(keys.includes(own(fx.events.yesterdayA)), 'yesterday (Saturday) too');
    assert.ok(!keys.includes(own(lastSunday)), 'last week’s Sunday is never asked for');
    const item = (await rep.get('/me/attention')).json.items.find((i: Json) => i.key === own(monday));
    assert.match(item.body, /that day’s £60 base plus commission is not in Friday’s pay \(23 Oct\) until it is logged\.$/, 'the pay-cost wording');
    // logging Monday clears just that day
    addGauge(srv.db, { eventId: monday, userId: fx.users.rep, date: '2026-10-12', stops: 40, sales: 2 });
    srv.resetCache();
    const after = keysOf(await rep.get('/me/attention'));
    assert.ok(!after.includes(own(monday)) && after.includes(own(wednesday)), after.join(', '));
    // the leader's own items follow the same week; never a team-B event
    const leaderKeys = keysOf(await (await srv.login('leader')).get('/me/attention'));
    assert.ok(leaderKeys.includes(`gauges:event:${monday}:user:${fx.users.leader}`), leaderKeys.join(', '));
    assert.ok(!leaderKeys.includes(`gauges:event:${lastSunday}:user:${fx.users.leader}`));
  } finally {
    await srv.close();
    setBusinessClock(THURSDAY);
  }
});

test('recruiter: interview outcomes follow the one shared rule — 120-minute grace, 56-day look-back, open candidates', async () => {
  const srv = await startTestServer(); // Thu 15 Oct 2026, 15:00 London (14:00Z)
  try {
    const fx = srv.fixture!;
    const recruiter = await srv.login('recruiter');
    const make = async (firstName: string) => {
      const r = await recruiter.post('/recruitment/candidates', { firstName, lastName: 'Test', email: `${firstName.toLowerCase()}@x.test`, ownerId: fx.users.recruiter });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.id as number;
    };
    const interview = async (candidateId: number, scheduledAt: string) => {
      const r = await recruiter.post('/recruitment/interviews', { candidateId, type: 'first', scheduledAt, interviewerId: fx.users.recruiter });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.id as number;
    };
    const ids = {
      threeHours: await interview(await make('Courtney'), '2026-10-15T11:00:00.000Z'),
      oneHour: await interview(await make('Nadia'), '2026-10-15T13:00:00.000Z'),
      fiveDays: await interview(await make('Cameron'), '2026-10-10T09:00:00.000Z'), // outside the old ±2-day load
      sixtyDays: await interview(await make('Eleanor'), '2026-08-16T09:00:00.000Z'), // past the 56-day look-back
    };
    const closedCandidate = await make('Rory');
    const closed = await interview(closedCandidate, '2026-10-14T09:00:00.000Z');
    srv.db.prepare(`UPDATE candidates SET stage = 'rejected' WHERE id = ?`).run(closedCandidate);
    srv.resetCache();
    const outcomeKeys = (r: { json: Json }) => keysOf(r).filter((k) => k.startsWith('recruitment:interview:')).sort();
    // not ids.oneHour (inside the 120-minute grace), ids.sixtyDays (past the look-back) or the closed candidate's
    const want = [ids.threeHours, ids.fiveDays].map((id) => `recruitment:interview:${id}`).sort();
    assert.deepEqual(outcomeKeys(await recruiter.get('/me/attention')), want);
    // the admin sees the same interviews (all of them); a leader who neither ran nor owns them sees none
    assert.deepEqual(outcomeKeys(await (await srv.login('admin')).get('/me/attention')), want);
    assert.deepEqual(outcomeKeys(await (await srv.login('leader')).get('/me/attention')), []);
    assert.ok(!keysOf(await recruiter.get('/me/attention')).includes(`recruitment:interview:${closed}`));
    // recording the outcome clears it
    const patched = await recruiter.patch(`/recruitment/interviews/${ids.fiveDays}`, { outcome: 'passed' });
    assert.equal(patched.status, 200);
    assert.deepEqual(outcomeKeys(await recruiter.get('/me/attention')), [`recruitment:interview:${ids.threeHours}`]);
  } finally {
    await srv.close();
  }
});

test('events:behind follows the row\'s "Behind target" pill; the recruiter\'s overdue item says whose and quotes the tile', async () => {
  const srv = await startTestServer({ seed: true }); // Thu 15 Oct 2026, 15:00 London: the seed has events live now
  try {
    const today = todayISO();
    for (const who of ['admin', 'leader'] as const) {
      const client = await srv.login(who);
      const feed = keysOf(await client.get('/me/attention'));
      const me = (await client.get('/auth/me')).json.user;
      const events = (await client.get(`/events?from=${today}&to=${today}`)).json as Json[];
      // the feed's team items cover the leader's own team (admin: every team); /events shows a leader every team
      const live = events.filter((e) => (who === 'admin' || e.teamId === me.teamId) && e.status === 'live' && e.forecast && e.targetSales > 0 && e.startTime <= '15:00' && '15:00' < e.endTime);
      if (who === 'admin') assert.ok(live.length > 0, 'the seed has events live at 15:00 with a forecast');
      for (const e of live) {
        const pill = e.forecast.flag === 'at_risk';
        assert.equal(feed.includes(`events:behind:${e.id}`), pill, `${who}: event ${e.id} pill ${pill} vs feed ${feed.join(', ')}`);
      }
    }
    // a target where the old half-target rule and the pill disagree: the feed follows the pill
    const admin = await srv.login('admin');
    const picked = ((await admin.get(`/events?from=${today}&to=${today}`)).json as Json[]).find((x) => x.status === 'live' && x.forecast && x.startTime <= '15:00' && '15:00' < x.endTime)!;
    // most of its day still to come (14:00–21:00), so the estimate for the rest of the day carries weight
    run(srv.db, `UPDATE events SET start_time = '14:00', end_time = '21:00' WHERE id = ?`, [picked.id]);
    srv.resetCache();
    const e = ((await admin.get(`/events?from=${today}&to=${today}`)).json as Json[]).find((x) => x.id === picked.id)!;
    const sales = Number(e.totals.sales);
    const ahead = Number(e.forecast.expectedSales) * remainingFraction(e.startTime, e.endTime, '15:00');
    const target = Array.from({ length: 300 }, (_, i) => i + 1).find((t) => {
      const half = sales < 0.5 * t;
      const projected = sales + ahead - 0.7 * t; // < 0 → at risk; keep clear of the boundary (rounding)
      return Math.abs(projected) > 0.3 && sales !== 0.5 * t && half !== projected < 0;
    })!;
    assert.ok(target, `a disagreeing target exists for ${sales} sales, ${ahead} to come`);
    run(srv.db, `UPDATE events SET target_sales = ? WHERE id = ?`, [target, e.id]);
    srv.resetCache();
    const after = ((await admin.get(`/events?from=${today}&to=${today}`)).json as Json[]).find((x) => x.id === e.id)!;
    const pill = after.forecast.flag === 'at_risk';
    assert.notEqual(pill, sales < 0.5 * target, 'the half-target rule would say the opposite');
    assert.equal(keysOf(await admin.get('/me/attention')).includes(`events:behind:${e.id}`), pill, `target ${target}: the feed follows the pill`);
    const recruiter = await srv.login('recruiter');
    const item = ((await recruiter.get('/me/attention')).json.items as Json[]).find((i) => i.key === 'recruitment:overdue');
    const tile = Number((await recruiter.get('/recruitment/summary')).json.overdueActions);
    if (item) {
      assert.match(item.title, /^\d+ of your recruitment follow-ups? (is|are) overdue$/);
      assert.match(item.body, /\(yours or unassigned(; \d+ across the pipeline)?\)\. Book it or move them on\.$/);
      const across = /; (\d+) across the pipeline/.exec(item.body)?.[1];
      if (item.count < tile) assert.equal(Number(across), tile, 'the pipeline figure is the Overdue actions tile');
      else assert.equal(across, undefined);
    }
  } finally {
    await srv.close();
  }
});
