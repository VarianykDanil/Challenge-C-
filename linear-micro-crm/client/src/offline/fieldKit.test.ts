// The "field kit": what this phone keeps so Linear Hub opens with no signal (src/offline/fieldKit.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesEventWithMeta, UserWithTeam } from '@lm/shared';
import { KIT_MAX_AGE_MS, KIT_MAX_EVENTS, kitUser, parseKit, withEvents, withUser } from './fieldKitLogic.ts';

const user: UserWithTeam = {
  id: 10, employeeId: 'LM-0010', email: 'jordan.lee@example.test', firstName: 'Jordan', lastName: 'Lee', role: 'rep', position: 'field_rep',
  teamId: 2, payPlanId: 3, startDate: '2026-01-05', status: 'active', phone: '07700 900123', avatarColor: '#4F46E5', city: 'Manchester',
  teamName: 'Northern Lights', payPlanName: 'Field rep (commission)', twoFactorEnabled: true, hasPin: true, pinSetupRequired: false, twoFactorSetupRequired: false,
};
const event = (id: number, date: string): SalesEventWithMeta => ({ id, date, teamId: 2, name: `Event ${id}`, startTime: '10:00', endTime: '18:00', status: 'scheduled' } as unknown as SalesEventWithMeta);
const NOW = Date.parse('2026-10-27T11:30:00Z');

test('keeps only what the app needs to open: no email, phone, pay plan or sign-in flags', () => {
  const kit = withUser(null, user, NOW);
  const raw = JSON.stringify(kit);
  for (const secret of ['jordan.lee@example.test', '07700 900123', 'Field rep (commission)', 'payPlanId', 'twoFactorEnabled', 'hasPin', 'Manchester']) {
    assert.ok(!raw.includes(secret), `${secret} is not kept`);
  }
  const back = kitUser(parseKit(raw, NOW));
  assert.equal(back?.id, 10);
  assert.equal(back?.firstName, 'Jordan');
  assert.equal(back?.role, 'rep');
  assert.equal(back?.teamId, 2);
  assert.equal(back?.teamName, 'Northern Lights');
  assert.equal(back?.email, '', 'filled with an empty value, never the real one');
});

test('a different person signing in on the phone replaces the kit, events and all', () => {
  const first = withEvents(withUser(null, user, NOW), 10, [event(1, '2026-10-27')], NOW);
  const other = withUser(first, { ...user, id: 11, firstName: 'Sam' }, NOW);
  assert.equal(other.user.id, 11);
  assert.deepEqual(other.events, []);
});

test('events are kept for the same person only, newest first, at most KIT_MAX_EVENTS', () => {
  const kit = withUser(null, user, NOW);
  const many = Array.from({ length: KIT_MAX_EVENTS + 15 }, (_, i) => event(i + 1, `2026-10-${String((i % 27) + 1).padStart(2, '0')}`));
  const filled = withEvents(kit, 10, many, NOW);
  assert.equal(filled.events.length, KIT_MAX_EVENTS);
  assert.ok(filled.events[0]!.date >= filled.events[filled.events.length - 1]!.date);
  assert.equal(withEvents(kit, 99, many, NOW), kit, 'another person’s events are ignored');
});

test('an old, broken or foreign kit is ignored', () => {
  const kit = JSON.stringify(withUser(null, user, NOW));
  assert.equal(parseKit(kit, NOW + KIT_MAX_AGE_MS + 1), null, 'too old');
  assert.equal(parseKit('{not json', NOW), null);
  assert.equal(parseKit(JSON.stringify({ v: 1, user: { id: 'x' } }), NOW), null);
  assert.equal(parseKit(null, NOW), null);
  assert.equal(parseKit(JSON.stringify({ ...JSON.parse(kit), v: 99 }), NOW), null, 'another version');
});
