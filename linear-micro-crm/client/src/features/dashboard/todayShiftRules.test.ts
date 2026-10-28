// Which events the dashboard's "Today" card shows at the top (todayShiftRules.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesEventWithMeta } from '@lm/shared';
import { showsTodayCard, todaysShifts } from './todayShiftRules.ts';

const ev = (id: number, o: Partial<SalesEventWithMeta> = {}): SalesEventWithMeta =>
  ({ id, date: '2026-10-27', teamId: 2, status: 'live', startTime: '10:00', endTime: '18:00', name: `Event ${id}`, ...o }) as unknown as SalesEventWithMeta;

test('reps and leaders with a team get the card; owners, recruiters and clients do not', () => {
  assert.equal(showsTodayCard({ role: 'rep', teamId: 2 }), true);
  assert.equal(showsTodayCard({ role: 'leader', teamId: 2 }), true);
  assert.equal(showsTodayCard({ role: 'rep', teamId: null }), false);
  assert.equal(showsTodayCard({ role: 'admin', teamId: 2 }), false);
  assert.equal(showsTodayCard({ role: 'recruiter', teamId: null }), false);
});

test('today’s events for my own team, earliest first; cancelled, other teams and other days are left out', () => {
  const me = { role: 'rep' as const, teamId: 2 };
  const list = [
    ev(1, { startTime: '14:00' }),
    ev(2, { startTime: '09:30' }),
    ev(3, { status: 'cancelled' }),
    ev(4, { teamId: 3 }),
    ev(5, { date: '2026-10-28' }),
    ev(6, { date: '2026-10-26', status: 'completed' }),
  ];
  assert.deepEqual(todaysShifts(list, me, '2026-10-27').map((e) => e.id), [2, 1]);
  assert.deepEqual(todaysShifts(undefined, me, '2026-10-27'), []);
  assert.deepEqual(todaysShifts(list, { role: 'admin', teamId: 2 }, '2026-10-27'), []);
});
