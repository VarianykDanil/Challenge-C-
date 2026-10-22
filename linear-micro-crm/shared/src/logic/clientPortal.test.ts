/**
 * Release 1.3 — P6 client-portal: the pure rules of client posts and client accounts, with hand-written fixtures.
 * Business date in every case: Wed 21 Oct 2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientPostInput } from '../types/client.ts';
import {
  CLIENT_POST_BODY_MAX,
  CLIENT_POST_KIND_LABELS,
  CLIENT_POST_STATUS_LABELS,
  CLIENT_POST_TITLE_MAX,
  CLIENT_RATE_MAX,
  clientCommissionSummary,
  clientCommissionTitle,
  clientInviteInstructions,
  clientPostDayLabel,
  clientPostMoney,
  clientPostProblems,
  clientPostPublishes,
  clientPostOfficeStatusText,
  clientPostStatusText,
  formatClientAccessCode,
  isClientAccessCode,
  isClientPostDate,
} from './clientPortal.ts';

const TODAY = '2026-10-21';
const fields = (input: Partial<ClientPostInput>) => clientPostProblems(input, TODAY).map((p) => p.field);

test('labels: every kind and status has a label; only updates and announcements publish straight away', () => {
  assert.deepEqual(CLIENT_POST_KIND_LABELS, { update: 'Update', announcement: 'Announcement', commission: 'Commission change' });
  assert.equal(CLIENT_POST_STATUS_LABELS.pending, 'Waiting for Linear');
  assert.equal(clientPostPublishes('update'), true);
  assert.equal(clientPostPublishes('announcement'), true);
  assert.equal(clientPostPublishes('commission'), false);
});

test('access codes: CL-0001 for 1, never negative; well-formed codes only', () => {
  assert.equal(formatClientAccessCode(1), 'CL-0001');
  assert.equal(formatClientAccessCode(42), 'CL-0042');
  assert.equal(formatClientAccessCode(12345), 'CL-12345');
  assert.equal(formatClientAccessCode(-3), 'CL-0000');
  assert.equal(isClientAccessCode('CL-0002'), true);
  assert.equal(isClientAccessCode('cl-0002'), true);
  for (const bad of ['LM-0002', 'CL-12', 'CL0002', '', null, 2]) assert.equal(isClientAccessCode(bad), false, String(bad));
});

test('dates and money in the portal’s words', () => {
  assert.equal(clientPostDayLabel('2026-11-02'), 'Mon 2 Nov');
  assert.equal(clientPostDayLabel('2026-10-25'), 'Sun 25 Oct', 'the clock change weekend keeps its day');
  assert.equal(clientPostDayLabel('2027-01-01'), 'Fri 1 Jan');
  assert.equal(clientPostDayLabel('not a date'), 'not a date');
  assert.equal(clientPostDayLabel(null), '');
  assert.equal(isClientPostDate('2026-02-29'), false, 'no 29 Feb in 2026');
  assert.equal(isClientPostDate('2028-02-29'), true);
  assert.equal(clientPostMoney(22), '£22.00');
  assert.equal(clientPostMoney(12.5), '£12.50');
  assert.equal(clientPostMoney(1000), '£1,000.00');
});

test('commission summary and default title', () => {
  assert.equal(clientCommissionSummary({ rateRep: 22, ratePayout: null, effectiveFrom: '2026-11-02' }), '£22.00 per sub to the fundraiser, from Mon 2 Nov');
  assert.equal(
    clientCommissionSummary({ rateRep: 15, ratePayout: 125, effectiveFrom: '2026-11-02' }),
    '£15.00 per sub to the fundraiser and £125.00 per sub to Linear, from Mon 2 Nov',
  );
  assert.equal(clientCommissionSummary({ rateRep: null, ratePayout: 100, effectiveFrom: null }), '£100.00 per sub to Linear');
  assert.equal(clientCommissionSummary({ rateRep: null, ratePayout: null, effectiveFrom: '2026-11-02' }), '');
  assert.equal(clientCommissionTitle('2026-11-02'), 'Commission change from Mon 2 Nov');
  assert.equal(clientCommissionTitle(null), 'Commission change');
});

test('status words: approved with its date, declined with its reason', () => {
  assert.equal(clientPostStatusText({ status: 'published', effectiveFrom: null, decisionNote: null }), 'Published');
  assert.equal(clientPostStatusText({ status: 'pending', effectiveFrom: '2026-11-02', decisionNote: null }), 'Waiting for Linear');
  assert.equal(clientPostStatusText({ status: 'approved', effectiveFrom: '2026-11-02', decisionNote: null }), 'Approved from Mon 2 Nov');
  assert.equal(clientPostStatusText({ status: 'approved', effectiveFrom: null, decisionNote: null }), 'Approved');
  assert.equal(
    clientPostStatusText({ status: 'declined', effectiveFrom: '2026-11-30', decisionNote: ' We agreed £120 until March. ' }),
    'Declined: We agreed £120 until March.',
  );
  assert.equal(clientPostStatusText({ status: 'declined', effectiveFrom: null, decisionNote: '' }), 'Declined');
  assert.equal(clientPostStatusText({ status: 'unpublished', effectiveFrom: null, decisionNote: 'Duplicate' }), 'Unpublished');
});

test('office status words: "Waiting for approval" for Linear’s own staff, the rest as the client reads them', () => {
  assert.equal(clientPostOfficeStatusText({ status: 'pending', effectiveFrom: '2026-11-02', decisionNote: null }), 'Waiting for approval');
  assert.equal(clientPostOfficeStatusText({ status: 'approved', effectiveFrom: '2026-11-02', decisionNote: 'On the phone' }), 'Approved from Mon 2 Nov');
  assert.equal(clientPostOfficeStatusText({ status: 'published', effectiveFrom: null, decisionNote: null }), 'Published');
  assert.equal(clientPostOfficeStatusText({ status: 'unpublished', effectiveFrom: null, decisionNote: 'Duplicate' }), 'Unpublished');
});

test('updates and announcements need a title and a message, within the limits', () => {
  assert.deepEqual(fields({ kind: 'update', title: 'New leaflets', body: 'They arrive on Monday.' }), []);
  assert.deepEqual(fields({ kind: 'announcement', title: '  ', body: '' }), ['title', 'body']);
  assert.deepEqual(fields({ kind: 'update', title: 'x'.repeat(CLIENT_POST_TITLE_MAX), body: 'y'.repeat(CLIENT_POST_BODY_MAX) }), [], 'exactly at the limits');
  assert.deepEqual(fields({ kind: 'update', title: 'x'.repeat(CLIENT_POST_TITLE_MAX + 1), body: 'y'.repeat(CLIENT_POST_BODY_MAX + 1) }), ['title', 'body']);
  assert.deepEqual(fields({ title: 'No kind', body: 'b' }), ['kind']);
  assert.deepEqual(fields({ kind: 'other' as never, title: 't', body: 'b' }), ['kind']);
  // rates on an update are ignored, never a problem
  assert.deepEqual(fields({ kind: 'update', title: 't', body: 'b', rateRep: -5, effectiveFrom: 'nonsense' }), []);
});

test('a commission change needs a rate and a date from today up to a year ahead; title and message are optional', () => {
  const ok: Partial<ClientPostInput> = { kind: 'commission', title: '', body: '', rateRep: 22, effectiveFrom: '2026-11-02' };
  assert.deepEqual(fields(ok), []);
  assert.deepEqual(fields({ ...ok, rateRep: null, ratePayout: 120 }), [], 'the payout alone');
  assert.deepEqual(fields({ ...ok, ratePayout: 125 }), [], 'both rates');
  assert.deepEqual(fields({ ...ok, effectiveFrom: TODAY }), [], 'today is the earliest');
  assert.deepEqual(fields({ ...ok, effectiveFrom: '2027-10-22' }), [], '366 days ahead (2027-10-22) is the latest');
  assert.deepEqual(fields({ ...ok, effectiveFrom: '2027-10-23' }), ['effectiveFrom'], '367 days ahead');
  assert.deepEqual(fields({ ...ok, effectiveFrom: '2026-10-20' }), ['effectiveFrom'], 'yesterday');
  assert.deepEqual(fields({ ...ok, effectiveFrom: '2026-13-01' }), ['effectiveFrom']);
  assert.deepEqual(fields({ ...ok, effectiveFrom: null }), ['effectiveFrom']);
  assert.deepEqual(fields({ ...ok, rateRep: null, ratePayout: null }), ['rateRep'], 'no rate at all');
  assert.deepEqual(fields({ ...ok, rateRep: 0 }), ['rateRep'], '£0 is not a rate');
  assert.deepEqual(fields({ ...ok, rateRep: -1 }), ['rateRep']);
  assert.deepEqual(fields({ ...ok, rateRep: 12.345 }), ['rateRep'], 'pounds and pence only');
  assert.deepEqual(fields({ ...ok, rateRep: 12.35 }), []);
  assert.deepEqual(fields({ ...ok, rateRep: CLIENT_RATE_MAX }), []);
  assert.deepEqual(fields({ ...ok, rateRep: CLIENT_RATE_MAX + 0.01 }), ['rateRep']);
  assert.deepEqual(fields({ ...ok, ratePayout: Number.NaN }), ['ratePayout']);
  assert.deepEqual(fields({ ...ok, title: 'x'.repeat(CLIENT_POST_TITLE_MAX + 1) }), ['title'], 'an optional title still has a limit');
  const msg = clientPostProblems({ ...ok, effectiveFrom: '2026-10-01' }, TODAY)[0]!.message;
  assert.match(msg, /today or a later date/);
});

test('invite instructions: the email, the access code, the PIN rule and the sign-in page', () => {
  const text = clientInviteInstructions({
    firstName: 'Jo', email: 'jo.bloggs@charity.example', accessCode: 'CL-0002', campaignName: 'Breast Cancer Now', signInUrl: 'https://hub.example/login',
  });
  assert.match(text, /^Hello Jo,/);
  assert.match(text, /post updates for Breast Cancer Now/);
  assert.match(text, /1\. Open https:\/\/hub\.example\/login\./);
  assert.match(text, /your email \(jo\.bloggs@charity\.example\) and your access code: CL-0002\./);
  assert.match(text, /create a PIN of 4 to 6 digits/);
  const noUrl = clientInviteInstructions({ firstName: ' ', email: 'a@b.example', accessCode: 'CL-0003', campaignName: 'CHN' });
  assert.match(noUrl, /^Hello there,/);
  assert.match(noUrl, /1\. Open the Linear Hub sign-in page\./);
});
