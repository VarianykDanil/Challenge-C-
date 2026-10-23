/**
 * What the server prints at start-up about payroll runs. Bringing unpaid runs up to date (late gauges, a corrected
 * statement, or storing the breakdown of a week calculated before 1.3) is not always "recomputed from late gauges", so
 * the line says what it did without guessing why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payrollRunsLogLine } from '../db/maintenance.ts';

test('the payroll start-up line says "brought up to date", and nothing when nothing changed', () => {
  assert.equal(payrollRunsLogLine({ created: 0, updated: 29, deleted: 0 }), 'Payroll runs: 0 created, 29 brought up to date, 0 removed');
  assert.equal(payrollRunsLogLine({ created: 3, updated: 1, deleted: 2 }), 'Payroll runs: 3 created, 1 brought up to date, 2 removed');
  assert.equal(payrollRunsLogLine({ created: 0, updated: 0, deleted: 0 }), null);
  assert.ok(!/late gauges/.test(payrollRunsLogLine({ created: 0, updated: 5, deleted: 0 })!));
});
