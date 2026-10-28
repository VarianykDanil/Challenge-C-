// How DataTable lays a row out as a card on a phone (tableLayout.ts). Run by `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_BREAKPOINT_PX, PHONE_CARD_LIMIT, cardLayout, cardsShown, sortChoices, type Column } from './tableLayout.ts';

interface Run { week: string; name: string; gross: number; due: string; status: string }
const col = (key: string, o: Partial<Column<Run>> = {}): Column<Run> => ({ key, header: key[0]!.toUpperCase() + key.slice(1), render: () => key, ...o });
const keys = (cs: Column<Run>[]) => cs.map((c) => c.key);

test('by default the first column is the card title and every other column is a labelled field', () => {
  const l = cardLayout([col('week'), col('days'), col('gross'), col('due'), col('status')]);
  assert.deepEqual(keys(l.title), ['week']);
  assert.deepEqual(keys(l.fields), ['days', 'gross', 'due', 'status']);
  assert.deepEqual(keys(l.aside), []);
});

test('the key columns (who, amount, status) can be placed where a phone shows them first', () => {
  const l = cardLayout([col('week', { card: 'field' }), col('name', { card: 'title' }), col('gross', { card: 'aside' }), col('due'), col('status', { card: 'wide' })]);
  assert.deepEqual(keys(l.title), ['name']);
  assert.deepEqual(keys(l.aside), ['gross']);
  assert.deepEqual(keys(l.fields), ['week', 'due']);
  assert.deepEqual(keys(l.wide), ['status']);
});

test('a selection box leads the card, row buttons go to the bottom, and hidden columns are left out', () => {
  const l = cardLayout([col('select'), col('week'), col('note', { card: 'hidden' }), col('actions', { header: '' })]);
  assert.deepEqual(keys(l.lead), ['select']);
  assert.deepEqual(keys(l.title), ['week'], 'the title is the first column after the selection box');
  assert.deepEqual(keys(l.actions), ['actions']);
  assert.ok(!keys([...l.fields, ...l.wide, ...l.aside]).includes('note'));
});

test('columns hidden on narrow screens in the table still show in the card (there is room going down)', () => {
  const l = cardLayout([col('name'), col('status', { hideBelow: 'md' })]);
  assert.deepEqual(keys(l.fields), ['status']);
});

test('every column appears once', () => {
  const cols = [col('select'), col('week'), col('name', { card: 'title' }), col('gross', { card: 'aside' }), col('due'), col('status', { card: 'wide' }), col('actions')];
  const l = cardLayout(cols);
  const all = [...l.lead, ...l.title, ...l.aside, ...l.fields, ...l.wide, ...l.actions].map((c) => c.key).sort();
  assert.deepEqual(all, cols.map((c) => c.key).sort());
});

test('sorting on a phone: one choice per sortable column and direction, labelled in words', () => {
  const choices = sortChoices([col('week', { sortValue: (r) => r.week }), col('gross', { sortValue: (r) => r.gross, cardLabel: 'Gross pay' }), col('status')]);
  assert.deepEqual(choices.map((c) => c.value), ['week:asc', 'week:desc', 'gross:asc', 'gross:desc']);
  assert.equal(choices[2]!.label, 'Gross pay (lowest first)');
  assert.equal(choices[3]!.label, 'Gross pay (highest first)');
  assert.equal(choices[0]!.label, 'Week (lowest first)');
});

test('cards are used below 640 px, the width of most phones held upright', () => {
  assert.equal(CARD_BREAKPOINT_PX, 640);
});

test('a long list shows the first cards and a "Show all" button on a phone, so the page stays short', () => {
  assert.equal(PHONE_CARD_LIMIT, 10);
  assert.deepEqual(cardsShown({ total: 48, limit: PHONE_CARD_LIMIT, expanded: false, selectedIndex: -1, selectable: false }), { shown: 10, hidden: 38 });
  assert.deepEqual(cardsShown({ total: 48, limit: PHONE_CARD_LIMIT, expanded: true, selectedIndex: -1, selectable: false }), { shown: 48, hidden: 0 });
  // a short list, or one with a couple over the limit, is shown whole (a "Show 1 more" button is not worth a tap)
  assert.deepEqual(cardsShown({ total: 7, limit: 10, expanded: false, selectedIndex: -1, selectable: false }), { shown: 7, hidden: 0 });
  assert.deepEqual(cardsShown({ total: 12, limit: 10, expanded: false, selectedIndex: -1, selectable: false }), { shown: 12, hidden: 0 });
  // the open row is never hidden
  assert.deepEqual(cardsShown({ total: 48, limit: 10, expanded: false, selectedIndex: 30, selectable: false }), { shown: 31, hidden: 17 });
  // a list with a select-all box shows everything: nothing out of sight can be ticked
  assert.deepEqual(cardsShown({ total: 48, limit: 10, expanded: false, selectedIndex: -1, selectable: true }), { shown: 48, hidden: 0 });
  // no limit
  assert.deepEqual(cardsShown({ total: 48, limit: null, expanded: false, selectedIndex: -1, selectable: false }), { shown: 48, hidden: 0 });
});
