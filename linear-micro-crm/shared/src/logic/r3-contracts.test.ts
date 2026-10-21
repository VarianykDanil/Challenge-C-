/**
 * Release 1.3 foundation (r3-foundation): the shared contracts other packages rely on — the client role helpers, the
 * venue key, the invoice number and deemed-accepted moment, the pay rule's paid-as decision, client access codes and a
 * candidate's age. Owners test the rest of their modules in their own files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, STAFF_ROLES, isStaffRole } from '../types.ts';
import { POSITIONS } from '../types.ts';
import { POSITION_LABELS, ROLE_LABELS } from '../constants.ts';
import { venueKey, venueSlug, isVenueKey } from './venues.ts';
import { deemedAcceptedAt, formatInvoiceNumber } from './invoices.ts';
import { paidAsFor } from './payRule.ts';
import { formatClientAccessCode } from './clientPortal.ts';
import { ageOn, isUnderAge } from './recruitmentPlus.ts';
import { isVideoComplete } from './videos.ts';
import { pdfOrientationFor } from './exportFormat.ts';
import { normalisePersonName } from './statements.ts';

test('roles: four staff roles plus client; the staff forms never offer client', () => {
  assert.deepEqual([...STAFF_ROLES], ['admin', 'leader', 'recruiter', 'rep']);
  assert.deepEqual([...ROLES], ['admin', 'leader', 'recruiter', 'rep', 'client']);
  assert.equal(isStaffRole('rep'), true);
  assert.equal(isStaffRole('client'), false);
  assert.equal(isStaffRole(undefined), false);
  assert.equal(ROLE_LABELS.client, 'Client');
  assert.equal(POSITION_LABELS.client, 'Client');
  assert.ok(!POSITIONS.includes('client'), 'client is not a career position');
});

test('venueKey: one key per place however it was typed', () => {
  assert.equal(venueKey('Golden Square', 'Manchester'), 'golden-square--manchester');
  assert.equal(venueKey('  golden   SQUARE ', 'manchester'), 'golden-square--manchester');
  assert.equal(venueKey("St Peter's Square", 'Manchester'), 'st-peters-square--manchester');
  assert.equal(venueKey('M&S Market St.', 'Manchester'), 'm-and-s-market-st--manchester');
  assert.equal(venueSlug('Café Nero'), 'cafe-nero');
  assert.ok(isVenueKey(venueKey('Golden Square', 'Manchester')));
  assert.ok(!isVenueKey('golden square'));
  assert.ok(!isVenueKey('../etc'));
});

test('invoices: LM-SB-<year>-<6 digits>; deemed accepted at 12:00 the day before payday', () => {
  assert.equal(formatInvoiceNumber(2026, 123), 'LM-SB-2026-000123');
  assert.equal(deemedAcceptedAt('2026-10-23'), '2026-10-22T12:00:00');
  assert.equal(deemedAcceptedAt('2026-11-01'), '2026-10-31T12:00:00');
  assert.equal(deemedAcceptedAt('not a date'), null);
});

test('pay rule: commission at or above the base pays commission, below pays the base', () => {
  assert.equal(paidAsFor(254, 160), 'base');
  assert.equal(paidAsFor(317.5, 375), 'commission');
  assert.equal(paidAsFor(190.5, 190.5), 'commission', 'a tie pays commission');
  assert.equal(paidAsFor(0, 0), 'commission');
});

test('client access codes, candidate age, video watched rule, PDF orientation, name matching', () => {
  assert.equal(formatClientAccessCode(1), 'CL-0001');
  assert.equal(ageOn('2008-10-22', '2026-10-21'), 17);
  assert.equal(ageOn('2008-10-21', '2026-10-21'), 18);
  assert.equal(isUnderAge('2008-10-22', '2026-10-21'), true);
  assert.equal(ageOn('2030-01-01', '2026-10-21'), null);
  assert.equal(isVideoComplete(90, 100), true);
  assert.equal(isVideoComplete(89, 100), false);
  assert.equal(isVideoComplete(500, null), false);
  assert.equal(pdfOrientationFor(6), 'portrait');
  assert.equal(pdfOrientationFor(7), 'landscape');
  assert.equal(normalisePersonName("O'Brien,  Sam"), 'obrien sam');
});
