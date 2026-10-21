/**
 * Release 1.2 — OWNED BY L1 learning-pack (laid down by r2-foundation). Pure rules for the COD pack lessons and the
 * progression tracker: lesson keys, lesson state, quiz pass rule, career level from position, and the criteria for
 * the next level from weekly sales / team sales / lessons (the server gathers the numbers, this module judges them).
 *
 * Copy style (docs/LOGIC.md §14.0): British English, specific numbers, kind; the same data gives the same sentence.
 */
import type { Position } from '../types.ts';
import {
  CAREER_LEVELS,
  LESSON_KEYS,
  type CareerLevel,
  type LessonGroup,
  type LessonKey,
  type LessonState,
  type Progression,
  type ProgressionCriterion,
  type ProgressionMilestoneKey,
  type ProgressionRequirement,
  type ProgressionWeek,
} from '../types/learning.ts';

/** True for one of the 21 lesson keys (route params, stored rows). */
export function isLessonKey(value: unknown): value is LessonKey {
  return typeof value === 'string' && (LESSON_KEYS as readonly string[]).includes(value);
}

/** Which block of the pack's leadership checklist each lesson sits in (the hub groups its cards by this). */
export const LESSON_GROUP_OF: Record<LessonKey, LessonGroup> = {
  'five-steps': 'fundamentals',
  'working-habits': 'fundamentals',
  'law-of-averages': 'fundamentals',
  'impulse-factors': 'fundamentals',
  'green-light-theory': 'in-the-field',
  'gumball-theory': 'in-the-field',
  'can-cant-controls': 'in-the-field',
  'buying-signs': 'in-the-field',
  'strategic-pause': 'in-the-field',
  'pre-emptive-strike': 'in-the-field',
  'bamboo-theory': 'attitude',
  'attitude-regain': 'attitude',
  'bullet-theory': 'objections',
  'straight-line-theory': 'objections',
  'core-principles': 'leadership',
  'progression-structure': 'leadership',
  'direct-indirect-marketing': 'leadership',
  'assuming-the-role': 'leadership',
  'theory-of-teachback': 'leadership',
  'run-an-impact': 'tasks',
  'go-on-a-roadtrip': 'tasks',
};

/** The practical checklist tasks: "learned" means done (one tick), the teach-back is "how it went". */
export function isTaskLesson(key: LessonKey): boolean {
  return LESSON_GROUP_OF[key] === 'tasks';
}

// The self-check's answer key and grading (the server grades the options picked): ./learningQuiz.ts.
export * from './learningQuiz.ts';

/** Limits the server enforces (and the client mirrors). */
export const LEARNING_LIMITS = {
  /** At most 10 answers in a self-check (the pack lessons have 3 questions; a practical task has none). */
  quizMaxQuestions: 10,
  /** Each answer is an option number from 0 to 9 (the lessons have 4 options per question). */
  quizMaxOptions: 10,
  /** A teach-back is at least a sentence and at most a page. */
  teachbackMinLength: 20,
  teachbackMaxLength: 4000,
  /** Manual milestone values (a count of people or offices, or a 0 / 1 tick). */
  milestoneMax: 99,
} as const;

/** The self-check passes only when every answer is right (and there was at least one question). */
export function quizPassed(score: number, total: number): boolean {
  return Number.isInteger(score) && Number.isInteger(total) && total >= 1 && score === total;
}

/**
 * Where someone is on one lesson: signed off → taught; a teach-back written → teachback_sent; the self-check passed →
 * learned; else new. A sign-off wins even without a written teach-back (the leader heard it in person), and the server
 * sets `learnedAt` when it signs off a lesson that was not learned yet, so Teach ✓ never shows with Learn ☐.
 */
export function lessonStateOf(row: { learnedAt: string | null; teachbackAt: string | null; taughtSignedOffAt: string | null } | null | undefined): LessonState {
  if (!row) return 'new';
  if (row.taughtSignedOffAt) return 'taught';
  if (row.teachbackAt) return 'teachback_sent';
  if (row.learnedAt) return 'learned';
  return 'new';
}

/** The fields of a lesson row the "how was it learned" rules read (a `LessonProgress` has them all). */
export interface LessonLearnedFacts {
  learnedAt: string | null;
  taughtSignedOffAt: string | null;
  teachbackAt?: string | null;
  quizPassedAt?: string | null;
  quizScore?: number | null;
  quizTotal?: number | null;
}

/**
 * True once the self-check has ever been passed: `quizPassedAt` is set by the first pass and never cleared, so a later
 * failed retake does not undo it. (For a row without the field, a passing last score counts too.)
 */
export function selfCheckPassed(row: LessonLearnedFacts | null | undefined): boolean {
  if (!row) return false;
  if (row.quizPassedAt) return true;
  return row.quizTotal != null && row.quizScore != null && quizPassed(row.quizScore, row.quizTotal);
}

/**
 * True when the lesson is learned but the self-check was never passed. A lesson is learned in one of two ways, the
 * self-check or an in-person sign-off, so this means a leader's sign-off counted it as learned.
 */
export function learnedBySignOff(row: LessonLearnedFacts | null | undefined): boolean {
  return Boolean(row?.learnedAt) && !selfCheckPassed(row);
}

/**
 * True when withdrawing the sign-off also takes "learned" away: the sign-off was the only reason it is learned
 * (`learnedAt` is the sign-off time, the self-check was never passed) and no teach-back has been written since. A
 * passed self-check (before or after the sign-off, whatever the last retake scored) keeps it learned, and so does a
 * written teach-back (it stays, waiting for a sign-off, and a teach-back always sits on a learned lesson).
 * server/src/routes/learning.ts applies the same rule in SQL.
 */
export function withdrawTakesBackLearned(row: LessonLearnedFacts | null | undefined): boolean {
  if (!row?.taughtSignedOffAt || row.learnedAt !== row.taughtSignedOffAt) return false;
  return !selfCheckPassed(row) && !row.teachbackAt;
}

// ───────────────────────────── Career ladder ─────────────────────────────

export const CAREER_LEVEL_LABELS: Record<CareerLevel, string> = {
  entry: 'Entry level',
  leadership: 'Leadership',
  campaign_manager: 'Campaign Manager',
  assistant_director: 'Assistant Director',
  senior_director: 'Senior Director',
  promoting_owner: 'Promoting Owner',
  regional_consultant: 'Regional Consultant',
  national_consultant: 'National Consultant',
};

/**
 * The pack's ladder level for a Linear Hub position. Trainees and field reps are entry level; a team leader is in
 * leadership; a crew leader manages the campaign; an assistant owner is an assistant director; an owner runs their
 * own office (senior director). Recruiters are office staff outside the field ladder (null).
 */
export function careerLevelFor(position: Position): CareerLevel | null {
  switch (position) {
    case 'trainee':
    case 'field_rep':
      return 'entry';
    case 'team_leader':
      return 'leadership';
    case 'crew_leader':
      return 'campaign_manager';
    case 'assistant_owner':
      return 'assistant_director';
    case 'owner':
      return 'senior_director';
    default:
      return null;
  }
}

export function nextCareerLevel(level: CareerLevel | null): CareerLevel | null {
  if (!level) return null;
  return CAREER_LEVELS[CAREER_LEVELS.indexOf(level) + 1] ?? null;
}

/** The thresholds behind the data-driven criteria (COD pack pages 18–19). */
export const PROGRESSION_RULES = {
  /** Mon–Sun weeks the tracker looks at, this week included (a quarter). */
  windowWeeks: 12,
  /** Entry → leadership: 14 sales in a week … */
  salesWeek: 14,
  /** … or 12 two weeks in a row. */
  salesTwoWeeks: 12,
  /** Leadership → campaign manager: 3 people trained from entry level to leadership. */
  trainedLeaders: 3,
  /** Campaign manager → assistant director: the team generates 100 sales two weeks in a row. */
  teamSalesTwoWeeks: 100,
} as const;

/** The admin-ticked conditions: label, target (1 = a tick) and the level they lead to. */
export const PROGRESSION_MILESTONES: Record<ProgressionMilestoneKey, { label: string; target: number; nextLevel: CareerLevel }> = {
  trained_leaders: { label: 'People trained to leadership, confirmed by the office', target: 3, nextLevel: 'campaign_manager' },
  trained_personalities: { label: 'Prove you can train different personalities', target: 1, nextLevel: 'campaign_manager' },
  four_plus_one: { label: '4 + 1 or 3 + 2', target: 1, nextLevel: 'assistant_director' },
  consistency: { label: 'Show consistency', target: 1, nextLevel: 'assistant_director' },
  team_profitable: { label: 'Team is profitable', target: 1, nextLevel: 'senior_director' },
  ready: { label: "You're ready", target: 1, nextLevel: 'senior_director' },
  mentored_office: { label: 'Coach and mentor someone from entry level to opening their own office', target: 1, nextLevel: 'promoting_owner' },
  first_gen_offices_4: { label: 'Coach and mentor 4 first-generation offices', target: 4, nextLevel: 'regional_consultant' },
  wire_50k: { label: 'As a collective, hit a £50,000 wire 4 weeks in a row', target: 1, nextLevel: 'regional_consultant' },
  first_gen_offices_7: { label: 'Coach and mentor 7 first-generation offices', target: 7, nextLevel: 'national_consultant' },
  wire_75k: { label: 'As a collective, hit a £75,000 wire 8 weeks in a row', target: 1, nextLevel: 'national_consultant' },
};

export function isProgressionMilestoneKey(value: unknown): value is ProgressionMilestoneKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROGRESSION_MILESTONES, value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "5 Oct" for 2026-10-05 (no leading zero, no year). */
export function dayMonthLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d ?? 1} ${MONTHS[(m ?? 1) - 1] ?? ''}`.trim();
}

export interface ProgressionInput {
  userId: number;
  userName: string;
  position: Position;
  /** The window's Mon–Sun weeks, oldest first; the last one is this week so far. */
  weeks: ProgressionWeek[];
  /** COD pack lessons learned / taught back and signed off, out of `total`. */
  learned: number;
  taught: number;
  total: number;
  /** The office's manual ticks and counts (missing = 0). */
  milestones: Partial<Record<ProgressionMilestoneKey, number>>;
  /** Active people on the person's team, other than them, at Team Leader or above (an approximation of "trained"). */
  teamLeadersOnTeam: number;
  /** Phrase the headline for the person themself ("Your next level…") or for a leader looking at them ("Next level…"). */
  forSelf: boolean;
}

interface TwoWeekRun {
  /** Index of the second week of the latest pair of consecutive weeks both at or above the threshold, else -1. */
  pairEnd: number;
  /** Consecutive qualifying weeks ending this week, or ending last week while this week is still short (0–2). */
  streak: number;
}

function twoWeekRun(values: number[], threshold: number): TwoWeekRun {
  let pairEnd = -1;
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i]! >= threshold && values[i - 1]! >= threshold) {
      pairEnd = i;
      break;
    }
  }
  const n = values.length;
  const at = (i: number) => (i >= 0 && i < n ? values[i]! : 0);
  let streak = 0;
  if (at(n - 1) >= threshold) streak = at(n - 2) >= threshold ? 2 : 1;
  else if (at(n - 2) >= threshold) streak = 1;
  return { pairEnd, streak };
}

function manualCriterion(key: ProgressionMilestoneKey, value: number, label?: string): ProgressionCriterion {
  const { target, label: defaultLabel } = PROGRESSION_MILESTONES[key];
  const v = Math.max(0, Math.floor(value || 0));
  const met = v >= target;
  const detail = target === 1
    ? met ? 'Confirmed by the office' : 'Not confirmed yet: the office ticks this one'
    : `${v} of ${target} confirmed by the office`;
  return { key, label: label ?? defaultLabel, met, current: v, target, detail, manual: true };
}

function requirement(key: string, label: string, options: ProgressionCriterion[]): ProgressionRequirement {
  return { key, label, met: options.some((o) => o.met), options };
}

/** "the week of 5 Oct", or "this week" for the window's last week. */
function weekPhrase(weeks: ProgressionWeek[], i: number): string {
  return i === weeks.length - 1 ? 'this week' : `the week of ${dayMonthLabel(weeks[i]!.weekStart)}`;
}

function salesWeekCriterion(weeks: ProgressionWeek[]): ProgressionCriterion {
  const target = PROGRESSION_RULES.salesWeek;
  const sales = weeks.map((w) => w.sales);
  const thisWeek = sales.at(-1) ?? 0;
  let bestIdx = -1;
  for (let i = 0; i < sales.length; i++) if (bestIdx < 0 || sales[i]! > sales[bestIdx]!) bestIdx = i;
  const best = bestIdx >= 0 ? sales[bestIdx]! : 0;
  const met = best >= target;
  let detail: string;
  if (met) detail = `Reached: ${best} sales ${weekPhrase(weeks, bestIdx)}`;
  else detail = `${thisWeek} of ${target} sales this week${best > thisWeek ? `; best recent week ${best}` : ''}`;
  return { key: 'sales_week', label: `${target} sales in a week`, met, current: thisWeek, target, detail };
}

function twoWeekCriterion(
  key: string,
  label: string,
  weeks: ProgressionWeek[],
  values: number[],
  threshold: number,
  noun: string,
): ProgressionCriterion {
  const run = twoWeekRun(values, threshold);
  const met = run.pairEnd >= 0;
  const thisWeek = values.at(-1) ?? 0;
  const lastWeek = values.length >= 2 ? values.at(-2)! : 0;
  let detail: string;
  if (met) {
    const a = values[run.pairEnd - 1]!;
    const b = values[run.pairEnd]!;
    detail = `Reached: ${a} then ${b} ${noun} (weeks of ${dayMonthLabel(weeks[run.pairEnd - 1]!.weekStart)} and ${dayMonthLabel(weeks[run.pairEnd]!.weekStart)})`;
  } else {
    detail = `Last week ${lastWeek}, this week ${thisWeek} of ${threshold} ${noun}`;
  }
  return { key, label, met, current: run.streak, target: 2, detail };
}

/** The short phrase a requirement contributes to the headline while it is not met. */
function headlinePart(req: ProgressionRequirement, input: ProgressionInput): string {
  const thisWeek = input.weeks.at(-1);
  switch (req.key) {
    case 'sales':
      return `${thisWeek?.sales ?? 0} of ${PROGRESSION_RULES.salesWeek} sales this week`;
    case 'pack_learned':
      return `${input.learned} of ${input.total} lessons learned`;
    case 'pack_taught':
      return `${input.taught} of ${input.total} taught back`;
    case 'trained_leaders': {
      const n = Math.max(...req.options.map((o) => o.current ?? 0));
      return `${n} of ${PROGRESSION_RULES.trainedLeaders} people trained to leadership`;
    }
    case 'team_sales':
      return thisWeek?.teamSales == null ? 'no team yet' : `${thisWeek.teamSales} of ${PROGRESSION_RULES.teamSalesTwoWeeks} team sales this week`;
    default:
      return `${req.label} still to confirm`;
  }
}

/**
 * The person's level (from their position), the next level and what it needs, judged from real numbers. A requirement
 * is met when any of its options is; the next level needs every requirement. Data-driven requirements come first in the
 * headline, then the ones the office ticks; at most two phrases.
 */
export function progressionFrom(input: ProgressionInput): Progression {
  const level = careerLevelFor(input.position);
  const nextLevel = nextCareerLevel(level);
  const base = {
    userId: input.userId,
    userName: input.userName,
    position: input.position,
    level,
    nextLevel,
    weeks: input.weeks,
    learned: input.learned,
    taught: input.taught,
    total: input.total,
    enabled: true,
  };
  const m = (k: ProgressionMilestoneKey) => input.milestones[k] ?? 0;
  const requirements: ProgressionRequirement[] = [];

  switch (level) {
    case 'entry': {
      const sales = input.weeks.map((w) => w.sales);
      requirements.push(
        requirement('sales', `${PROGRESSION_RULES.salesWeek} sales in a week, or ${PROGRESSION_RULES.salesTwoWeeks} two weeks in a row`, [
          salesWeekCriterion(input.weeks),
          twoWeekCriterion('sales_two_weeks', `${PROGRESSION_RULES.salesTwoWeeks} sales two weeks in a row`, input.weeks, sales, PROGRESSION_RULES.salesTwoWeeks, 'sales'),
        ]),
        requirement('pack_learned', 'Learn the COD pack', [
          { key: 'pack_learned', label: 'Lessons learned', met: input.total > 0 && input.learned >= input.total, current: input.learned, target: input.total, detail: `${input.learned} of ${input.total} lessons learned` },
        ]),
        requirement('pack_taught', 'Teach the COD pack back', [
          { key: 'pack_taught', label: 'Lessons taught back', met: input.total > 0 && input.taught >= input.total, current: input.taught, target: input.total, detail: `${input.taught} of ${input.total} taught back and signed off` },
        ]),
      );
      break;
    }
    case 'leadership': {
      const target = PROGRESSION_RULES.trainedLeaders;
      const onTeam = Math.max(0, input.teamLeadersOnTeam);
      requirements.push(
        requirement('trained_leaders', `Teach and train ${target} people from entry level to leadership`, [
          { key: 'trained_leaders_team', label: 'On your team now', met: onTeam >= target, current: onTeam, target, detail: `${onTeam} of ${target} on the team are Team Leader or above` },
          manualCriterion('trained_leaders', m('trained_leaders'), 'Confirmed by the office'),
        ]),
        requirement('personalities', PROGRESSION_MILESTONES.trained_personalities.label, [manualCriterion('trained_personalities', m('trained_personalities'))]),
      );
      break;
    }
    case 'campaign_manager': {
      const hasTeam = input.weeks.length > 0 && input.weeks.every((w) => w.teamSales !== null);
      const teamSales = input.weeks.map((w) => w.teamSales ?? 0);
      const t = PROGRESSION_RULES.teamSalesTwoWeeks;
      const teamOption: ProgressionCriterion = hasTeam
        ? twoWeekCriterion('team_sales_two_weeks', `${t} team sales two weeks in a row`, input.weeks, teamSales, t, 'team sales')
        : { key: 'team_sales_two_weeks', label: `${t} team sales two weeks in a row`, met: false, current: null, target: 2, detail: 'No team yet' };
      requirements.push(
        requirement('structure', PROGRESSION_MILESTONES.four_plus_one.label, [manualCriterion('four_plus_one', m('four_plus_one'))]),
        requirement('team_sales', `Team generates ${t} sales two weeks in a row`, [teamOption]),
        requirement('consistency', PROGRESSION_MILESTONES.consistency.label, [manualCriterion('consistency', m('consistency'))]),
      );
      break;
    }
    case 'assistant_director':
      requirements.push(
        requirement('team_profitable', PROGRESSION_MILESTONES.team_profitable.label, [manualCriterion('team_profitable', m('team_profitable'))]),
        requirement('ready', PROGRESSION_MILESTONES.ready.label, [manualCriterion('ready', m('ready'))]),
      );
      break;
    case 'senior_director':
      requirements.push(requirement('mentored_office', PROGRESSION_MILESTONES.mentored_office.label, [manualCriterion('mentored_office', m('mentored_office'))]));
      break;
    case 'promoting_owner':
      requirements.push(
        requirement('first_gen_offices_4', PROGRESSION_MILESTONES.first_gen_offices_4.label, [manualCriterion('first_gen_offices_4', m('first_gen_offices_4'))]),
        requirement('wire_50k', PROGRESSION_MILESTONES.wire_50k.label, [manualCriterion('wire_50k', m('wire_50k'))]),
      );
      break;
    case 'regional_consultant':
      requirements.push(
        requirement('first_gen_offices_7', PROGRESSION_MILESTONES.first_gen_offices_7.label, [manualCriterion('first_gen_offices_7', m('first_gen_offices_7'))]),
        requirement('wire_75k', PROGRESSION_MILESTONES.wire_75k.label, [manualCriterion('wire_75k', m('wire_75k'))]),
      );
      break;
    default:
      break;
  }

  let headline: string;
  if (!level) headline = 'Recruiters sit outside the field ladder; every lesson is still open to you.';
  else if (!nextLevel) headline = `${input.forSelf ? "You're" : 'They are'} at the top of the ladder: ${CAREER_LEVEL_LABELS[level]}.`;
  else {
    const unmet = requirements.filter((r) => !r.met);
    if (unmet.length === 0) headline = `Every criterion for ${CAREER_LEVEL_LABELS[nextLevel]} is met: time to talk about the step up.`;
    else {
      const isManual = (r: ProgressionRequirement) => r.options.every((o) => o.manual);
      const ordered = [...unmet.filter((r) => !isManual(r)), ...unmet.filter(isManual)];
      const parts = ordered.slice(0, 2).map((r) => headlinePart(r, input));
      headline = `${input.forSelf ? 'Your next level' : 'Next level'}: ${parts.join('; ')}`;
    }
  }
  return { ...base, requirements, headline };
}
