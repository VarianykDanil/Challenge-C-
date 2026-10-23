// Release 1.4 — package S (security): the 14-hour absolute session, as pure rules (shared by the server and the
// sign-in page). Sessions run on the real clock, so these take plain milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_MAX_HOURS_DEFAULT, SESSION_MAX_HOURS_MAX, SESSION_MAX_HOURS_MIN } from '../types/pin.ts';
import { isSessionMaxHoursValid, isSessionPastMaxAge, sessionEndsAtMs, sessionMaxAgeMessage } from './pin.ts';

const HOUR = 3_600_000;
const MIN = 60_000;

test('the session limit: 14 hours by default, whole hours from 4 to 24', () => {
  assert.equal(SESSION_MAX_HOURS_DEFAULT, 14);
  assert.equal(SESSION_MAX_HOURS_MIN, 4);
  assert.equal(SESSION_MAX_HOURS_MAX, 24);
  for (const ok of [4, 8, 14, 23, 24]) assert.equal(isSessionMaxHoursValid(ok), true, String(ok));
  for (const bad of [0, 3, 25, 4.5, -14, Number.NaN, '14', null, undefined, Infinity]) assert.equal(isSessionMaxHoursValid(bad), false, String(bad));
});

test('a session ends 14 hours after sign-in: alive a minute before, ended at the hour and a minute after', () => {
  const signedIn = Date.parse('2026-10-23T07:00:00.000Z');
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 14 * HOUR - MIN, 14), false, '13:59 after sign-in');
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 14 * HOUR, 14), true, 'exactly 14:00 (the cookie ends then too)');
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 14 * HOUR + MIN, 14), true, '14:01 after sign-in');
  assert.equal(isSessionPastMaxAge(signedIn, signedIn, 14), false, 'just signed in');
});

test('the limit follows the admin’s setting', () => {
  const signedIn = Date.parse('2026-10-23T07:00:00.000Z');
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 9 * HOUR, 8), true);
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 9 * HOUR, 10), false);
  assert.equal(isSessionPastMaxAge(signedIn, signedIn + 23 * HOUR, 24), false);
});

test('an unreadable sign-in time counts as ended (never as alive for ever)', () => {
  assert.equal(isSessionPastMaxAge(Number.NaN, Date.now(), 14), true);
});

test('sessionEndsAtMs: sign-in plus the limit', () => {
  const signedIn = Date.parse('2026-10-23T07:00:00.000Z');
  assert.equal(new Date(sessionEndsAtMs(signedIn, 14)).toISOString(), '2026-10-23T21:00:00.000Z');
});

test('the sign-in page’s sentence names the hours', () => {
  assert.equal(sessionMaxAgeMessage(14), 'For security you are signed out 14 hours after signing in. Sign in again to carry on.');
  assert.equal(sessionMaxAgeMessage(8), 'For security you are signed out 8 hours after signing in. Sign in again to carry on.');
});
