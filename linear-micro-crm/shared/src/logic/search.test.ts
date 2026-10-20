import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_KIND_LIMITS,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_TOKENS,
  escapeLike,
  eventSearchSubtitle,
  likeContains,
  likePrefix,
  matchesSearch,
  normaliseSearchQuery,
  searchDateLabel,
  searchKindsFor,
  searchRank,
  searchTokens,
} from './search.ts';

test('normaliseSearchQuery trims, collapses whitespace and caps the length; non-strings are empty', () => {
  assert.equal(normaliseSearchQuery('  Jordan   Lee \n'), 'Jordan Lee');
  assert.equal(normaliseSearchQuery('x'.repeat(100)).length, SEARCH_MAX_LENGTH);
  assert.equal(normaliseSearchQuery(undefined), '');
  assert.equal(normaliseSearchQuery(['a', 'b']), '');
  assert.equal(normaliseSearchQuery(42), '');
});

test('searchTokens: lower-case words, duplicates dropped, at most SEARCH_MAX_TOKENS', () => {
  assert.deepEqual(searchTokens('  BCN  Trafford bcn '), ['bcn', 'trafford']);
  assert.deepEqual(searchTokens(''), []);
  assert.deepEqual(searchTokens('   '), []);
  assert.equal(searchTokens('a b c d e f g h').length, SEARCH_MAX_TOKENS);
});

test('escapeLike / likeContains / likePrefix escape the LIKE wildcards and the escape character', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  assert.equal(likeContains('jo'), '%jo%');
  assert.equal(likeContains('5%'), '%5\\%%');
  assert.equal(likePrefix('a_b'), 'a\\_b%');
});

test('per-kind caps add up to the 20-result ceiling', () => {
  assert.equal(Object.values(SEARCH_KIND_LIMITS).reduce((a, b) => a + b, 0), SEARCH_MAX_RESULTS);
  assert.equal(SEARCH_MAX_RESULTS, 20);
});

test('searchKindsFor: reps never find candidates; every other role finds all four kinds', () => {
  assert.deepEqual(searchKindsFor('rep'), ['person', 'event', 'campaign']);
  for (const role of ['admin', 'leader', 'recruiter'] as const) assert.deepEqual(searchKindsFor(role), ['person', 'event', 'candidate', 'campaign']);
});

test('matchesSearch: every word must appear in one of the fields, in any order, case-insensitive', () => {
  assert.equal(matchesSearch('lee jordan', 'Jordan Lee'), true);
  assert.equal(matchesSearch('gau', 'Quick gauges'), true);
  assert.equal(matchesSearch('quick log', 'Quick gauges'), false);
  assert.equal(matchesSearch('new ev', 'New event', 'Schedule a day'), true);
  assert.equal(matchesSearch('', 'anything'), true, 'an empty query matches everything');
  assert.equal(matchesSearch('x', null, undefined), false);
});

test('matchesSearch never matches across the boundary of two fields', () => {
  assert.equal(matchesSearch('ab', 'xa', 'by'), false);
});

test('searchRank: whole-query prefix 0, word start 1, anything else 2', () => {
  assert.equal(searchRank('jor', 'Jordan Lee'), 0);
  assert.equal(searchRank('lee', 'Jordan Lee'), 1);
  assert.equal(searchRank('rdan', 'Jordan Lee'), 2);
  assert.equal(searchRank('  JOR ', 'jordan lee'), 0, 'normalised and case-insensitive');
  assert.equal(searchRank('', 'Jordan Lee'), 2);
  assert.equal(searchRank('smith', 'Anne-Smith'), 1, 'a hyphenated part counts as a word');
});

test('searchDateLabel: today, tomorrow and yesterday by name; the year only when it differs', () => {
  const today = '2026-10-20'; // a Tuesday
  assert.equal(searchDateLabel('2026-10-20', today), 'Today');
  assert.equal(searchDateLabel('2026-10-21', today), 'Tomorrow');
  assert.equal(searchDateLabel('2026-10-19', today), 'Yesterday');
  assert.equal(searchDateLabel('2026-10-23', today), 'Fri 23 Oct');
  assert.equal(searchDateLabel('2027-01-04', today), 'Mon 4 Jan 2027');
  assert.equal(searchDateLabel('2025-12-31', '2026-01-01'), 'Yesterday');
  assert.equal(searchDateLabel('2025-12-30', '2026-01-01'), 'Tue 30 Dec 2025');
  assert.equal(searchDateLabel('not-a-date', today), 'not-a-date');
});

test('eventSearchSubtitle: date, place and team; cancelled events say so; missing parts are skipped', () => {
  const today = '2026-10-20';
  assert.equal(
    eventSearchSubtitle({ date: '2026-10-21', venue: 'Arndale Centre', city: 'Manchester', teamName: 'North Crew', status: 'scheduled' }, today),
    'Tomorrow · Arndale Centre, Manchester · North Crew',
  );
  assert.equal(
    eventSearchSubtitle({ date: '2026-10-23', venue: 'Trafford Centre', city: '', teamName: null, status: 'cancelled' }, today),
    'Fri 23 Oct · Trafford Centre · Cancelled',
  );
  assert.equal(
    eventSearchSubtitle({ name: 'Breast Cancer Now — Arndale Centre', date: '2026-10-20', venue: 'Arndale Centre', city: 'Manchester', teamName: 'Ancoats', status: 'live' }, today),
    'Today · Manchester · Ancoats',
    'the venue is not repeated when the name already carries it',
  );
});
