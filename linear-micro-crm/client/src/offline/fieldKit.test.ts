// The "field kit": what this phone keeps so Linear Hub opens with no signal (src/offline/fieldKit.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SalesEventWithMeta, SessionInfo, UserWithTeam } from '@lm/shared';
import { KIT_MAX_EVENTS, KIT_NO_SESSION_HOURS, keepsKit, kitUser, parseKit, touchKit, withEvents, withUser } from './fieldKitLogic.ts';

const HOUR = 3_600_000;
const user: UserWithTeam = {
  id: 10, employeeId: 'LM-0010', email: 'jordan.lee@example.test', firstName: 'Jordan', lastName: 'Lee', role: 'rep', position: 'field_rep',
  teamId: 2, payPlanId: 3, startDate: '2026-01-05', status: 'active', phone: '07700 900123', avatarColor: '#4F46E5', city: 'Manchester',
  teamName: 'Northern Lights', payPlanName: 'Field rep (commission)', twoFactorEnabled: true, hasPin: true, pinSetupRequired: false, twoFactorSetupRequired: false,
};
const event = (id: number, date: string): SalesEventWithMeta => ({ id, date, teamId: 2, name: `Event ${id}`, startTime: '10:00', endTime: '18:00', status: 'scheduled' } as unknown as SalesEventWithMeta);
const NOW = Date.parse('2026-10-27T11:30:00Z');
/** A 14-hour session signed in at 09:00 that ends at 23:00, idle sign-out after 12 hours. */
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  signedInAt: '2026-10-27T09:00:00.000Z', endsAt: '2026-10-27T23:00:00.000Z', maxHours: 14, idleHours: 12, ...over,
});
const kitFor = (u: UserWithTeam = user, s: SessionInfo | undefined = session(), at = NOW) => withUser(null, u, at, s);
const raw = (k: unknown) => JSON.stringify(k);

test('keeps only what the app needs to open: no email, employee ID, phone, pay plan or sign-in flags', () => {
  const kit = kitFor();
  assert.ok(kit);
  const text = raw(kit);
  for (const secret of ['jordan.lee@example.test', 'LM-0010', 'employeeId', '07700 900123', 'Field rep (commission)', 'payPlanId', 'twoFactorEnabled', 'hasPin', 'Manchester']) {
    assert.ok(!text.includes(secret), `${secret} is not kept`);
  }
  const back = kitUser(parseKit(text, NOW));
  assert.equal(back?.id, 10);
  assert.equal(back?.firstName, 'Jordan');
  assert.equal(back?.role, 'rep');
  assert.equal(back?.teamId, 2);
  assert.equal(back?.teamName, 'Northern Lights');
  assert.equal(back?.email, '', 'filled with an empty value, never the real one');
  assert.equal(back?.employeeId, '', 'the employee ID is half of the sign-in: never kept');
});

test('only reps and leaders (who log gauges and check in at events) get a kit', () => {
  assert.equal(keepsKit('rep'), true);
  assert.equal(keepsKit('leader'), true);
  for (const role of ['admin', 'recruiter', 'client'] as const) {
    assert.equal(keepsKit(role), false, role);
    assert.equal(kitFor({ ...user, role }), null, `${role}: no kit`);
  }
});

test('the phone opens offline only until the session would have ended: never after the sign-out time', () => {
  const text = raw(kitFor());
  assert.ok(parseKit(text, Date.parse('2026-10-27T22:59:00Z')), 'a minute before the 14 hours are up');
  assert.equal(parseKit(text, Date.parse('2026-10-27T23:00:00Z')), null, 'at the sign-out time');
  assert.equal(parseKit(text, Date.parse('2026-10-28T07:00:00Z')), null, 'the next morning (phone left in a locker)');
});

test('nor after the inactivity sign-out, counted from the last time the app reached the server', () => {
  const short = raw(kitFor(user, session({ idleHours: 2 })));
  assert.ok(parseKit(short, NOW + 2 * HOUR - 60_000));
  assert.equal(parseKit(short, NOW + 2 * HOUR), null, 'two hours with no contact: the server has signed them out too');
  // reaching the server again starts the inactivity time again, but never moves the 14-hour end
  const touched = touchKit(kitFor(user, session({ idleHours: 2 }))!, NOW + HOUR);
  assert.ok(parseKit(raw(touched), NOW + 2.5 * HOUR));
  assert.equal(parseKit(raw(touchKit(touched, Date.parse('2026-10-27T22:30:00Z'))), Date.parse('2026-10-27T23:00:00Z')), null);
});

test('a server that does not say its inactivity time: the default 12 hours applies', () => {
  const text = raw(kitFor(user, session({ idleHours: undefined, endsAt: '2026-10-28T11:30:00.000Z', maxHours: 24 })));
  assert.ok(parseKit(text, NOW + 12 * HOUR - 60_000));
  assert.equal(parseKit(text, NOW + 12 * HOUR), null);
});

test('a demo session (14 days, no limit) or no session details: a short window from the last contact', () => {
  // the demo's 14 days are not used; the shorter of KIT_NO_SESSION_HOURS and the inactivity time is
  for (const [s, hours] of [[session({ maxHours: null, endsAt: '2026-11-10T09:00:00.000Z', idleHours: 72 }), KIT_NO_SESSION_HOURS], [undefined, Math.min(KIT_NO_SESSION_HOURS, 12)]] as const) {
    const text = raw(withUser(null, user, NOW, s));
    assert.ok(parseKit(text, NOW + hours * HOUR - 60_000), 'within the window');
    assert.equal(parseKit(text, NOW + hours * HOUR), null, 'not 14 days');
  }
  assert.ok(KIT_NO_SESSION_HOURS <= 14);
});

test('a different person signing in on the phone replaces the kit, events and all', () => {
  const first = withEvents(kitFor()!, 10, [event(1, '2026-10-27')], NOW);
  const other = withUser(first, { ...user, id: 11, firstName: 'Sam' }, NOW, session());
  assert.equal(other?.user.id, 11);
  assert.deepEqual(other?.events, []);
});

test('events are kept for the same person only, newest first, at most KIT_MAX_EVENTS', () => {
  const kit = kitFor()!;
  const many = Array.from({ length: KIT_MAX_EVENTS + 15 }, (_, i) => event(i + 1, `2026-10-${String((i % 27) + 1).padStart(2, '0')}`));
  const filled = withEvents(kit, 10, many, NOW);
  assert.equal(filled.events.length, KIT_MAX_EVENTS);
  assert.ok(filled.events[0]!.date >= filled.events[filled.events.length - 1]!.date);
  assert.equal(withEvents(kit, 99, many, NOW), kit, 'another person’s events are ignored');
});

test('a broken, foreign or older-format kit is ignored', () => {
  const kit = raw(kitFor());
  assert.equal(parseKit('{not json', NOW), null);
  assert.equal(parseKit(JSON.stringify({ v: 2, user: { id: 'x' } }), NOW), null);
  assert.equal(parseKit(null, NOW), null);
  assert.equal(parseKit(JSON.stringify({ ...JSON.parse(kit), v: 99 }), NOW), null, 'another version');
  // the 1.5 test release kept a kit for 7 days with the employee ID in it: it is not used
  const v1 = { v: 1, savedAt: NOW, user: { id: 10, employeeId: 'LM-0010', firstName: 'Jordan', role: 'rep' }, events: [] };
  assert.equal(parseKit(JSON.stringify(v1), NOW), null);
  // an end time that is missing or not a number is no end time: not used
  assert.equal(parseKit(JSON.stringify({ ...JSON.parse(kit), endsAt: 'later' }), NOW), null);
  // a kit edited by hand to belong to an admin is not used
  assert.equal(parseKit(JSON.stringify({ ...JSON.parse(kit), user: { ...JSON.parse(kit).user, role: 'admin' } }), NOW), null);
});
