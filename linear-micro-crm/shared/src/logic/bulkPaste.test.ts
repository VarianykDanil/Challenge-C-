import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GaugeTotals } from '../types.ts';
import type { ParsedPasteLine, PasteMember } from '../types/bulk.ts';
import { normaliseName, parseBulkPaste, pasteFills, pasteFunnelIssues, resolvePaste } from './bulkPaste.ts';

const TEAM: PasteMember[] = [
  { userId: 10, firstName: 'Jordan', lastName: 'Lee' },
  { userId: 2, firstName: 'Amelia', lastName: 'Hart' },
  { userId: 12, firstName: 'Samuel', lastName: "O'Brien" },
  { userId: 13, firstName: 'Zoë', lastName: 'Patel' },
  { userId: 14, firstName: 'Theo', lastName: 'King' },
  { userId: 15, firstName: 'Mary-Jane', lastName: 'Watson' },
];
/** The same team with a second Jordan. */
const TWO_JORDANS: PasteMember[] = [...TEAM, { userId: 11, firstName: 'Jordan', lastName: 'Mills' }];

const G = (stops: number, table: number, presentations: number, closes: number, taps: number, sales: number): GaugeTotals => ({ stops, table, presentations, closes, taps, sales });
const J = G(65, 22, 11, 5, 3, 3);

function one(text: string, team: PasteMember[] = TEAM): ParsedPasteLine {
  const r = parseBulkPaste(text, team);
  assert.equal(r.lines.length, 1, `expected one row from ${JSON.stringify(text)}, got ${JSON.stringify(r.lines)}`);
  return r.lines[0]!;
}

test('the three formats from the spec', () => {
  const a = one('Jordan 65 22 11 5 3 3');
  assert.equal(a.userId, 10);
  assert.deepEqual(a.values, J);
  assert.deepEqual(a.issues, []);
  assert.equal(a.name, 'Jordan');
  assert.equal(a.nameFrom, 'line');
  assert.equal(a.line, 1);
  assert.equal(a.key, '1');

  const b = one('Jordan L - 65/22/11/5/3/3');
  assert.equal(b.userId, 10);
  assert.deepEqual(b.values, J);
  assert.equal(b.name, 'Jordan L');

  const c = one('amelia: 40 12 6 2 1 1');
  assert.equal(c.userId, 2);
  assert.deepEqual(c.values, G(40, 12, 6, 2, 1, 1));
  assert.equal(c.name, 'amelia');
});

test('separators: commas, dashes, dots, colons, pipes and mixed spacing', () => {
  for (const text of ['Jordan 65,22,11,5,3,3', 'Jordan 65-22-11-5-3-3', 'Jordan 65.22.11.5.3.3', 'Jordan 65:22:11:5:3:3', 'Jordan | 65 | 22 | 11 | 5 | 3 | 3', '  Jordan:65 22  11\t5 3 3  ', 'JORDAN — 65 / 22 / 11 / 5 / 3 / 3']) {
    const l = one(text);
    assert.equal(l.userId, 10, text);
    assert.deepEqual(l.values, J, text);
    assert.equal(l.checkIn, null, text);
  }
});

test('emojis, WhatsApp formatting, keycaps and invisible marks', () => {
  assert.deepEqual(one('🔥 *Jordan* 65 22 11 5 3 3 💪🏽✅').values, J);
  assert.equal(one('🔥 *Jordan* 65 22 11 5 3 3 💪🏽✅').userId, 10);
  assert.deepEqual(one('_Amelia_ 4️⃣0️⃣ 12 6 2 1 1').values, G(40, 12, 6, 2, 1, 1));
  assert.equal(one('‎Jordan 65 22 11 5 3 3‏').userId, 10);
  assert.equal(one('🇬🇧 Theo 44 15 7 3 2 1 👏👏').userId, 14);
});

test('extra words around the name and after the numbers', () => {
  const a = one('Gauges for Jordan today: 65 22 11 5 3 3 great shift!!');
  assert.equal(a.userId, 10);
  assert.equal(a.name, 'Jordan');
  assert.deepEqual(a.values, J);
  const b = one('65 22 11 5 3 3 Jordan');
  assert.equal(b.userId, 10);
  assert.deepEqual(b.values, J);
});

test('accents, apostrophes and hyphens in names', () => {
  assert.equal(one('Zoe 30 10 5 2 1 1').userId, 13);
  assert.equal(one('ZOË 30 10 5 2 1 1').userId, 13);
  assert.equal(one("Sam O'Brien 30 10 5 2 1 1").userId, 12);
  assert.equal(one('Samuel OBrien 30 10 5 2 1 1').userId, 12);
  assert.equal(one('Mary Jane 30 10 5 2 1 1').userId, 15);
  assert.equal(one('mary-jane 30 10 5 2 1 1').userId, 15);
  assert.equal(normaliseName("Zoë O'Brien-Smith"), 'zoeobriensmith');
});

test('surname only, initial, full name', () => {
  assert.equal(one('Hart 40 12 6 2 1 1').userId, 2);
  assert.equal(one('Amelia Hart 40 12 6 2 1 1').userId, 2);
  assert.equal(one('A Hart 40 12 6 2 1 1').userId, 2);
});

test('near misses are matched but flagged as a guess', () => {
  const typo = one('Jordon 65 22 11 5 3 3');
  assert.equal(typo.userId, 10);
  assert.equal(typo.guess, true);
  const swap = one('Aemlia 40 12 6 2 1 1');
  assert.equal(swap.userId, 2);
  assert.equal(swap.guess, true);
  const short = one('Sam 33 11 6 3 2 2');
  assert.equal(short.userId, 12);
  assert.equal(short.guess, true);
  assert.equal(one('Jordan 65 22 11 5 3 3').guess, false);
  // filler words never fuzzy-match a person ("the" is not Theo)
  const filler = one('the 65 22 11 5 3 3');
  assert.equal(filler.userId, null);
  assert.equal(filler.nameFrom, null);
  assert.match(filler.issues[0]!, /No name on this line/);
});

test('ambiguous names list every candidate; an initial or surname settles it', () => {
  const amb = one('Jordan 65 22 11 5 3 3', TWO_JORDANS);
  assert.deepEqual([...amb.matches].sort((a, b) => a - b), [10, 11]);
  assert.equal(amb.userId, null);
  assert.equal(amb.issues[0], '2 people match “Jordan” — choose one');
  assert.deepEqual(amb.values, J, 'the numbers are still read');
  assert.equal(one('Jordan L 65 22 11 5 3 3', TWO_JORDANS).userId, 10);
  assert.equal(one('Jordan M. 65 22 11 5 3 3', TWO_JORDANS).userId, 11);
  assert.equal(one('Jordan Mills 65 22 11 5 3 3', TWO_JORDANS).userId, 11);
  assert.equal(one('Jordon M 65 22 11 5 3 3', TWO_JORDANS).userId, 11);
});

test('unknown names are flagged, never guessed', () => {
  const l = one('Priya 40 12 6 2 1 1');
  assert.deepEqual(l.matches, []);
  assert.equal(l.userId, null);
  assert.equal(l.issues[0], 'No one called “Priya” on this team — choose who it is');
  assert.deepEqual(l.values, G(40, 12, 6, 2, 1, 1));
});

test('wrong number of numbers', () => {
  assert.deepEqual(one('Jordan 65 22 11 5 3').issues, ['Found 5 numbers, need 6']);
  assert.equal(one('Jordan 65 22 11 5 3').values, null);
  assert.deepEqual(one('Jordan 65 22 11 5 3 3 2').issues, ['Found 7 numbers, need 6']);
  assert.deepEqual(one('Jordan 65 22 11').issues, ['Found 3 numbers, need 6']);
});

test('funnel problems are explained in plain words, and the numbers are kept', () => {
  const l = one('Theo 10 22 11 5 3 3');
  assert.deepEqual(l.values, G(10, 22, 11, 5, 3, 3));
  assert.deepEqual(l.issues, ['To table (22) is more than stops (10)']);
  assert.deepEqual(pasteFunnelIssues(G(5, 4, 3, 2, 2, 3)), ['Sales (3) is more than taps (2)']);
  assert.deepEqual(pasteFunnelIssues(G(2500, 0, 0, 0, 0, 0)), ['Stops (2500) is over the 2,000 a day limit']);
  assert.deepEqual(pasteFunnelIssues(J), []);
});

test('chatter is ignored and counted: no numbers, one or two numbers, emojis only, timestamps only', () => {
  const r = parseBulkPaste(['Well done team!!', 'Great day 12 sales in total 🎉', '🔥🔥🔥', '20/10/2026', '17:42', 'See you at 9:30 tomorrow', '', '   '].join('\n'), TEAM);
  assert.equal(r.lines.length, 0);
  assert.equal(r.ignored, 6, 'blank lines are not counted');
});

test('dates, money, ordinals and percentages are not gauges', () => {
  const l = one('20/10 Jordan 65 22 11 5 3 3 (2nd day, £10 bonus, 14% conv)');
  assert.deepEqual(l.values, J);
  assert.deepEqual(l.issues, []);
  assert.deepEqual(one('2026-10-20 Jordan 65 22 11 5 3 3').values, J);
  assert.deepEqual(one('Jordan 20.10.26: 65 22 11 5 3 3').values, J);
  // a run of six numbers is never a date even when it starts like one
  assert.deepEqual(one('Jordan 12/10/5/3/1/1').values, G(12, 10, 5, 3, 1, 1));
});

test('a check-in time is taken out before the numbers are counted', () => {
  assert.equal(one('amelia: 40 12 6 2 1 1 in 9:58').checkIn, '09:58');
  assert.deepEqual(one('amelia: 40 12 6 2 1 1 in 9:58').values, G(40, 12, 6, 2, 1, 1));
  assert.equal(one('Jordan (in @ 10:02am) 65 22 11 5 3 3').checkIn, '10:02');
  assert.equal(one('Jordan 65 22 11 5 3 3 ci 9.55am').checkIn, '09:55');
  assert.equal(one('Jordan 65 22 11 5 3 3 in at 10am').checkIn, '10:00');
  assert.equal(one('Jordan 65 22 11 5 3 3 started 12:30pm').checkIn, '12:30');
  assert.equal(one('Jordan 65 22 11 5 3 3 in 12:05am').checkIn, '00:05');
  // a time without am/pm before 7:00 is the afternoon
  assert.equal(one('Jordan 65 22 11 5 3 3 in 1:05').checkIn, '13:05');
  assert.equal(one('Jordan 65 22 11 5 3 3 in 13:05').checkIn, '13:05');
  // "9.55" without am/pm is not a time; an impossible time is not one either
  assert.equal(one('Jordan 65 22 11 5 3 3').checkIn, null);
  assert.deepEqual(one('Jordan 65 22 11 5 3 3 25:99').issues, ['Found 8 numbers, need 6']);
});

test('WhatsApp exports: iOS, Android and desktop prefixes; the sender names a line without a name', () => {
  const text = [
    '[20/10/2026, 17:42:13] Amelia Hart: Gauges for today 🔥',
    'Jordan L - 65/22/11/5/3/3',
    'amelia 40 12 6 2 1 1',
    '[20/10/2026, 17:45:01] Theo King: 44 15 7 3 2 1',
    '20/10/2026, 17:50 - Samuel O’Brien: Today 33 11 6 3 2 2 checked in 10:02am',
    '[17:52, 20/10/2026] ~ Zoë Patel: 30/10/5/2/1/1',
    '20/10/2026, 5:58 pm - +44 7700 900123: 12 4 2 1 1 1',
    '[20/10/2026, 18:01:00] Messages and calls are end-to-end encrypted.',
  ].join('\n');
  const r = parseBulkPaste(text, TEAM);
  const by = (line: number) => r.lines.find((l) => l.line === line)!;
  assert.equal(r.lines.length, 6);
  assert.equal(by(2).userId, 10, 'a name on the line beats the sender');
  assert.equal(by(3).userId, 2);
  assert.equal(by(4).userId, 14);
  assert.equal(by(4).nameFrom, 'sender');
  assert.equal(by(4).name, 'Theo King');
  assert.deepEqual(by(4).values, G(44, 15, 7, 3, 2, 1), 'the timestamp is not a gauge');
  assert.equal(by(5).userId, 12);
  assert.equal(by(5).checkIn, '10:02');
  assert.equal(by(6).userId, 13);
  assert.deepEqual(by(6).values, G(30, 10, 5, 2, 1, 1));
  // a phone-number sender is no name
  assert.equal(by(7).userId, null);
  assert.deepEqual(by(7).values, G(12, 4, 2, 1, 1, 1));
  assert.equal(r.ignored, 2, 'the "Gauges for today" line and the system message');
});

test('a message spanning lines keeps its sender; a name that matches nobody is never swapped for the sender', () => {
  const r = parseBulkPaste(['[20/10/2026, 17:45] Jordan Lee: today', '65 22 11 5 3 3', 'Jrdn 40 12 6 2 1 1'].join('\n'), TEAM);
  assert.equal(r.lines[0]!.userId, 10);
  assert.equal(r.lines[0]!.nameFrom, 'sender');
  assert.equal(r.lines[1]!.userId, null, '"Jrdn" is a name nobody has, so the person chooses');
  assert.equal(r.lines[1]!.name, 'Jrdn');
});

test('two people on one line split at the second name', () => {
  const r = parseBulkPaste('Jordan 65 22 11 5 3 3, Amelia 40 12 6 2 1 1 & Theo: 44/15/7/3/2/1', TEAM);
  assert.deepEqual(r.lines.map((l) => [l.key, l.userId]), [['1.1', 10], ['1.2', 2], ['1.3', 14]]);
  assert.deepEqual(r.lines[1]!.values, G(40, 12, 6, 2, 1, 1));
  assert.ok(r.lines.every((l) => l.line === 1));
});

test('gauge words: number first or word first, in any order, with filler', () => {
  const a = one('Jordan - 65 stops, 22 to table, 11 pres, 5 closes, 3 taps, 3 sales');
  assert.deepEqual(a.values, J);
  const b = one('Jordan: stops 65 table 22 presentations 11 closes 5 taps 3 sales 3');
  assert.deepEqual(b.values, J);
  const c = one('Jordan sales 3 taps 3 closes 5 pres 11 table 22 stops 65');
  assert.deepEqual(c.values, J);
  const d = one('Jordan 65stops 22tables 11pres 5cls 3taps 3sales');
  assert.deepEqual(d.values, J);
  const e = one('Jordan 65 stops 22 table 11 pres 5 closes 3 sales');
  assert.equal(e.values, null);
  assert.deepEqual(e.issues, ['Missing taps']);
  // gauge words in chat after six plain numbers do not get in the way
  assert.deepEqual(one('Jordan 65 22 11 5 3 3 great sales, closed lots at the table').values, J);
});

test('the last complete line for a person wins; earlier ones are marked replaced', () => {
  const r = parseBulkPaste(['Jordan 50 20 10 4 2 2', 'Amelia 40 12 6 2 1 1', 'Jordan 65 22 11 5 3 3', 'Jordan 65 22 11'].join('\n'), TEAM);
  assert.equal(r.lines[0]!.replacedBy, '3');
  assert.equal(r.lines[2]!.replacedBy, null);
  assert.equal(r.lines[3]!.replacedBy, null, 'an incomplete line replaces nothing');
  const fills = pasteFills(r.lines);
  assert.deepEqual(fills.map((f) => [f.userId, f.line]), [[2, 2], [10, 3]]);
  assert.deepEqual(fills[1]!.values, J);
});

test('resolvePaste applies choices for ambiguous and unknown names and recomputes replacements', () => {
  const r = parseBulkPaste(['Jordan 65 22 11 5 3 3', 'Priya 40 12 6 2 1 1', 'Jordan L 50 20 10 4 2 2'].join('\n'), TWO_JORDANS);
  assert.equal(r.lines[0]!.userId, null);
  // a choice outside an ambiguous line's matches is refused; an unknown name may be anyone on the team
  const refused = resolvePaste(r.lines, { '1': 2 }, TWO_JORDANS);
  assert.equal(refused[0]!.userId, null);
  const chosen = resolvePaste(r.lines, { '1': 10, '2': 13 }, TWO_JORDANS);
  assert.equal(chosen[0]!.userId, 10);
  assert.equal(chosen[0]!.replacedBy, '3', 'line 3 is Jordan Lee as well');
  assert.equal(chosen[1]!.userId, 13);
  assert.deepEqual(pasteFills(chosen).map((f) => [f.userId, f.key]), [[13, '2'], [10, '3']]);
  // someone not on the team is never accepted; null goes back to the parser's own match
  assert.equal(resolvePaste(r.lines, { '2': 999 }, TWO_JORDANS)[1]!.userId, null);
  assert.equal(resolvePaste(chosen, { '1': null, '2': null }, TWO_JORDANS)[0]!.userId, null);
  // the input is never mutated
  assert.equal(r.lines[0]!.userId, null);
});

test('deterministic and pure: the same text gives the same rows', () => {
  const text = '[20/10/2026, 17:42] Amelia Hart: Jordan 65 22 11 5 3 3\nZoe 30 10 5 2 1 1 in 9:58';
  assert.deepEqual(parseBulkPaste(text, TEAM), parseBulkPaste(text, TEAM));
  assert.deepEqual(parseBulkPaste('', TEAM), { lines: [], ignored: 0 });
  assert.deepEqual(parseBulkPaste('Jordan 65 22 11 5 3 3', []).lines[0]!.matches, []);
});

test('Windows line endings and a long chat export stay fast', () => {
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) lines.push(i % 3 === 0 ? `[20/10/2026, 17:${String(i % 60).padStart(2, '0')}] Amelia Hart: chat ${i}` : `Jordan ${60 + (i % 5)} 22 11 5 3 3`);
  const started = Date.now();
  const r = parseBulkPaste(lines.join('\r\n'), TWO_JORDANS);
  assert.ok(Date.now() - started < 1500, 'parses 2,000 lines in well under a second and a half');
  assert.equal(r.lines.length, 1333);
  assert.equal(r.ignored, 667);
});
