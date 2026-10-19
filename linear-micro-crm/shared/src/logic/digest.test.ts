import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DigestBullet } from '../types.ts';
import {
  buildDigest,
  deltaPhrase,
  digestText,
  digestTitle,
  gbp,
  ordinal,
  plural,
  type AdminDigestFacts,
  type DigestBoardRow,
  type DigestFacts,
  type LeaderDigestFacts,
  type RecruiterDigestFacts,
  type RepDigestFacts,
} from './digest.ts';

const WEEK = { weekStart: '2026-10-12', weekEnd: '2026-10-18' };

function repFacts(over: Partial<RepDigestFacts> = {}): DigestFacts {
  return {
    ...WEEK,
    rep: {
      funnel: { current: { stops: 620, sales: 11 }, previous: { stops: 580, sales: 9 }, conversionChange: 0.142 },
      board: {
        teamName: 'Team North',
        meId: 10,
        rows: [
          { userId: 11, userName: 'Sam Patel', rank: 1, movement: 0, sales: 15 },
          { userId: 10, userName: 'Jordan Lee', rank: 2, movement: 1, sales: 11 },
          { userId: 12, userName: 'Ali Khan', rank: 3, movement: -1, sales: 8 },
        ],
      },
      bonus: { threshold: 12, amount: 75, sales: 11, reached: false },
      tip: 'Your table-to-presentation rate is 40% vs the 50% benchmark. Get the clipboard out sooner.',
      pay: { gross: 735, payday: '2026-10-23', status: 'pending', paidDate: null },
      ...over,
    },
  };
}

function leaderFacts(over: Partial<LeaderDigestFacts> = {}): DigestFacts {
  const board: DigestBoardRow[] = [
    { userId: 11, userName: 'Sam Patel', rank: 1, movement: 0, sales: 15 },
    { userId: 10, userName: 'Jordan Lee', rank: 2, movement: 3, sales: 11 },
    { userId: 12, userName: 'Ali Khan', rank: 3, movement: -2, sales: 8 },
    { userId: 13, userName: 'New Starter', rank: 4, movement: null, sales: 4 },
  ];
  return {
    ...WEEK,
    leader: {
      teamName: 'Team North',
      funnel: { current: { stops: 2540, sales: 54 }, previous: { stops: 2500, sales: 48 }, conversionChange: 0.1 },
      board,
      late: { late: 3, recorded: 41 },
      nextWeek: { weekStart: '2026-10-19', upcoming: 6, forecasted: 6, expectedSales: 78.4, targetSales: 90, completed: 0, completedSales: 0, completedTarget: 0 },
      checkIns: { count: 2, userIds: [99, 98] },
      ...over,
    },
  };
}

function adminFacts(over: Partial<AdminDigestFacts> = {}): DigestFacts {
  return {
    ...WEEK,
    admin: {
      companyName: 'Linear MCR',
      funnel: { current: { stops: 9000, sales: 412 }, previous: { stops: 8800, sales: 389 }, conversionChange: 0.03 },
      revenue: { current: 49_440, previous: 46_680 },
      campaigns: [
        { name: 'Age UK', current: 52, previous: 38 },
        { name: 'Oxfam', current: 31, previous: 40 },
        { name: 'Shelter', current: 20, previous: 20 },
      ],
      recruitment: { applied: 18, hired: 3 },
      payroll: { payday: '2026-10-23', runs: 28, gross: 12_340.5, unpaidRuns: 28, unpaidGross: 12_340.5, failedRuns: 2, failedGross: 840 },
      ...over,
    },
  };
}

function recruiterFacts(over: Partial<RecruiterDigestFacts> = {}): DigestFacts {
  return {
    ...WEEK,
    recruiter: {
      applied: { current: 18, previous: 14 },
      interviews: { current: 11, previous: 13 },
      hired: { current: 3, previous: 3 },
      overdueActions: 4,
      outcomesToRecord: 2,
      openPipeline: 42,
      ...over,
    },
  };
}

const texts = (bs: DigestBullet[]) => bs.map((b) => b.text);

test('plural: 1 sale vs 2 sales, irregular plurals, thousands', () => {
  assert.equal(plural(1, 'sale'), '1 sale');
  assert.equal(plural(2, 'sale'), '2 sales');
  assert.equal(plural(0, 'sale'), '0 sales');
  assert.equal(plural(1, 'person', 'people'), '1 person');
  assert.equal(plural(3, 'person', 'people'), '3 people');
  assert.equal(plural(1240, 'stop'), '1,240 stops');
});

test('gbp: en-GB pounds, pence only when there are pence', () => {
  assert.equal(gbp(1050), '£1,050');
  assert.equal(gbp(412.5), '£412.50');
  assert.equal(gbp(0), '£0');
  assert.equal(gbp(-0), '£0');
  assert.equal(gbp(Number.NaN), '£0');
});

test('deltaPhrase: up, down, same; previous 0 or null → no comparison yet; never NaN', () => {
  assert.equal(deltaPhrase(12, 9), 'up 3 on the week before');
  assert.equal(deltaPhrase(7, 9), 'down 2 on the week before');
  assert.equal(deltaPhrase(9, 9), 'the same as the week before');
  assert.equal(deltaPhrase(9, 0), 'no comparison yet');
  assert.equal(deltaPhrase(0, 0), 'no comparison yet');
  assert.equal(deltaPhrase(9, null), 'no comparison yet');
  assert.equal(deltaPhrase(9, undefined), 'no comparison yet');
  assert.equal(deltaPhrase(Number.NaN, 4), 'no comparison yet');
  assert.equal(deltaPhrase(4, Number.NaN), 'no comparison yet');
  assert.equal(deltaPhrase(49_440, 46_680, gbp), 'up £2,760 on the week before');
  assert.equal(deltaPhrase(100.25, 100.5, gbp), 'down £0.25 on the week before');
  for (const [a, b] of [[1, 0], [0, null], [Infinity, 2], [3, -Infinity]] as const) assert.ok(!deltaPhrase(a, b).includes('NaN'));
});

test('ordinal and title', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  assert.equal(digestTitle('2026-10-12'), 'Your week in review · w/c 12 Oct');
});

test('rep: a normal week gives 5–8 bullets, pay last and private, the rest shareable', () => {
  const bs = buildDigest('rep', repFacts());
  assert.ok(bs.length >= 5 && bs.length <= 8, `${bs.length} bullets`);
  assert.deepEqual(texts(bs), [
    'You made 11 sales — up 2 on the week before.',
    '620 stops (up 40 on the week before) at 1.8% conversion — up from 1.6% the week before.',
    'You finished 2nd of 3 on Team North — up 1 place on the week before.',
    'You finished one sale short of the £75 bonus.',
    'Tip: Your table-to-presentation rate is 40% vs the 50% benchmark. Get the clipboard out sooner.',
    'Your pay for the week: £735 gross, due Fri 23 Oct.',
  ]);
  assert.deepEqual(bs.map((b) => b.private), [false, false, false, false, false, true]);
});

test('rep: bonus reached, several short, no bonus plan', () => {
  const reached = texts(buildDigest('rep', repFacts({ bonus: { threshold: 12, amount: 75, sales: 14, reached: true } })));
  assert.ok(reached.includes('You reached the £75 bonus — 14 sales against the 12 needed.'));
  const short = texts(buildDigest('rep', repFacts({ bonus: { threshold: 12, amount: 75, sales: 8, reached: false } })));
  assert.ok(short.includes('You finished 4 sales short of the £75 bonus (12 needed).'));
  const none = buildDigest('rep', repFacts({ bonus: null }));
  assert.ok(!texts(none).some((t) => t.includes('bonus')));
  assert.ok(none.length >= 5);
});

test('rep: conversion holding while sales fell → one lever (volume)', () => {
  const t = texts(buildDigest('rep', repFacts({ funnel: { current: { stops: 430, sales: 10 }, previous: { stops: 600, sales: 14 }, conversionChange: 0 } })));
  assert.equal(t[1], '430 stops (down 170 on the week before) at 2.3% conversion — the same as the week before. Your conversion is holding, so the volume is the lever: about 43 stops make a sale.');
});

test('rep: no comparison yet when the week before is empty or missing, never NaN', () => {
  const t = texts(buildDigest('rep', repFacts({ funnel: { current: { stops: 300, sales: 6 }, previous: { stops: 0, sales: 0 }, conversionChange: null } })));
  assert.equal(t[0], 'You made 6 sales — no comparison yet.');
  assert.equal(t[1], '300 stops (no comparison yet) at 2.0% conversion — no comparison yet.');
  const t2 = texts(buildDigest('rep', repFacts({ funnel: { current: { stops: 300, sales: 6 }, previous: null, conversionChange: null } })));
  assert.ok(t2.every((s) => !s.includes('NaN') && !s.includes('undefined')));
});

test('rep: a week off still reads kindly and gives 5 bullets', () => {
  const bs = buildDigest('rep', repFacts({
    funnel: { current: { stops: 0, sales: 0 }, previous: { stops: 500, sales: 9 }, conversionChange: null },
    board: { teamName: 'Team North', meId: 10, rows: [{ userId: 11, userName: 'Sam Patel', rank: 1, movement: null, sales: 15 }] },
    tip: 'Log your stops, tables, presentations, closes, taps and sales after each shift and your coaching will appear here.',
    pay: null,
  }));
  assert.ok(bs.length >= 5 && bs.length <= 8);
  assert.deepEqual(texts(bs).slice(0, 3), [
    'No gauges logged this week — 0 sales.',
    'The week before: 9 sales from 500 stops.',
    'You are not on the Team North board this week — it starts with your first logged day.',
  ]);
  assert.ok(!texts(bs).some((t) => t.includes('bonus')), 'no bonus line for a week off');
  assert.equal(bs.at(-1)!.text, 'No pay for w/c 12 Oct.');
});

test('rep: joint rank, new entrant, and pay states', () => {
  const joint = repFacts();
  joint.rep!.board!.rows = [
    { userId: 11, userName: 'Sam Patel', rank: 1, movement: null, sales: 11 },
    { userId: 10, userName: 'Jordan Lee', rank: 1, movement: null, sales: 11 },
  ];
  assert.ok(texts(buildDigest('rep', joint)).includes('You finished joint 1st of 2 on Team North — not ranked the week before.'));
  const paid = buildDigest('rep', repFacts({ pay: { gross: 612.4, payday: '2026-10-23', status: 'paid', paidDate: '2026-10-23' } }));
  assert.equal(paid.at(-1)!.text, 'Your pay for the week: £612.40 gross, paid Fri 23 Oct.');
  const est = buildDigest('rep', repFacts({ pay: { gross: 500, payday: '2026-10-23', status: 'estimate', paidDate: null } }));
  assert.match(est.at(-1)!.text, /^Your pay for the week: about £500 gross \(an estimate/);
});

test('private bullets are excluded from text; text is title + "• " lines, no markdown or HTML', () => {
  const bullets = buildDigest('rep', repFacts());
  const title = digestTitle(WEEK.weekStart);
  const text = digestText({ title, bullets });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Your week in review · w/c 12 Oct');
  assert.equal(lines.length, 1 + bullets.filter((b) => !b.private).length);
  assert.ok(lines.slice(1).every((l) => l.startsWith('• ')));
  assert.ok(!text.includes('£735'), 'pay never in shareable text');
  assert.ok(!text.includes('Your pay'));
  for (const ch of ['<', '*', '#']) assert.ok(!text.includes(ch), `no "${ch}"`);
  assert.equal(digestText({ title, bullets: [{ text: 'secret', private: true }] }), '', 'nothing shareable → empty text');
});

test('names and campaign names that look like markup are stripped', () => {
  const f = leaderFacts();
  f.leader!.teamName = '<b>Team</b> *North* #1';
  f.leader!.board[0]!.userName = '<script>Sam</script> *Patel*';
  const bullets = buildDigest('leader', f);
  const text = digestText({ title: digestTitle(WEEK.weekStart), bullets });
  for (const ch of ['<', '>', '*', '#', '_', '`']) assert.ok(!text.includes(ch), `no "${ch}" in ${text}`);
  assert.ok(text.includes('Top seller: scriptSam/script Patel with 15 sales.'));
  const a = adminFacts({ campaigns: [{ name: '**Age_UK**', current: 10, previous: 2 }] });
  assert.ok(texts(buildDigest('admin', a)).includes('Biggest rise: AgeUK, up 8 sales to 10.'));
});

test('leader: team lines, top seller, movers (new entrants ignored), late count, next week, private check-in count', () => {
  const bs = buildDigest('leader', leaderFacts());
  assert.ok(bs.length >= 5 && bs.length <= 8);
  assert.deepEqual(texts(bs), [
    'Team North made 54 sales — up 6 on the week before.',
    'Team conversion 2.1% from 2,540 stops — up from 1.9% the week before.',
    'Top seller: Sam Patel with 15 sales.',
    'Biggest move up: Jordan Lee, 3 places to 2nd; biggest move down: Ali Khan, 2 places to 3rd.',
    '3 of 41 recorded check-ins were late (more than 5 minutes after the start).',
    'Next week (w/c 19 Oct): 6 events, expect about 78 sales (estimate 64–93) against targets of 90.',
    '2 people on your check-in list — the dashboard shows who.',
  ]);
  assert.deepEqual(bs.map((b) => b.private), [false, false, false, false, false, false, true]);
});

test('leader: anyone on the check-in list is never named in shareable text', () => {
  const f = leaderFacts({ checkIns: { count: 2, userIds: [11, 12] } });
  const bs = buildDigest('leader', f);
  const text = digestText({ title: digestTitle(WEEK.weekStart), bullets: bs });
  assert.ok(!text.includes('Sam Patel'), 'top seller on the list → line left out');
  assert.ok(!text.includes('Ali Khan'), 'mover down on the list → that half left out');
  assert.ok(text.includes('Biggest move up: Jordan Lee, 3 places to 2nd.'));
  assert.ok(bs.length >= 5);
  // the count line is private and carries no names
  const priv = bs.filter((b) => b.private);
  assert.deepEqual(texts(priv), ['2 people on your check-in list — the dashboard shows who.']);
});

test('leader: next week variants', () => {
  const nw = (n: Partial<NonNullable<LeaderDigestFacts['nextWeek']>>) =>
    texts(buildDigest('leader', leaderFacts({ nextWeek: { weekStart: '2026-10-19', upcoming: 0, forecasted: 0, expectedSales: 0, targetSales: 0, completed: 0, completedSales: 0, completedTarget: 0, ...n } })));
  assert.ok(nw({}).includes('Next week (w/c 19 Oct): no events booked yet.'));
  assert.ok(nw({ upcoming: 3, targetSales: 36 }).includes('Next week (w/c 19 Oct): 3 events with targets of 36 sales.'));
  assert.ok(nw({ upcoming: 4, forecasted: 3, expectedSales: 30, targetSales: 36, completed: 2, completedSales: 20, completedTarget: 24 })
    .includes('Next week (w/c 19 Oct): 4 events still to come; the 3 with a forecast expect about 30 sales (estimate 21–39) against targets of 36.'));
  assert.ok(nw({ completed: 5, completedSales: 61, completedTarget: 60 }).includes('The week after (w/c 19 Oct): 5 events made 61 sales against targets of 60.'));
});

test('leader: late check-ins wording', () => {
  assert.ok(texts(buildDigest('leader', leaderFacts({ late: { late: 0, recorded: 12 } }))).includes('All 12 recorded check-ins were on time.'));
  assert.ok(texts(buildDigest('leader', leaderFacts({ late: { late: 1, recorded: 12 } }))).includes('1 of 12 recorded check-ins was late (more than 5 minutes after the start).'));
  assert.ok(texts(buildDigest('leader', leaderFacts({ late: { late: 0, recorded: 0 } }))).includes('No check-in times were recorded this week.'));
});

test('admin: company sales and revenue, biggest campaign rise and fall, recruitment, private payroll', () => {
  const bs = buildDigest('admin', adminFacts());
  assert.ok(bs.length >= 5 && bs.length <= 8);
  assert.deepEqual(texts(bs), [
    'Linear MCR made 412 sales — up 23 on the week before.',
    'Revenue £49,440 — up £2,760 on the week before.',
    'Biggest rise: Age UK, up 14 sales to 52.',
    'Biggest fall: Oxfam, down 9 sales to 31.',
    'Recruitment: 3 hires and 18 applications.',
    'Payroll due Fri 23 Oct: £12,340.50 across 28 runs.',
    '2 failed transfers to send again, £840 in all.',
  ]);
  assert.deepEqual(bs.map((b) => b.private), [false, false, false, false, false, true, true]);
  const text = digestText({ title: digestTitle(WEEK.weekStart), bullets: bs });
  assert.ok(!text.includes('Payroll') && !text.includes('£12,340'), 'payroll is private');
});

test('admin: flat campaigns, paid payroll, no runs', () => {
  const flat = texts(buildDigest('admin', adminFacts({ campaigns: [{ name: 'Shelter', current: 5, previous: 5 }] })));
  assert.ok(flat.includes('Every campaign sold the same as the week before.'));
  const paid = buildDigest('admin', adminFacts({ payroll: { payday: '2026-10-23', runs: 3, gross: 1800, unpaidRuns: 0, unpaidGross: 0, failedRuns: 0, failedGross: 0 } }));
  assert.equal(paid.at(-1)!.text, 'Payroll for w/c 12 Oct: £1,800 across 3 runs, all paid.');
  const some = buildDigest('admin', adminFacts({ payroll: { payday: '2026-10-23', runs: 3, gross: 1800, unpaidRuns: 1, unpaidGross: 600, failedRuns: 0, failedGross: 0 } }));
  assert.equal(some.at(-1)!.text, 'Payroll due Fri 23 Oct: £600 across 1 run (2 already paid).');
  const late = buildDigest('admin', adminFacts({ payroll: { payday: '2026-10-23', runs: 3, gross: 1800, unpaidRuns: 1, unpaidGross: 600, failedRuns: 0, failedGross: 0, paydayPassed: true } }));
  assert.equal(late.at(-1)!.text, 'Payroll for w/c 12 Oct: £600 across 1 run still to pay (due Fri 23 Oct; 2 already paid).');
  const none = buildDigest('admin', adminFacts({ payroll: { payday: '2026-10-23', runs: 0, gross: 0, unpaidRuns: 0, unpaidGross: 0, failedRuns: 0, failedGross: 0 } }));
  assert.equal(none.at(-1)!.text, 'No payroll runs for w/c 12 Oct yet.');
});

test('recruiter: applications, interviews, hires, overdue and outcomes; no gauge lines, nothing private', () => {
  const bs = buildDigest('recruiter', recruiterFacts());
  assert.deepEqual(texts(bs), [
    '18 applications — up 4 on the week before.',
    '11 interviews — down 2 on the week before.',
    '3 hires — the same as the week before.',
    '4 open candidates are past their next action — clearing the oldest first keeps them warm.',
    '2 interview outcomes to record now.',
    '42 candidates in the open pipeline.',
  ]);
  assert.ok(bs.every((b) => !b.private));
  assert.ok(!texts(bs).some((t) => /\b(stops?|sales?|conversion)\b/i.test(t)));
  const quiet = texts(buildDigest('recruiter', recruiterFacts({ overdueActions: 0, outcomesToRecord: 0, applied: { current: 1, previous: 0 } })));
  assert.ok(quiet.includes('1 application — no comparison yet.'));
  assert.ok(quiet.includes('No open candidate is past their next action — every one has a next step in date.'));
  assert.ok(texts(buildDigest('recruiter', recruiterFacts({ overdueActions: 1 }))).includes('1 open candidate is past their next action — clearing the oldest first keeps them warm.'));
  assert.ok(quiet.includes('No interview outcomes are waiting to be recorded.'));
});

test('missing facts for the role → no bullets; deterministic output', () => {
  assert.deepEqual(buildDigest('rep', { ...WEEK }), []);
  assert.deepEqual(buildDigest('admin', repFacts()), []);
  assert.deepEqual(buildDigest('leader', leaderFacts()), buildDigest('leader', leaderFacts()));
});

test('copy style: no judgemental words about people in any role', () => {
  const all = [...buildDigest('rep', repFacts()), ...buildDigest('leader', leaderFacts()), ...buildDigest('admin', adminFacts()), ...buildDigest('recruiter', recruiterFacts())];
  for (const b of all) assert.ok(!/at risk|underperform|failing|struggling|\bpoor\b/i.test(b.text), b.text);
});
