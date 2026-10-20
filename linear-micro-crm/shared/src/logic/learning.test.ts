import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAREER_LEVELS, LESSON_ANCHORS, LESSON_GROUPS, LESSON_KEYS, type ProgressionWeek } from '../types/learning.ts';
import {
  CAREER_LEVEL_LABELS,
  LESSON_GROUP_OF,
  PROGRESSION_MILESTONES,
  PROGRESSION_RULES,
  careerLevelFor,
  dayMonthLabel,
  isLessonKey,
  isProgressionMilestoneKey,
  isTaskLesson,
  lessonStateOf,
  nextCareerLevel,
  progressionFrom,
  quizPassed,
  type ProgressionInput,
} from './learning.ts';

/** 12 Mon–Sun weeks ending with the week of 2026-10-19 (this week), sales per week as given (oldest first). */
function weeksOf(sales: number[], team: (number | null)[] = sales.map(() => null)): ProgressionWeek[] {
  const out: ProgressionWeek[] = [];
  const last = Date.UTC(2026, 9, 19);
  for (let i = 0; i < sales.length; i++) {
    const d = new Date(last - (sales.length - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10);
    out.push({ weekStart: d, sales: sales[i]!, teamSales: team[i] ?? null });
  }
  return out;
}

const pad = (xs: number[], n = PROGRESSION_RULES.windowWeeks) => [...Array.from({ length: n - xs.length }, () => 0), ...xs];

function input(over: Partial<ProgressionInput> = {}): ProgressionInput {
  return {
    userId: 10,
    userName: 'Jordan Lee',
    position: 'field_rep',
    weeks: weeksOf(pad([8, 12])),
    learned: 9,
    taught: 4,
    total: 21,
    milestones: {},
    teamLeadersOnTeam: 0,
    forSelf: true,
    ...over,
  };
}

test('lesson keys, groups and anchors line up', () => {
  assert.equal(LESSON_KEYS.length, 21);
  for (const k of LESSON_KEYS) assert.ok(LESSON_GROUPS.includes(LESSON_GROUP_OF[k]), k);
  for (const g of LESSON_GROUPS) assert.ok(LESSON_KEYS.some((k) => LESSON_GROUP_OF[k] === g), `group ${g} has a lesson`);
  for (const k of Object.keys(LESSON_ANCHORS)) assert.ok(isLessonKey(k), k);
  assert.ok(isLessonKey('bullet-theory'));
  assert.ok(!isLessonKey('Bullet-Theory'));
  assert.ok(!isLessonKey(42));
  assert.deepEqual(LESSON_KEYS.filter(isTaskLesson), ['run-an-impact', 'go-on-a-roadtrip']);
});

test('quizPassed: every answer right, at least one question, whole numbers', () => {
  assert.equal(quizPassed(3, 3), true);
  assert.equal(quizPassed(1, 1), true);
  assert.equal(quizPassed(2, 3), false);
  assert.equal(quizPassed(0, 0), false);
  assert.equal(quizPassed(2.5, 2.5), false);
  assert.equal(quizPassed(4, 3), false);
});

test('lessonStateOf: sign-off wins, then a written teach-back, then learned', () => {
  const at = '2026-10-01T10:00:00.000Z';
  assert.equal(lessonStateOf(null), 'new');
  assert.equal(lessonStateOf({ learnedAt: null, teachbackAt: null, taughtSignedOffAt: null }), 'new');
  assert.equal(lessonStateOf({ learnedAt: at, teachbackAt: null, taughtSignedOffAt: null }), 'learned');
  assert.equal(lessonStateOf({ learnedAt: at, teachbackAt: at, taughtSignedOffAt: null }), 'teachback_sent');
  assert.equal(lessonStateOf({ learnedAt: at, teachbackAt: at, taughtSignedOffAt: at }), 'taught');
  // an in-person sign-off without a written teach-back still counts
  assert.equal(lessonStateOf({ learnedAt: null, teachbackAt: null, taughtSignedOffAt: at }), 'taught');
});

test('career level from position, and the next level', () => {
  assert.equal(careerLevelFor('trainee'), 'entry');
  assert.equal(careerLevelFor('field_rep'), 'entry');
  assert.equal(careerLevelFor('team_leader'), 'leadership');
  assert.equal(careerLevelFor('crew_leader'), 'campaign_manager');
  assert.equal(careerLevelFor('assistant_owner'), 'assistant_director');
  assert.equal(careerLevelFor('owner'), 'senior_director');
  assert.equal(careerLevelFor('recruiter'), null);
  assert.equal(nextCareerLevel('entry'), 'leadership');
  assert.equal(nextCareerLevel('regional_consultant'), 'national_consultant');
  assert.equal(nextCareerLevel('national_consultant'), null);
  assert.equal(nextCareerLevel(null), null);
  for (const l of CAREER_LEVELS) assert.ok(CAREER_LEVEL_LABELS[l]);
});

test('milestones: keys, targets and the level they lead to', () => {
  assert.ok(isProgressionMilestoneKey('four_plus_one'));
  assert.ok(!isProgressionMilestoneKey('toString'));
  assert.equal(PROGRESSION_MILESTONES.trained_leaders.target, 3);
  assert.equal(PROGRESSION_MILESTONES.first_gen_offices_7.target, 7);
  assert.equal(dayMonthLabel('2026-10-05'), '5 Oct');
  assert.equal(dayMonthLabel('2026-01-31'), '31 Jan');
});

test('entry: the plan example headline, with real numbers', () => {
  const p = progressionFrom(input());
  assert.equal(p.level, 'entry');
  assert.equal(p.nextLevel, 'leadership');
  assert.equal(p.headline, 'Your next level: 12 of 14 sales this week; 9 of 21 lessons learned');
  assert.deepEqual(p.requirements.map((r) => r.key), ['sales', 'pack_learned', 'pack_taught']);
  const sales = p.requirements[0]!;
  assert.equal(sales.met, false);
  assert.equal(sales.options[0]!.detail, '12 of 14 sales this week');
  assert.equal(sales.options[0]!.current, 12);
  // this week has 12, last week 8: one qualifying week so far
  assert.equal(sales.options[1]!.current, 1);
  assert.equal(sales.options[1]!.detail, 'Last week 8, this week 12 of 12 sales');
  assert.equal(p.requirements[1]!.options[0]!.detail, '9 of 21 lessons learned');
  assert.equal(p.requirements[2]!.options[0]!.detail, '4 of 21 taught back and signed off');
  // a leader looking at the same person
  assert.equal(progressionFrom(input({ forSelf: false })).headline, 'Next level: 12 of 14 sales this week; 9 of 21 lessons learned');
});

test('entry: 14 in any week of the window meets the sales requirement', () => {
  const p = progressionFrom(input({ weeks: weeksOf(pad([3, 15, 6, 4])) }));
  const sales = p.requirements[0]!;
  assert.equal(sales.met, true);
  assert.equal(sales.options[0]!.met, true);
  assert.equal(sales.options[0]!.detail, 'Reached: 15 sales the week of 5 Oct');
  // headline moves on to the unmet pack requirements
  assert.equal(p.headline, 'Your next level: 9 of 21 lessons learned; 4 of 21 taught back');
  // this week reaching it says so
  const now = progressionFrom(input({ weeks: weeksOf(pad([3, 14])) }));
  assert.equal(now.requirements[0]!.options[0]!.detail, 'Reached: 14 sales this week');
});

test('entry: 12 two weeks in a row (consecutive only) meets the sales requirement', () => {
  const twoInARow = progressionFrom(input({ weeks: weeksOf(pad([12, 13, 5])) }));
  const opt = twoInARow.requirements[0]!.options[1]!;
  assert.equal(opt.met, true);
  assert.equal(opt.detail, 'Reached: 12 then 13 sales (weeks of 5 Oct and 12 Oct)');
  assert.equal(twoInARow.requirements[0]!.met, true);
  // 12, a gap, 12 is not "in a row"
  const gap = progressionFrom(input({ weeks: weeksOf(pad([12, 11, 12, 3])) }));
  assert.equal(gap.requirements[0]!.options[1]!.met, false);
  assert.equal(gap.requirements[0]!.met, false);
  assert.equal(gap.requirements[0]!.options[0]!.detail, '3 of 14 sales this week; best recent week 12');
});

test('entry: everything met → the step-up sentence', () => {
  const p = progressionFrom(input({ weeks: weeksOf(pad([14])), learned: 21, taught: 21 }));
  assert.ok(p.requirements.every((r) => r.met));
  assert.equal(p.headline, 'Every criterion for Leadership is met: time to talk about the step up.');
});

test('leadership: trained leaders from the team or the office count, personalities is a tick', () => {
  const p = progressionFrom(input({ position: 'team_leader', teamLeadersOnTeam: 1, milestones: { trained_leaders: 2 } }));
  assert.equal(p.level, 'leadership');
  assert.equal(p.nextLevel, 'campaign_manager');
  assert.deepEqual(p.requirements.map((r) => r.key), ['trained_leaders', 'personalities']);
  const trained = p.requirements[0]!;
  assert.equal(trained.met, false);
  assert.equal(trained.options[0]!.detail, '1 of 3 on the team are Team Leader or above');
  assert.equal(trained.options[1]!.manual, true);
  assert.equal(trained.options[1]!.detail, '2 of 3 confirmed by the office');
  assert.equal(p.requirements[1]!.options[0]!.detail, 'Not confirmed yet: the office ticks this one');
  assert.equal(p.headline, 'Your next level: 2 of 3 people trained to leadership; Prove you can train different personalities still to confirm');
  const done = progressionFrom(input({ position: 'team_leader', milestones: { trained_leaders: 3, trained_personalities: 1 } }));
  assert.ok(done.requirements.every((r) => r.met));
  assert.equal(done.headline, 'Every criterion for Campaign Manager is met: time to talk about the step up.');
});

test('campaign manager: team sales two weeks in a row from the team totals; manual ticks for the rest', () => {
  const team = pad([90, 104, 101, 70]);
  const p = progressionFrom(input({ position: 'crew_leader', weeks: weeksOf(pad([5, 6, 7, 2]), team), milestones: { consistency: 1 } }));
  assert.equal(p.level, 'campaign_manager');
  assert.deepEqual(p.requirements.map((r) => r.key), ['structure', 'team_sales', 'consistency']);
  const t = p.requirements[1]!;
  assert.equal(t.met, true);
  assert.equal(t.options[0]!.detail, 'Reached: 104 then 101 team sales (weeks of 5 Oct and 12 Oct)');
  assert.equal(p.requirements[2]!.met, true);
  assert.equal(p.headline, 'Your next level: 4 + 1 or 3 + 2 still to confirm');
  // data first in the headline, then the manual ones
  const short = progressionFrom(input({ position: 'crew_leader', weeks: weeksOf(pad([1, 2]), pad([88, 84])) }));
  assert.equal(short.headline, 'Your next level: 84 of 100 team sales this week; 4 + 1 or 3 + 2 still to confirm');
  assert.equal(short.requirements[1]!.options[0]!.detail, 'Last week 88, this week 84 of 100 team sales');
  // no team: never met, says so
  const noTeam = progressionFrom(input({ position: 'crew_leader' }));
  assert.equal(noTeam.requirements[1]!.options[0]!.detail, 'No team yet');
  assert.equal(noTeam.requirements[1]!.met, false);
});

test('senior levels are manual; recruiters and the top of the ladder', () => {
  const ad = progressionFrom(input({ position: 'assistant_owner', milestones: { team_profitable: 1 } }));
  assert.deepEqual(ad.requirements.map((r) => [r.key, r.met]), [['team_profitable', true], ['ready', false]]);
  assert.equal(ad.headline, "Your next level: You're ready still to confirm");
  const owner = progressionFrom(input({ position: 'owner' }));
  assert.equal(owner.nextLevel, 'promoting_owner');
  assert.deepEqual(owner.requirements.map((r) => r.key), ['mentored_office']);
  const rec = progressionFrom(input({ position: 'recruiter' }));
  assert.equal(rec.level, null);
  assert.equal(rec.nextLevel, null);
  assert.deepEqual(rec.requirements, []);
  assert.equal(rec.headline, 'Recruiters sit outside the field ladder; every lesson is still open to you.');
});

test('deterministic and never NaN / undefined in any sentence', () => {
  const a = progressionFrom(input());
  const b = progressionFrom(input());
  assert.deepEqual(a, b);
  for (const position of ['trainee', 'field_rep', 'team_leader', 'crew_leader', 'assistant_owner', 'owner', 'recruiter'] as const) {
    for (const weeks of [[], weeksOf(pad([0])), weeksOf(pad([20, 30]), pad([200, 210]))]) {
      const p = progressionFrom(input({ position, weeks }));
      const texts = [p.headline, ...p.requirements.flatMap((r) => [r.label, ...r.options.flatMap((o) => [o.label, o.detail])])];
      for (const t of texts) assert.ok(!/NaN|undefined|null/.test(t), `${position}: ${t}`);
    }
  }
});
