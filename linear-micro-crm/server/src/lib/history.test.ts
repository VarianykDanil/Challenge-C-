import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';
import { addEvent, addGauge, buildFixture, type Fixture } from '../test/helpers.ts';
import { weeklyHistory } from './history.ts';

// A Thursday: this week so far is Mon 12 – Wed 14 Oct; the 8 completed weeks run from Mon 17 Aug to Sun 11 Oct.
const TODAY = '2026-10-15';

function setup(): { db: Db; fx: Fixture } {
  const db = openDb(':memory:');
  createSchema(db);
  return { db, fx: buildFixture(db, TODAY) };
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

test('missing weeks are zero-filled, oldest first, with Monday keys', () => {
  const { db, fx } = setup();
  const day = (date: string, stops: number, sales: number, status: 'completed' | 'cancelled' = 'completed') =>
    addGauge(db, { eventId: addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date, status }), userId: fx.users.rep, date, stops, sales });
  day('2026-08-18', 60, 2); // week 1 (w/c 17 Aug), Tue
  day('2026-08-20', 40, 1); // week 1, Thu
  day('2026-09-28', 70, 3); // week 7 (w/c 28 Sep)
  const h = weeklyHistory(db, { userIds: [fx.users.rep] }, 8, TODAY).get(fx.users.rep)!;
  assert.equal(h.weeks.length, 8);
  assert.deepEqual(h.weeks.map((w) => w.weekStart), ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  assert.deepEqual([h.weeks[0]!.days, h.weeks[0]!.stops, h.weeks[0]!.sales], [2, 100, 3]);
  assert.deepEqual([h.weeks[6]!.days, h.weeks[6]!.stops, h.weeks[6]!.sales], [1, 70, 3]);
  for (const i of [1, 2, 3, 4, 5, 7]) {
    const w = h.weeks[i]!;
    assert.deepEqual([w.days, w.stops, w.table, w.presentations, w.closes, w.taps, w.sales], [0, 0, 0, 0, 0, 0, 0], `week ${i} zero-filled`);
  }
  assert.equal(h.current.weekStart, '2026-10-12');
  assert.equal(h.current.days, 0);
  // the funnel columns are summed too
  assert.ok(h.weeks[0]!.table > 0 && h.weeks[0]!.table <= h.weeks[0]!.stops);
});

test('current week is Monday up to yesterday: rows dated today and rows on a live event are excluded; cancelled rows count', () => {
  const { db, fx } = setup();
  const me = fx.users.rep;
  const ev = (date: string, status: 'completed' | 'cancelled' | 'live') => addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date, status });
  addGauge(db, { eventId: ev('2026-10-12', 'completed'), userId: me, date: '2026-10-12', stops: 50, sales: 2 }); // Mon: counts
  addGauge(db, { eventId: ev('2026-10-13', 'cancelled'), userId: me, date: '2026-10-13', stops: 30, sales: 1 }); // Tue, cancelled event: counts
  addGauge(db, { eventId: ev('2026-10-14', 'live'), userId: me, date: '2026-10-14', stops: 999, sales: 99 }); // Wed but still 'live': excluded
  addGauge(db, { eventId: ev(TODAY, 'completed'), userId: me, date: TODAY, stops: 888, sales: 88 }); // today: excluded
  addGauge(db, { eventId: fx.events.todayA, userId: fx.users.repA2, date: TODAY, stops: 777, sales: 77 }); // today, live: excluded
  const map = weeklyHistory(db, { userIds: [me, fx.users.repA2] }, 8, TODAY);
  const mine = map.get(me)!;
  assert.deepEqual([mine.current.days, mine.current.stops, mine.current.sales], [2, 80, 3]);
  assert.ok(mine.weeks.every((w) => w.days === 0), 'nothing in completed weeks');
  const theirs = map.get(fx.users.repA2)!;
  assert.deepEqual([theirs.current.days, theirs.current.stops], [0, 0], 'requested ids are always present, zero-filled');
});

test('rows before the window are ignored; two events on one date are one worked day', () => {
  const { db, fx } = setup();
  const me = fx.users.rep;
  const e1 = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-08-16' }); // the Sunday before the window
  addGauge(db, { eventId: e1, userId: me, date: '2026-08-16', stops: 40, sales: 1 });
  const e2 = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-10-06' });
  const e3 = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date: '2026-10-06' });
  addGauge(db, { eventId: e2, userId: me, date: '2026-10-06', stops: 20, sales: 1 });
  addGauge(db, { eventId: e3, userId: me, date: '2026-10-06', stops: 25, sales: 0 });
  const h = weeklyHistory(db, { userIds: [me] }, 8, TODAY).get(me)!;
  assert.equal(h.weeks.reduce((a, w) => a + w.stops, 0), 45, 'only the in-window rows');
  assert.deepEqual([h.weeks[7]!.days, h.weeks[7]!.stops, h.weeks[7]!.sales], [1, 45, 1]);
});

test('scopes: userIds, teamId (the user\'s current team) and all; the function never filters by viewer', () => {
  const { db, fx } = setup();
  const date = '2026-10-07';
  const evA = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date });
  const evB = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.b, date });
  addGauge(db, { eventId: evA, userId: fx.users.rep, date, stops: 50, sales: 2 });
  addGauge(db, { eventId: evA, userId: fx.users.leader, date, stops: 40, sales: 1 });
  addGauge(db, { eventId: evB, userId: fx.users.repB, date, stops: 30, sales: 1 });
  const team = weeklyHistory(db, { teamId: fx.teams.a }, 4, TODAY);
  assert.deepEqual([...team.keys()].sort((x, y) => x - y), [fx.users.leader, fx.users.rep].sort((x, y) => x - y));
  assert.equal(team.get(fx.users.rep)!.weeks.length, 4);
  const everyone = weeklyHistory(db, { all: true }, 4, TODAY);
  assert.deepEqual([...everyone.keys()].sort((x, y) => x - y), [fx.users.leader, fx.users.rep, fx.users.repB].sort((x, y) => x - y));
  assert.equal(weeklyHistory(db, { userIds: [] }, 4, TODAY).size, 0);
  assert.equal(weeklyHistory(db, { userIds: [fx.users.repB, fx.users.repB] }, 4, TODAY).size, 1, 'duplicate ids collapse');
  assert.equal(weeklyHistory(db, { userIds: [fx.users.rep] }, 0, TODAY).get(fx.users.rep)!.weeks.length, 0, '0 weeks → current only');
});

test('one SQL statement per call, whatever the scope', () => {
  const { db, fx } = setup();
  for (let i = 0; i < 6; i++) {
    const date = `2026-09-${String(14 + i).padStart(2, '0')}`;
    const ev = addEvent(db, { campaignId: fx.campaignId, teamId: fx.teams.a, date });
    for (const u of [fx.users.rep, fx.users.repA2, fx.users.leader]) addGauge(db, { eventId: ev, userId: u, date, stops: 40 + i, sales: i % 3 });
  }
  for (const scope of [{ userIds: [fx.users.rep, fx.users.repA2, fx.users.leader, fx.users.repB] }, { teamId: fx.teams.a }, { all: true as const }]) {
    const { result, statements } = countStatements(db, () => weeklyHistory(db, scope, 16, TODAY));
    assert.equal(statements, 1, `one statement for ${JSON.stringify(scope)}`);
    assert.ok(result.size >= 3);
  }
});
