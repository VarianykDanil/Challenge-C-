import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttentionItem, CandidateWithMeta, PayPlan, PayrollRunWithUser, Role, SalesEventWithMeta } from '../types.ts';
import {
  ATTENTION_MAX_ITEMS,
  attentionItems,
  attentionLookbackFrom,
  attentionOwnGapWindow,
  attentionPayrollWindow,
  attentionUsuallyAttends,
  eventBehindTarget,
  inRunsToPay,
  sortAttentionItems,
  type AttentionInput,
  type AttentionInterview,
  type AttentionNow,
} from './attention.ts';
import { outcomesToRecord } from './recruitment.ts';

// Thu 15 Oct 2026, 15:00 in London (BST, so 14:00Z). Fri 16 Oct is payday.
const NOW: AttentionNow = { today: '2026-10-15', nowHHMM: '15:00', nowISO: '2026-10-15T14:00:00.000Z' };
const TEAM_A = 1;
const TEAM_B = 2;

const PLAN: PayPlan = { id: 1, name: 'Field rep', position: 'field_rep', basePerDay: 60, commissionPerSale: 45, bonusThreshold: 12, bonusAmount: 75, overridePerTeamSale: 0 };

let seq = 100;
function ev(p: Partial<SalesEventWithMeta> & { date: string }): SalesEventWithMeta {
  const id = p.id ?? ++seq;
  return {
    id,
    campaignId: 1,
    teamId: TEAM_A,
    name: `Breast Cancer Now — Venue ${id}`,
    venue: `Venue ${id}`,
    city: 'Manchester',
    type: 'private_site',
    startTime: '09:00',
    endTime: '17:00',
    status: 'completed',
    targetSales: 10,
    notes: null,
    campaignName: 'Breast Cancer Now',
    campaignCode: 'BCN',
    campaignColor: '#DB2777',
    teamName: p.teamId === TEAM_B ? 'Team B' : 'Team A',
    teamColor: '#2563EB',
    totals: { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 },
    repCount: 0,
    ...p,
  };
}

type Entry = AttentionInput['entries'][number];
const row = (id: number, eventId: number, userId: number, date: string, stops = 40, sales = 2, table = 14): Entry => ({
  id, eventId, userId, date, stops, table, sales, submittedAt: `${date}T18:00:00.000Z`,
});

type Member = AttentionInput['members'][number];
const member = (id: number, firstName: string, teamId: number | null = TEAM_A, p: Partial<Member> = {}): Member => ({
  id, firstName, lastName: 'Test', role: 'rep', teamId, startDate: '2025-01-01', status: 'active', ...p,
});

function run(p: Partial<PayrollRunWithUser> & { id: number; userId: number }): PayrollRunWithUser {
  return {
    weekStart: '2026-10-05',
    weekEnd: '2026-10-11',
    daysWorked: 4,
    sales: 6,
    teamSales: 0,
    basePay: 240,
    commission: 172.5,
    bonus: 0,
    overrides: 0,
    deductions: 0,
    gross: 412.5,
    dueDate: '2026-10-16',
    paidDate: null,
    status: 'pending',
    reference: `PAY-202641-LM-${String(p.userId).padStart(4, '0')}`,
    adjustedAt: null,
    userName: 'Test Person',
    employeeId: `LM-${String(p.userId).padStart(4, '0')}`,
    position: 'field_rep',
    teamName: 'Team A',
    onTime: null,
    ...p,
  };
}

function input(role: Role, p: Partial<AttentionInput> & { meId?: number; teamId?: number | null; twoFactorEnabled?: boolean } = {}): AttentionInput {
  const meId = p.meId ?? 10;
  const teamId = p.teamId === undefined ? (role === 'admin' || role === 'recruiter' ? null : TEAM_A) : p.teamId;
  return {
    me: { id: meId, role, teamId, firstName: 'Me', twoFactorEnabled: p.twoFactorEnabled ?? true, startDate: '2025-01-01' },
    plan: p.plan === undefined ? PLAN : p.plan,
    events: p.events ?? [],
    entries: p.entries ?? [],
    members: p.members ?? [member(meId, 'Me', teamId, { role: role === 'leader' ? 'leader' : role })],
    runs: p.runs ?? [],
    candidates: p.candidates ?? [],
    interviews: p.interviews ?? [],
    attendance: p.attendance ?? null,
    pipelineOverdue: p.pipelineOverdue ?? null,
    checkedInToday: p.checkedInToday ?? null,
  };
}

const keys = (items: AttentionItem[]) => items.map((i) => i.key);
const byKey = (items: AttentionItem[], key: string) => items.find((i) => i.key === key);

// ───────────────────────────── rep / leader: own gauges ─────────────────────────────

test('rep: a completed team event yesterday with no row of mine → gauges:event (warning) with the pay-cost sentence', () => {
  const e = ev({ id: 42, date: '2026-10-14', venue: 'Trafford Centre' });
  const items = attentionItems(input('rep', { events: [e] }), NOW);
  const it = byKey(items, 'gauges:event:42:user:10');
  assert.ok(it, 'item present');
  assert.equal(it.severity, 'warning');
  assert.equal(it.kind, 'gauges');
  assert.equal(it.title, 'Log your gauges for BCN — Trafford Centre (Wed 14 Oct)');
  assert.equal(it.body, 'If you worked it: that day’s £60 base plus commission is not in Friday’s pay (23 Oct) until it is logged.');
  assert.equal(it.href, '/gauges?log=1&eventId=42');
});

test('rep: a row on that date (even at another event) → no item', () => {
  const e = ev({ id: 42, date: '2026-10-14' });
  const other = ev({ id: 43, date: '2026-10-14', teamId: TEAM_B });
  assert.deepEqual(keys(attentionItems(input('rep', { events: [e], entries: [row(1, 42, 10, '2026-10-14')] }), NOW)), []);
  assert.deepEqual(keys(attentionItems(input('rep', { events: [e, other], entries: [row(1, 43, 10, '2026-10-14')] }), NOW)), []);
});

test('rep: two team events on the same unlogged date → ONE item (the day pays one base), keyed on the first, naming the other', () => {
  const a = ev({ id: 44, date: '2026-10-14', venue: 'Trafford Centre', startTime: '09:00' });
  const b = ev({ id: 45, date: '2026-10-14', venue: 'MediaCity', campaignCode: 'Volt', startTime: '10:00' });
  for (const events of [[a, b], [b, a]]) {
    const items = attentionItems(input('rep', { events }), NOW);
    assert.deepEqual(keys(items), ['gauges:event:44:user:10'], 'one item, on the earlier event, whatever the input order');
    assert.equal(items[0]!.title, 'Log your gauges for BCN — Trafford Centre (Wed 14 Oct)');
    assert.equal(items[0]!.body, 'If you worked it or Volt — MediaCity: that day’s £60 base plus commission is not in Friday’s pay (23 Oct) until it is logged.');
  }
  const firm = attentionItems(input('rep', { events: [a, b], attendance: { teamDays: 10, workedDays: 9 } }), NOW);
  assert.equal(firm.length, 1);
  assert.equal(firm[0]!.body, 'Wednesday not logged yet: that day’s £60 base plus commission is missing from Friday’s pay (23 Oct). Log it before the week is paid. Your team also ran Volt — MediaCity that day.');
  assert.equal((firm[0]!.body.match(/£60/g) ?? []).length, 1, 'the day’s base is claimed once');
  // a row at either event clears the day
  assert.deepEqual(keys(attentionItems(input('rep', { events: [a, b], entries: [row(1, 45, 10, '2026-10-14')] }), NOW)), []);
  // three events: "it, A or B"
  const c = ev({ id: 46, date: '2026-10-14', venue: 'Asda Hulme', startTime: '11:00' });
  assert.match(attentionItems(input('rep', { events: [a, b, c] }), NOW)[0]!.body, /^If you worked it, Volt — MediaCity or BCN — Asda Hulme: /);
});

test('rep: a still-live event before its end time → no item; once its end has passed → item', () => {
  const live = ev({ id: 50, date: NOW.today, status: 'live', startTime: '09:00', endTime: '18:00' });
  assert.deepEqual(keys(attentionItems(input('rep', { events: [live] }), NOW)), []);
  const ended = ev({ id: 51, date: NOW.today, status: 'live', startTime: '08:00', endTime: '14:30' });
  const it = byKey(attentionItems(input('rep', { events: [ended] }), NOW), 'gauges:event:51:user:10');
  assert.ok(it);
  assert.match(it.body, /^If you worked it/);
});

test('rep: this pay week only (Monday … today), own team, not cancelled, not before my start date, not a week already paid', () => {
  // Thursday 15 Oct: Monday 12 Oct (today − 3) is still this pay week → asked for; Sunday 11 Oct is last week → never
  const monday12 = ev({ id: 59, date: '2026-10-12' });
  const sunday11 = ev({ id: 60, date: '2026-10-11' });
  const otherTeam = ev({ id: 61, date: '2026-10-14', teamId: TEAM_B });
  const cancelled = ev({ id: 62, date: '2026-10-14', status: 'cancelled' });
  assert.deepEqual(keys(attentionItems(input('rep', { events: [sunday11, otherTeam, cancelled] }), NOW)), []);
  const mon = byKey(attentionItems(input('rep', { events: [monday12, sunday11] }), NOW), 'gauges:event:59:user:10')!;
  assert.ok(mon, 'Monday of this week is in the window');
  assert.equal(mon.body, 'If you worked it: that day’s £60 base plus commission is not in Friday’s pay (23 Oct) until it is logged.', 'the pay-cost wording is kept');
  assert.deepEqual(attentionOwnGapWindow(NOW.today), { from: '2026-10-12', to: '2026-10-15' });
  const beforeStart = ev({ id: 63, date: '2026-10-13' });
  const starter = input('rep', { events: [beforeStart] });
  starter.me.startDate = '2026-10-14';
  assert.deepEqual(keys(attentionItems(starter, NOW)), []);
  // Monday 19 Oct: Saturday 17 Oct belongs to last week (which may already be paid) → never asked for, paid or not
  const monday: AttentionNow = { today: '2026-10-19', nowHHMM: '10:00', nowISO: '2026-10-19T09:00:00.000Z' };
  const sat = ev({ id: 64, date: '2026-10-17' });
  assert.equal(byKey(attentionItems(input('rep', { events: [sat] }), monday), 'gauges:event:64:user:10'), undefined);
  assert.deepEqual(attentionOwnGapWindow(monday.today), { from: '2026-10-19', to: '2026-10-19' });
  // … and today's own event counts only once it has ended
  const mondayLive = ev({ id: 66, date: '2026-10-19', status: 'live', endTime: '17:00' });
  assert.equal(byKey(attentionItems(input('rep', { events: [mondayLive] }), monday), 'gauges:event:66:user:10'), undefined, 'still running');
  const mondayEvent = ev({ id: 65, date: '2026-10-19', endTime: '09:30' });
  assert.match(byKey(attentionItems(input('rep', { events: [mondayEvent] }), monday), 'gauges:event:65:user:10')!.body, /Friday’s pay \(30 Oct\)/, 'this week is paid the Friday after it ends');
  // Sunday 25 Oct: every unlogged day Monday 19 … Saturday 24 is asked for, nothing from the week before
  const sunday: AttentionNow = { today: '2026-10-25', nowHHMM: '12:00', nowISO: '2026-10-25T11:00:00.000Z' };
  const week = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].map((date, i) => ev({ id: 400 + i, date }));
  assert.deepEqual(
    keys(attentionItems(input('rep', { events: week }), sunday)).sort(),
    [401, 402, 403, 404, 405, 406].map((id) => `gauges:event:${id}:user:10`),
  );
  // a week already paid is still never asked for (defensive: the run exists before payday only after a pay run)
  const paid = run({ id: 9, userId: 10, weekStart: '2026-10-19', weekEnd: '2026-10-25', dueDate: '2026-10-30', paidDate: '2026-10-25', status: 'paid' });
  assert.deepEqual(keys(attentionItems(input('rep', { events: week, runs: [paid] }), sunday)).filter((k) => k.startsWith('gauges:event')), []);
});

test('the route loads from today − 3, or from Monday when that is earlier', () => {
  assert.equal(attentionLookbackFrom('2026-10-15'), '2026-10-12', 'Thursday: today − 3 is Monday');
  assert.equal(attentionLookbackFrom('2026-10-19'), '2026-10-16', 'Monday: today − 3 (the team rules still look back 2 days)');
  assert.equal(attentionLookbackFrom('2026-10-25'), '2026-10-19', 'Sunday: Monday is 6 days back');
});

test('rep: pay-cost framing — firm when I usually work my team’s days, hedged otherwise, no money when the base is 0', () => {
  const e = ev({ id: 70, date: '2026-10-14' });
  const firm = byKey(attentionItems(input('rep', { events: [e], attendance: { teamDays: 10, workedDays: 8 } }), NOW), 'gauges:event:70:user:10')!;
  assert.equal(firm.body, 'Wednesday not logged yet: that day’s £60 base plus commission is missing from Friday’s pay (23 Oct). Log it before the week is paid.');
  const today = ev({ id: 71, date: NOW.today, endTime: '12:00' });
  assert.match(byKey(attentionItems(input('rep', { events: [today], attendance: { teamDays: 10, workedDays: 8 } }), NOW), 'gauges:event:71:user:10')!.body, /^Today not logged yet/);
  const rare = byKey(attentionItems(input('rep', { events: [e], attendance: { teamDays: 10, workedDays: 2 } }), NOW), 'gauges:event:70:user:10')!;
  assert.match(rare.body, /^If you worked it/);
  const noBase = byKey(attentionItems(input('rep', { events: [e], plan: { ...PLAN, basePerDay: 0 } }), NOW), 'gauges:event:70:user:10')!;
  assert.ok(!noBase.body.includes('£'), 'the money sentence is dropped when the base is 0');
  const noCommission = byKey(attentionItems(input('rep', { events: [e], plan: { ...PLAN, commissionPerSale: 0 } }), NOW), 'gauges:event:70:user:10')!;
  assert.match(noCommission.body, /£60 base is not in/);
  assert.equal(attentionUsuallyAttends({ teamDays: 2, workedDays: 2 }), false, 'too few team days to say "usually"');
  assert.equal(attentionUsuallyAttends({ teamDays: 4, workedDays: 2 }), true);
});

test('rep / leader: tomorrow’s own-team event → events:tomorrow (info) with venue, times and notes cut to 140 characters', () => {
  const notes = 'Meet at the north entrance. '.repeat(10);
  const e = ev({ id: 80, date: '2026-10-16', status: 'scheduled', startTime: '10:00', endTime: '18:00', venue: 'Trafford Centre', notes });
  const it = byKey(attentionItems(input('rep', { events: [e] }), NOW), 'events:tomorrow:80')!;
  assert.equal(it.severity, 'info');
  assert.equal(it.title, 'Tomorrow: BCN — Trafford Centre at 10:00');
  assert.ok(it.body.startsWith('Manchester · 10:00–18:00 · Meet at the north entrance.'), 'the venue is in the title, not repeated');
  const shownNotes = it.body.split(' · ').slice(2).join(' · ');
  assert.ok(shownNotes.length <= 140 && shownNotes.endsWith('…'));
  assert.ok(byKey(attentionItems(input('leader', { events: [e] }), NOW), 'events:tomorrow:80'));
  assert.equal(byKey(attentionItems(input('rep', { events: [{ ...e, status: 'cancelled' }] }), NOW), 'events:tomorrow:80'), undefined);
  assert.equal(attentionItems(input('admin', { events: [e] }), NOW).filter((i) => i.key.startsWith('events:tomorrow')).length, 0, 'admins have no team calendar');
});

test('rep / leader: today’s team event, not checked in yet → events:checkin with a Check in button', () => {
  const e = ev({ id: 91, date: '2026-10-15', status: 'live', startTime: '09:00', endTime: '17:00', venue: 'Arndale' });
  const it = byKey(attentionItems(input('rep', { events: [e], checkedInToday: [] }), NOW), 'events:checkin:91')!;
  assert.ok(it, 'item present');
  assert.equal(it.kind, 'events');
  assert.equal(it.severity, 'warning', 'it has started');
  assert.equal(it.title, 'Check in at BCN — Arndale');
  assert.equal(it.body, 'Started 09:00. Tap Check in when you get there.');
  assert.equal(it.href, '/quick?eventId=91');
  assert.equal(it.actionLabel, 'Check in');
  assert.ok(byKey(attentionItems(input('leader', { events: [e], checkedInToday: [] }), NOW), 'events:checkin:91'), 'leaders too');
});

test('check-in item: gone once checked in or once the day is logged; a teammate’s row does not count', () => {
  const e = ev({ id: 92, date: '2026-10-15', status: 'live' });
  const has = (p: Partial<AttentionInput>, role: Role = 'rep') => !!byKey(attentionItems(input(role, { events: [e], ...p }), NOW), 'events:checkin:92');
  assert.equal(has({ checkedInToday: [92] }), false);
  assert.equal(has({ checkedInToday: [], entries: [row(1, 92, 10, '2026-10-15')] }), false, 'logged the day');
  assert.equal(has({ checkedInToday: [], entries: [row(2, 92, 11, '2026-10-15')] }, 'leader'), true, 'someone else logged');
  assert.equal(has({ checkedInToday: null }), false, 'not known (an older server): no nagging');
  assert.equal(has({}), false);
});

test('check-in item: from an hour before the start until the end; never cancelled, another day, admins or recruiters', () => {
  const later = ev({ id: 93, date: '2026-10-15', status: 'scheduled', startTime: '16:00', endTime: '20:00', venue: 'MediaCity' });
  const soon = byKey(attentionItems(input('rep', { events: [later], checkedInToday: [] }), NOW), 'events:checkin:93')!;
  assert.equal(soon.severity, 'info', 'not started yet');
  assert.equal(soon.body, 'Starts 16:00 · 5 min grace. Tap Check in when you get there.');
  const at = (nowHHMM: string) => ({ ...NOW, nowHHMM });
  const has = (e: SalesEventWithMeta, now = NOW, role: Role = 'rep') => attentionItems(input(role, { events: [e], checkedInToday: [] }), now).some((i) => i.key.startsWith('events:checkin:'));
  assert.equal(has({ ...later, startTime: '16:01' }), false, 'more than an hour before');
  assert.equal(has(later, at('20:00')), true, 'until the end');
  assert.equal(has(later, at('20:01')), false, 'after the end');
  assert.equal(has({ ...later, status: 'cancelled' }), false);
  assert.equal(has({ ...later, date: '2026-10-16' }), false, 'tomorrow has its own item');
  assert.equal(has({ ...later, teamId: TEAM_B }), false, 'another team');
  assert.equal(has(later, NOW, 'admin'), false);
  assert.equal(has(later, NOW, 'recruiter'), false);
});

// ───────────────────────────── pay ─────────────────────────────

test('pay: an overdue unpaid run → danger with the amount, reference and due date', () => {
  const r = run({ id: 7, userId: 10, dueDate: '2026-10-13', status: 'failed' });
  const it = byKey(attentionItems(input('rep', { runs: [r] }), NOW), 'pay:overdue:7')!;
  assert.equal(it.severity, 'danger');
  assert.equal(it.title, 'Your pay for w/c 5 Oct is 2 days overdue');
  assert.equal(it.body, '£412.50 (PAY-202641-LM-0010) was due Tue 13 Oct. The office sees this too.');
  assert.equal(it.href, '/finance?tab=me');
  assert.equal(attentionItems(input('rep', { runs: [r] }), NOW)[0]!.key, 'pay:overdue:7', 'danger sorts first');
});

test('pay: "The office sees this too" only for a run on Runs to pay (pending: 12-week window; failed: any age); an older pending one asks the rep to mention it', () => {
  const win = attentionPayrollWindow(NOW.today);
  const inside = run({ id: 30, userId: 10, weekStart: win.from, weekEnd: '2026-07-26', dueDate: '2026-07-31', status: 'pending' });
  const older = run({ id: 31, userId: 10, weekStart: '2026-07-06', weekEnd: '2026-07-12', dueDate: '2026-07-17', gross: 435, status: 'pending' });
  const oldFailed = run({ id: 32, userId: 10, weekStart: '2026-06-08', weekEnd: '2026-06-14', dueDate: '2026-06-19', gross: 122, status: 'failed' });
  const items = attentionItems(input('rep', { runs: [inside, older, oldFailed] }), NOW);
  assert.match(byKey(items, 'pay:overdue:30')!.body, /The office sees this too\.$/);
  // a failed transfer is on Runs to pay whatever its age, so the rep is not asked to chase it
  assert.match(byKey(items, 'pay:overdue:32')!.body, /The office sees this too\.$/);
  assert.equal(inRunsToPay(oldFailed, NOW.today), true);
  assert.equal(inRunsToPay(older, NOW.today), false);
  assert.equal(inRunsToPay(inside, NOW.today), true);
  assert.equal(inRunsToPay({ ...inside, status: 'paid' }, NOW.today), false);
  assert.equal(byKey(items, 'pay:overdue:31')!.body, '£435 (PAY-202641-LM-0010) was due Fri 17 Jul. It is older than the 12 weeks the office’s pay list shows, so please mention it to them.');
  assert.equal(byKey(items, 'pay:overdue:31')!.severity, 'danger');
  // the admin's own overdue run never says either (they are the office)
  assert.equal(byKey(attentionItems(input('admin', { meId: 1, runs: [{ ...older, userId: 1 }] }), NOW), 'pay:overdue:31')!.body, '£435 (PAY-202641-LM-0010) was due Fri 17 Jul.');
});

test('pay: due tomorrow → info; paid 3 days ago → info; paid 9 days ago → nothing; never someone else’s run', () => {
  const tomorrow = run({ id: 1, userId: 10, dueDate: '2026-10-16' });
  assert.equal(byKey(attentionItems(input('rep', { runs: [tomorrow] }), NOW), 'pay:due-tomorrow:1')?.severity, 'info');
  const recent = run({ id: 2, userId: 10, weekStart: '2026-09-28', dueDate: '2026-10-09', paidDate: '2026-10-12', status: 'late' });
  const it = byKey(attentionItems(input('rep', { runs: [recent] }), NOW), 'pay:paid:2')!;
  assert.equal(it.severity, 'info');
  assert.equal(it.title, 'You’ve been paid £412.50 for w/c 28 Sep');
  const old = run({ id: 3, userId: 10, weekStart: '2026-09-21', dueDate: '2026-10-02', paidDate: '2026-10-06', status: 'paid' });
  assert.deepEqual(keys(attentionItems(input('rep', { runs: [old] }), NOW)), []);
  const someoneElse = run({ id: 4, userId: 99, dueDate: '2026-10-01' });
  assert.deepEqual(keys(attentionItems(input('rep', { runs: [someoneElse] }), NOW)), []);
});

// ───────────────────────────── leader / admin: team rules ─────────────────────────────

test('leader gap: only missing active members who had started, skipping anyone who logged another event that day', () => {
  const day = '2026-10-14';
  const e = ev({ id: 90, date: day, venue: 'MediaCity', campaignCode: 'Volt', repCount: 2 });
  const other = ev({ id: 91, date: day, teamId: TEAM_B });
  const members = [
    member(10, 'Lee', TEAM_A, { role: 'leader' }),
    member(11, 'Jordan'),
    member(12, 'Aisha'),
    member(13, 'Sam'),
    member(14, 'Mia'),
    member(15, 'Newbie', TEAM_A, { startDate: '2026-10-15' }), // started after the event
    member(16, 'Office', TEAM_A, { role: 'recruiter' }),
    member(18, 'Gone', TEAM_A, { status: 'left' }), // left the company: never chased
    member(19, 'Away', TEAM_A, { status: 'on_leave' }), // on leave: never chased
    member(17, 'Bo', TEAM_B),
  ];
  const entries = [row(1, 90, 11, day), row(2, 90, 10, day), row(3, 91, 14, day)]; // Mia logged at another event
  const it = byKey(attentionItems(input('leader', { events: [e, other], entries, members }), NOW), 'gauges:gap:90')!;
  assert.ok(it);
  assert.equal(it.severity, 'warning');
  assert.equal(it.title, '2 of 5 have not logged Volt — MediaCity', 'the whole team counts, the leader included');
  assert.equal(it.count, 2, 'the missing count travels with the item, so a gap that grows is new again');
  assert.equal(it.body, 'Still to log for Wed 14 Oct: Aisha and Sam. A quick message to the team usually sorts it.');
  assert.equal(it.href, '/events/90');
  // exactly one missing → a direct link and a "Log for …" action
  const one = byKey(attentionItems(input('leader', { events: [e], entries: [...entries, row(4, 90, 12, day)], members }), NOW), 'gauges:gap:90')!;
  assert.equal(one.title, '1 of 5 has not logged Volt — MediaCity');
  assert.equal(one.href, '/gauges?log=1&eventId=90&userId=13');
  assert.equal(one.actionLabel, 'Log for Sam');
  // the leader themself is counted but never chased by name; a gap that is only the leader is no gap item
  const meToo = byKey(attentionItems(input('leader', { events: [e], entries: entries.filter((g) => g.userId !== 10), members }), NOW), 'gauges:gap:90')!;
  assert.equal(meToo.title, '3 of 5 have not logged Volt — MediaCity');
  assert.equal(meToo.body, 'Still to log for Wed 14 Oct: you, Aisha and Sam. A quick message to the team usually sorts it.');
  const onlyMe = [row(1, 90, 11, day), row(3, 91, 14, day), row(4, 90, 12, day), row(5, 90, 13, day)];
  assert.equal(byKey(attentionItems(input('leader', { events: [e, other], entries: onlyMe, members }), NOW), 'gauges:gap:90'), undefined);
  assert.ok(byKey(attentionItems(input('leader', { events: [e, other], entries: onlyMe, members }), NOW), 'gauges:event:90:user:10'), 'the leader gets their own item instead');
  // the admin reads the same count
  assert.equal(byKey(attentionItems(input('admin', { events: [e, other], entries, members }), NOW), 'gauges:gap:90')!.title, '2 of 5 have not logged Volt — MediaCity');
  // the other team's event never shows for this leader
  assert.ok(attentionItems(input('leader', { events: [e, other], entries, members }), NOW).every((i) => !i.key.includes(':91')));
});

test('team gaps: ended 2 h … 48 h ago, at least one row; never for reps', () => {
  const members = [member(10, 'Lee', TEAM_A, { role: 'leader' }), member(11, 'Jordan'), member(12, 'Aisha')];
  const justEnded = ev({ id: 92, date: NOW.today, status: 'live', startTime: '08:00', endTime: '14:00', repCount: 1 });
  const entries = [row(1, 92, 11, NOW.today)];
  assert.equal(byKey(attentionItems(input('leader', { events: [justEnded], entries, members }), NOW), 'gauges:gap:92'), undefined, 'ended 1 h ago');
  const later: AttentionNow = { ...NOW, nowHHMM: '16:30' };
  assert.ok(byKey(attentionItems(input('leader', { events: [justEnded], entries, members }), later), 'gauges:gap:92'));
  const old = ev({ id: 93, date: '2026-10-13', endTime: '14:00', repCount: 1 });
  assert.equal(byKey(attentionItems(input('leader', { events: [old], entries: [row(2, 93, 11, '2026-10-13')], members }), NOW), 'gauges:gap:93'), undefined, 'ended 49 h ago');
  const rep = attentionItems(input('rep', { meId: 11, events: [justEnded], entries, members }), later);
  assert.ok(rep.every((i) => !/^(gauges:gap|events:empty|events:behind|gauges:odd|payroll:|recruitment:)/.test(i.key)));
});

test('events:empty, events:behind and gauges:odd for leaders and admins', () => {
  const members = [member(10, 'Lee', TEAM_A, { role: 'leader' }), member(11, 'Jordan')];
  const empty = ev({ id: 94, date: '2026-10-14', repCount: 0 });
  const live = ev({ id: 95, date: NOW.today, status: 'live', startTime: '09:00', endTime: '18:30', targetSales: 12, totals: { stops: 80, table: 30, presentations: 15, closes: 8, taps: 5, sales: 4 }, repCount: 2 });
  const odd1 = row(1, 95, 11, NOW.today, 62, 0, 0);
  const odd2 = row(2, 95, 10, NOW.today, 55, 14, 30);
  const items = attentionItems(input('leader', { events: [empty, live], entries: [odd1, odd2], members }), NOW);
  const e = byKey(items, 'events:empty:94')!;
  assert.equal(e.severity, 'warning');
  assert.match(e.body, /did it run\? Log it or mark it cancelled/);
  const b = byKey(items, 'events:behind:95')!;
  assert.equal(b.severity, 'info');
  assert.equal(b.body, '4 of 12 sales so far with 3 h 30 min to go. More stops in that time is the lever.');
  assert.equal(byKey(attentionItems(input('leader', { events: [live], members }), { ...NOW, nowHHMM: '12:30' }), 'events:behind:95'), undefined, 'not before 13:00');
  // with a forecast, the item follows the row's "Behind target" pill (forecast.flag), never the half-target rule
  const fc = (flag: 'at_risk' | null): NonNullable<SalesEventWithMeta['forecast']> => ({
    expectedSales: 9, low: 4.1, high: 13.9, expectedReps: 3, perRepRate: 3, repsNeeded: 4, basisDays: 12, basis: 'team', flag, suggestedTarget: 10,
  });
  const onTrack = { ...live, forecast: fc(null) }; // 4 of 12 after 13:00, but the estimate says the day gets there
  assert.equal(byKey(attentionItems(input('leader', { events: [onTrack], members }), NOW), 'events:behind:95'), undefined, 'no pill, no item');
  assert.equal(eventBehindTarget(onTrack, NOW), false);
  const early = { ...live, forecast: fc('at_risk') }; // the pill shows before 13:00 too, and so does the item
  assert.equal(byKey(attentionItems(input('leader', { events: [early], members }), { ...NOW, nowHHMM: '11:00' }), 'events:behind:95')?.title, `BCN — ${live.venue} is behind target`);
  assert.equal(eventBehindTarget(early, { ...NOW, nowHHMM: '11:00' }), true);
  assert.equal(eventBehindTarget({ ...early, targetSales: 0 }, NOW), false, 'no target, nothing to be behind');
  assert.equal(eventBehindTarget(early, { ...NOW, nowHHMM: '18:30' }), false, 'over: not running any more');
  const o1 = byKey(items, 'gauges:odd:1')!;
  assert.equal(o1.title, 'Check Jordan’s gauges for Thu 15 Oct');
  assert.match(o1.body, /62 stops with nobody at the table/);
  assert.equal(o1.href, '/gauges?log=1&eventId=95&userId=11');
  assert.match(byKey(items, 'gauges:odd:2')!.body, /14 sales from 55 stops \(25\.5%\)/);
  assert.equal(byKey(items, 'gauges:odd:2')!.title, 'Check your gauges for Thu 15 Oct');
  // admins see every team
  const adminItems = attentionItems(input('admin', { events: [{ ...empty, teamId: TEAM_B }], members: [] }), NOW);
  assert.ok(byKey(adminItems, 'events:empty:94'));
});

// ───────────────────────────── recruitment ─────────────────────────────

function candidate(id: number, first: string, last: string, nextActionAt: string | null, ownerId: number | null = 10): CandidateWithMeta {
  return {
    id, firstName: first, lastName: last, email: `${first}@x.test`, phone: null, city: null, source: 'indeed', stage: 'screening',
    positionApplied: 'trainee', appliedAt: '2026-10-01T09:00:00.000Z', stageUpdatedAt: '2026-10-02T09:00:00.000Z', ownerId, referredById: null,
    rating: null, notes: null, nextAction: 'Book first interview', nextActionAt, hiredUserId: null, ownerName: null, referredByName: null, daysInPipeline: 14,
  };
}

function interview(id: number, scheduledAt: string, p: Partial<AttentionInterview> = {}): AttentionInterview {
  return {
    id, candidateId: 500 + id, type: 'first', scheduledAt, interviewerId: 10, interviewerName: null, outcome: 'pending', notes: null,
    candidateName: 'Aisha Khan', candidateFirstName: 'Aisha', candidateOwnerId: 10, candidateStage: 'interview', ...p,
  };
}

test('recruitment: one overdue summary with up to 3 names; never for reps', () => {
  const cs = [
    candidate(1, 'Aisha', 'Khan', '2026-10-10T09:00:00.000Z'),
    candidate(2, 'Sam', 'Lee', '2026-10-12'),
    candidate(3, 'Leo', 'Park', '2026-10-14T08:00:00.000Z'),
    candidate(4, 'Mia', 'Chen', '2026-10-13T10:00:00.000Z'),
    candidate(5, 'Not', 'Yet', '2026-10-15'), // date-only today: not overdue until tomorrow
  ];
  const it = byKey(attentionItems(input('recruiter', { candidates: cs }), NOW), 'recruitment:overdue')!;
  assert.equal(it.severity, 'warning');
  // a recruiter's feed covers their own and unassigned candidates: the sentence says whose they are
  assert.equal(it.title, '4 of your recruitment follow-ups are overdue');
  assert.equal(it.count, 4);
  assert.equal(it.body, 'Aisha Khan, Sam Lee, Mia Chen and 1 more are waiting on a next step (yours or unassigned). Book it or move them on.');
  assert.equal(it.href, '/recruitment');
  // … and quotes the pipeline's figure (the "Overdue actions" tile above the card) when that is larger
  const wider = byKey(attentionItems(input('recruiter', { candidates: cs, pipelineOverdue: 7 }), NOW), 'recruitment:overdue')!;
  assert.equal(wider.title, '4 of your recruitment follow-ups are overdue');
  assert.equal(wider.body, 'Aisha Khan, Sam Lee, Mia Chen and 1 more are waiting on a next step (yours or unassigned; 7 across the pipeline). Book it or move them on.');
  assert.equal(byKey(attentionItems(input('recruiter', { candidates: cs.slice(0, 1), pipelineOverdue: 1 }), NOW), 'recruitment:overdue')!.title, '1 of your recruitment follow-ups is overdue');
  // a leader's are the candidates they own; the admin's are the whole pipeline
  assert.equal(byKey(attentionItems(input('leader', { candidates: cs }), NOW), 'recruitment:overdue')!.body, 'Aisha Khan, Sam Lee, Mia Chen and 1 more are waiting on a next step. Book it or move them on.');
  assert.equal(byKey(attentionItems(input('leader', { candidates: cs }), NOW), 'recruitment:overdue')!.title, '4 of your recruitment follow-ups are overdue');
  assert.equal(byKey(attentionItems(input('admin', { candidates: cs }), NOW), 'recruitment:overdue')!.title, '4 recruitment follow-ups are overdue');
  assert.deepEqual(keys(attentionItems(input('rep', { candidates: cs }), NOW)), []);
});

test('recruitment: a pending interview 3 h ago → record-the-outcome item; 1 h ago → none; upcoming ones are listed for today', () => {
  const three = interview(1, '2026-10-15T11:00:00.000Z'); // 12:00 London
  const it = byKey(attentionItems(input('recruiter', { interviews: [three] }), NOW), 'recruitment:interview:1')!;
  assert.equal(it.severity, 'warning');
  assert.equal(it.title, 'Record the outcome of Aisha Khan’s first interview (Thu 12:00)');
  assert.equal(it.href, '/recruitment/501');
  const one = interview(2, '2026-10-15T13:00:00.000Z');
  assert.deepEqual(keys(attentionItems(input('recruiter', { interviews: [one] }), NOW)), []);
  // someone else's interview for a candidate I do not own → nothing (unless admin)
  const others = interview(3, '2026-10-15T09:00:00.000Z', { interviewerId: 77, candidateOwnerId: 78 });
  assert.deepEqual(keys(attentionItems(input('recruiter', { interviews: [others] }), NOW)), []);
  assert.ok(byKey(attentionItems(input('admin', { interviews: [others] }), NOW), 'recruitment:interview:3'));
  // next 24 h, mine only
  const soon = [interview(4, '2026-10-15T15:30:00.000Z', { type: 'phone', candidateName: 'Sam Lee' }), interview(5, '2026-10-16T08:00:00.000Z')];
  const today = byKey(attentionItems(input('recruiter', { interviews: soon }), NOW), 'recruitment:today')!;
  assert.equal(today.severity, 'info');
  assert.equal(today.title, '2 interviews in the next 24 hours');
  assert.equal(today.body, 'Sam Lee (phone interview, today 16:30) and Aisha Khan (first interview, tomorrow 09:00)');
  const far = interview(6, '2026-10-16T16:00:00.000Z');
  assert.equal(byKey(attentionItems(input('recruiter', { interviews: [far] }), NOW), 'recruitment:today'), undefined);
});

test('recruitment:interview follows the shared outcome rule: 120-minute grace, 56-day look-back, open candidates only', () => {
  const at = (id: number, scheduledAt: string, p: Partial<AttentionInterview> = {}) => interview(id, scheduledAt, p);
  const list = [
    at(11, '2026-10-15T12:00:00.000Z'), // exactly 120 minutes before 14:00Z → asks
    at(12, '2026-10-15T12:01:00.000Z'), // 119 minutes → not yet
    at(13, '2026-10-10T09:00:00.000Z', { candidateName: 'Sam Lee', candidateFirstName: 'Sam' }), // 5 days ago → asks
    at(14, '2026-08-20T09:00:00.000Z'), // 56 days and more → no longer
    at(15, '2026-10-14T09:00:00.000Z', { candidateStage: 'rejected' }), // closed candidate → never
    at(16, '2026-10-14T09:00:00.000Z', { outcome: 'passed' }),
  ];
  const items = attentionItems(input('recruiter', { interviews: list }), NOW).filter((i) => i.key.startsWith('recruitment:interview'));
  assert.deepEqual(keys(items).sort(), ['recruitment:interview:11', 'recruitment:interview:13']);
  assert.equal(byKey(items, 'recruitment:interview:13')!.title, 'Record the outcome of Sam Lee’s first interview (Sat 10:00)');
  assert.equal(byKey(items, 'recruitment:interview:13')!.body, 'Passed, failed or no-show: recording it lets Sam’s next step be booked.');
  // the same list through the shared function gives the same interviews (one rule, one place)
  const ownerOf = new Map(list.map((i) => [i.candidateId, i.candidateOwnerId]));
  assert.deepEqual(outcomesToRecord(list, { id: 10, role: 'recruiter' }, (id) => ownerOf.get(id), NOW.nowISO).map((i) => i.id).sort(), [11, 13]);
});

// ───────────────────────────── admin ─────────────────────────────

test('admin: runs to pay — pending runs of the to-pay window plus failed transfers of any age, failed named, danger when any is overdue', () => {
  const win = attentionPayrollWindow(NOW.today);
  assert.deepEqual(win, { from: '2026-07-20', to: '2026-10-15' });
  const runs = [
    run({ id: 1, userId: 21, gross: 400 }),
    run({ id: 2, userId: 22, gross: 350.5, status: 'failed' }),
    run({ id: 3, userId: 23, gross: 100, weekStart: '2026-07-13', dueDate: '2026-07-24' }), // outside the window
    run({ id: 4, userId: 24, gross: 500, status: 'paid', paidDate: '2026-10-14' }),
  ];
  const it = byKey(attentionItems(input('admin', { runs }), NOW), 'payroll:to-pay')!;
  assert.equal(it.severity, 'warning');
  assert.equal(it.title, '2 runs to pay · £750.50 · 1 failed transfer');
  assert.equal(it.href, '/finance?tab=company#runs');
  const late = [...runs, run({ id: 5, userId: 25, gross: 49.5, weekStart: '2026-09-28', dueDate: '2026-10-09' })];
  const danger = byKey(attentionItems(input('admin', { runs: late }), NOW), 'payroll:to-pay')!;
  assert.equal(danger.severity, 'danger');
  assert.equal(danger.title, '3 runs to pay · £800 · 1 failed transfer');
  assert.equal(danger.body, '1 is overdue: it was due Fri 9 Oct. Paying it first is the lever.', 'singular for one run');
  assert.equal(danger.count, 3, 'the count travels with the summary (a higher count is new again on the client)');
  const twoLate = [...late, run({ id: 6, userId: 26, gross: 10, weekStart: '2026-09-21', dueDate: '2026-10-02' })];
  assert.equal(byKey(attentionItems(input('admin', { runs: twoLate }), NOW), 'payroll:to-pay')!.body, '2 are overdue: the oldest was due Fri 2 Oct. Paying those first is the lever.');
  // reps never get payroll items, even if handed other people's runs
  assert.ok(attentionItems(input('rep', { runs }), NOW).every((i) => !i.key.startsWith('payroll:')));
  // a failed transfer older than the window is still owed: counted, totalled, and the oldest due date is its own
  const oldFailed = [...runs, run({ id: 7, userId: 27, gross: 122, weekStart: '2026-06-08', weekEnd: '2026-06-14', dueDate: '2026-06-19', status: 'failed' })];
  const owed = byKey(attentionItems(input('admin', { runs: oldFailed }), NOW), 'payroll:to-pay')!;
  assert.equal(owed.title, '3 runs to pay · £872.50 · 2 failed transfers');
  assert.equal(owed.body, '1 is overdue: it was due Fri 19 Jun. Paying it first is the lever.');
});

test('admin: the due-today item on payday Friday only; two-step reminder when it is off', () => {
  const friday: AttentionNow = { today: '2026-10-16', nowHHMM: '09:00', nowISO: '2026-10-16T08:00:00.000Z' };
  const runs = [run({ id: 1, userId: 21, gross: 400 }), run({ id: 2, userId: 22, gross: 212.25 })];
  const it = byKey(attentionItems(input('admin', { runs }), friday), 'payroll:due-today:2026-10-16')!;
  assert.equal(it.severity, 'warning');
  assert.equal(it.title, 'Payday today: 2 runs due · £612.25');
  assert.equal(byKey(attentionItems(input('admin', { runs }), NOW), 'payroll:due-today:2026-10-15'), undefined, 'Thursday');
  assert.ok(byKey(attentionItems(input('admin', { twoFactorEnabled: false }), NOW), 'security:2fa'));
  assert.equal(byKey(attentionItems(input('admin', { twoFactorEnabled: true }), NOW), 'security:2fa'), undefined);
  assert.equal(byKey(attentionItems(input('leader', { twoFactorEnabled: false }), NOW), 'security:2fa'), undefined, 'admins only');
});

// ───────────────────────────── ordering and determinism ─────────────────────────────

test('sorted danger → warning → info, newest first, at most 20; keys and copy identical across calls', () => {
  const events = Array.from({ length: 30 }, (_, i) => ev({ id: 200 + i, date: '2026-10-16', status: 'scheduled', startTime: `${String(8 + (i % 10)).padStart(2, '0')}:00` }));
  const all = [
    ...events,
    ev({ id: 300, date: '2026-10-14' }),
    ev({ id: 301, date: '2026-10-13' }),
  ];
  const runs = [run({ id: 7, userId: 10, dueDate: '2026-10-13' })];
  const a = attentionItems(input('rep', { events: all, runs }), NOW);
  const b = attentionItems(input('rep', { events: [...all].reverse(), runs }), NOW);
  assert.equal(a.length, ATTENTION_MAX_ITEMS);
  assert.deepEqual(a, b, 'input order never changes the output');
  assert.deepEqual(keys(a).slice(0, 3), ['pay:overdue:7', 'gauges:event:300:user:10', 'gauges:event:301:user:10']);
  const sev = a.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort((x, y) => ['danger', 'warning', 'info'].indexOf(x) - ['danger', 'warning', 'info'].indexOf(y)));
  assert.deepEqual(sortAttentionItems([...a].reverse()), a);
  assert.deepEqual(attentionItems(input('rep', { events: all, runs }), NOW), a);
  assert.equal(new Set(keys(a)).size, a.length, 'unique keys');
});
