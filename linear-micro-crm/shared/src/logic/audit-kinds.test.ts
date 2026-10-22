// Release 1.3 — P9 audit-everything: the pure side of "every action is recorded" (kinds, filters, export wording).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_EVENT_KINDS, AUDIT_SIGN_IN_REASONS } from '../types/audit.ts';
import {
  AUDIT_ENTITIES,
  AUDIT_ENTITIES_R3,
  AUDIT_ENTITY_LABELS,
  AUDIT_EVENT_KIND_LABELS,
  AUDIT_EVENT_KIND_LABELS_ONE,
  AUDIT_EXPORT_FORMAT_LABELS,
  AUDIT_FILTER_ENTITIES,
  AUDIT_SIGN_IN_ACTIONS,
  AUDIT_SIGN_IN_PAGE_ACTIONS,
  AUDIT_SIGN_IN_REASON_LABELS,
  auditExportSummary,
  auditFacts,
  auditFieldLabel,
  isAuditAttemptOnAccount,
  isAuditFailedAttempt,
  auditKindOf,
  auditWhatLabel,
  isAuditEventKind,
  parseAuditKinds,
} from './audit.ts';

test('auditKindOf: the rules in order — automatic, export, opened, sign-in, client portal, change', () => {
  assert.equal(auditKindOf('SYSTEM statements.apply'), 'automatic');
  assert.equal(auditKindOf('SYSTEM invoices.deem', 'admin'), 'automatic', 'a system step is automatic whoever is named');
  assert.equal(auditKindOf('EVENT export', 'rep'), 'export');
  assert.equal(auditKindOf('GET /finance/payroll/export', 'admin'), 'export', 'the Xero / Sage payroll CSV');
  assert.equal(auditKindOf('EVENT opened', 'leader'), 'opened');
  for (const a of AUDIT_SIGN_IN_ACTIONS) {
    assert.equal(auditKindOf(a, 'rep'), 'sign_in');
    assert.equal(auditKindOf(a, 'client'), 'sign_in', "a client's sign-in is a sign-in");
  }
  assert.equal(auditKindOf('POST /auth/pin', 'client'), 'client', 'anything else a client account does');
  assert.equal(auditKindOf('POST /client/posts', null), 'client');
  assert.equal(auditKindOf('POST /client', null), 'client');
  assert.equal(auditKindOf('POST /client-posts/:id/approve', 'admin'), 'change', 'the office deciding a client post is an office change');
  assert.equal(auditKindOf('PATCH /client-accounts/:id', 'admin'), 'change');
  assert.equal(auditKindOf('POST /auth/pin', 'rep'), 'change');
  assert.equal(auditKindOf('npm run pin:reset'), 'change');
  assert.equal(auditKindOf('POST /gauges'), 'change');
});

test('kinds: six, each with a label for the filter and for one row; parseAuditKinds keeps the given order once', () => {
  assert.deepEqual([...AUDIT_EVENT_KINDS], ['change', 'sign_in', 'export', 'opened', 'automatic', 'client']);
  for (const k of AUDIT_EVENT_KINDS) {
    assert.ok(isAuditEventKind(k));
    assert.ok(AUDIT_EVENT_KIND_LABELS[k] && AUDIT_EVENT_KIND_LABELS_ONE[k]);
  }
  assert.equal(AUDIT_EVENT_KIND_LABELS.sign_in, 'Sign-ins');
  assert.ok(!isAuditEventKind('changes'));
  assert.ok(!isAuditEventKind(undefined));
  assert.deepEqual(parseAuditKinds('opened,change,opened'), ['opened', 'change']);
  assert.deepEqual(parseAuditKinds(' sign_in '), ['sign_in']);
  assert.equal(parseAuditKinds(''), undefined);
  assert.deepEqual(parseAuditKinds('change,'), ['change'], 'an empty part is ignored');
  assert.equal(parseAuditKinds('Change'), null, 'kinds are lower case');
});

test('the Record filter lists the 1.2 entities then the 1.3 ones; AUDIT_ENTITIES itself is unchanged', () => {
  assert.equal(AUDIT_ENTITIES.length, 12);
  assert.deepEqual(AUDIT_FILTER_ENTITIES, [...AUDIT_ENTITIES, ...AUDIT_ENTITIES_R3]);
  for (const e of AUDIT_FILTER_ENTITIES) assert.ok(AUDIT_ENTITY_LABELS[e]);
});

test('export wording: hand-written examples', () => {
  assert.equal(auditWhatLabel('gauges-by-team'), 'Gauges by team');
  assert.equal(auditWhatLabel('leaderboard'), 'Leaderboard');
  assert.equal(auditWhatLabel('linear-hub-payroll-2026-10-05.csv'), 'Linear hub payroll');
  assert.equal(auditWhatLabel('weekly_money_flow-2026-10-01-to-2026-10-21'), 'Weekly money flow');
  assert.equal(auditWhatLabel(''), 'a table');
  assert.equal(auditExportSummary({ what: 'gauges-by-team', format: 'csv', rows: 124 }), 'Exported Gauges by team as CSV: 124 rows');
  assert.equal(auditExportSummary({ what: 'gauges-by-team', format: 'pdf', rows: 0 }), 'Exported Gauges by team as PDF: 0 rows');
  assert.equal(auditExportSummary({ what: 'payroll', format: 'xero', rows: 1 }), 'Exported Payroll as Xero CSV: 1 row');
  assert.equal(auditExportSummary({ what: 'invoice', format: 'print' }), 'Printed Invoice');
  assert.equal(auditExportSummary({ what: 'candidates', rows: 12_345 }), 'Exported Candidates: 12,345 rows');
  assert.equal(AUDIT_EXPORT_FORMAT_LABELS.sage, 'Sage CSV');
});

test('the snapshot fields of exports, opened records and failed sign-ins have plain labels', () => {
  assert.equal(auditFieldLabel('rows'), 'Rows');
  assert.equal(auditFieldLabel('filename'), 'File');
  assert.equal(auditFieldLabel('attemptsLeft'), 'Tries left');
  assert.equal(auditFieldLabel('typedEmail'), 'Email typed');
});

// Review fix: a failed attempt's details read as facts, with its reason in words, not as "Reason — → wrong pin".
test('a failed attempt, an export and an opened record: their details as facts, the reason and format in words', () => {
  assert.deepEqual(auditFacts({ reason: 'wrong_pin', attemptsLeft: 6 }), [
    { field: 'reason', label: 'Reason', text: 'Wrong PIN' },
    { field: 'attemptsLeft', label: 'Tries left', text: '6' },
  ]);
  assert.deepEqual(auditFacts({ reason: 'unknown_email', typedEmail: null }), [{ field: 'reason', label: 'Reason', text: 'No account has this email' }]);
  assert.deepEqual(auditFacts({ what: 'candidate profile', format: 'pdf', rows: null, filename: 'candidate-mia-parker.pdf', record: 'Mia Parker' }).map((f) => `${f.label}: ${f.text}`), [
    'What: candidate profile', 'Format: PDF', 'File: candidate-mia-parker.pdf', 'Record: Mia Parker',
  ]);
  assert.equal(auditFacts({ format: 'print' })[0]!.text, 'Print');
  assert.equal(auditFacts({ format: 'xero', rows: 1234 }).map((f) => f.text).join(' · '), 'Xero CSV · 1,234');
  assert.equal(auditFacts({ reason: 'something_new' })[0]!.text, 'something new', 'an unknown reason is still readable');
  assert.deepEqual(auditFacts(null), []);
  assert.deepEqual(auditFacts([1, 2]), []);
});

test('every reason the server writes has words; none is a raw code', () => {
  for (const r of AUDIT_SIGN_IN_REASONS) {
    const label = AUDIT_SIGN_IN_REASON_LABELS[r];
    assert.ok(label && !label.includes('_') && label[0] === label[0]!.toUpperCase(), r);
  }
  assert.deepEqual(Object.keys(AUDIT_SIGN_IN_REASON_LABELS).sort(), [...AUDIT_SIGN_IN_REASONS].sort());
});

test('a failed attempt on the sign-in page is an attempt on the account; a wrong PIN in Settings is the person\'s own', () => {
  const failed = { kind: 'sign_in' as const, after: { reason: 'wrong_employee_id' } };
  assert.ok(isAuditFailedAttempt(failed));
  for (const action of AUDIT_SIGN_IN_PAGE_ACTIONS) assert.ok(isAuditAttemptOnAccount({ ...failed, action }), action);
  assert.ok(!isAuditAttemptOnAccount({ kind: 'sign_in', action: 'POST /auth/pin', after: { reason: 'wrong_current_pin' } }));
  assert.ok(!isAuditAttemptOnAccount({ kind: 'sign_in', action: 'POST /auth/login', after: null }), 'a sign-in');
  assert.ok(!isAuditAttemptOnAccount({ kind: 'sign_in', action: 'POST /auth/login', after: { note: 'x' } }), 'the pause row has no reason');
  assert.ok(!isAuditFailedAttempt({ kind: 'change', after: { reason: 'wrong_pin' } }));
});
