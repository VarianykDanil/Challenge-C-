// Which Finance tab opens first (pages/financeTabs.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financeTabs, openingFinanceTab } from './financeTabs.ts';

test('each role sees its own tabs', () => {
  assert.deepEqual(financeTabs('rep', 2).map((t) => t.value), ['me']);
  assert.deepEqual(financeTabs('leader', 2).map((t) => t.value), ['me', 'team']);
  assert.deepEqual(financeTabs('leader', null).map((t) => t.value), ['me']);
  assert.deepEqual(financeTabs('recruiter', null).map((t) => t.value), ['me']);
  assert.deepEqual(financeTabs('admin', null).map((t) => t.value), ['me', 'company']);
});

test('the owner and office open on Company, everyone else on My pay', () => {
  assert.equal(openingFinanceTab('admin', null, { tab: null, hash: '' }), 'company');
  assert.equal(openingFinanceTab('rep', 2, { tab: null, hash: '' }), 'me');
  assert.equal(openingFinanceTab('leader', 2, { tab: null, hash: '' }), 'me');
  assert.equal(openingFinanceTab('recruiter', null, { tab: null, hash: '' }), 'me');
});

test('a link still picks the tab it names, when this person has it', () => {
  assert.equal(openingFinanceTab('admin', null, { tab: 'me', hash: '' }), 'me');
  assert.equal(openingFinanceTab('admin', null, { tab: null, hash: '#runs' }), 'company');
  assert.equal(openingFinanceTab('leader', 2, { tab: 'team', hash: '' }), 'team');
  assert.equal(openingFinanceTab('rep', 2, { tab: 'company', hash: '' }), 'me', 'not theirs: their default');
  // a payslip link (from "Check and accept your invoice") is always My pay
  assert.equal(openingFinanceTab('admin', null, { tab: 'me', hash: '', run: '12' }), 'me');
});
