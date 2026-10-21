/**
 * Release 1.2 — L1 learning-pack contracts (laid down by r2-foundation; OWNED BY L1, which may add fields and types).
 * STABLE for other packages: `LESSON_KEYS` / `LessonKey` (L2's annotation chips link to /learning/pack/:lessonKey) and
 * the anchors listed on `LESSON_ANCHORS`. Never rename or remove a key; add new ones at the end.
 *
 * Role scoping (server): a rep sees only their own progress; a leader their own team's; admin everyone; a recruiter
 * their own progress and the lessons (no team view). Teach-back text is visible to the person, their team leader and
 * admins only.
 */
import type { Position } from '../types.ts';

/**
 * One lesson per COD pack topic, in the order of the pack's leadership checklist (21). Some checklist rows share a
 * lesson: "ABC days" → gumball-theory, "Attitude muscle" → attitude-regain, "Pre-management criteria" and
 * "Post-management criteria" → progression-structure. run-an-impact and go-on-a-roadtrip are practical tasks on the
 * checklist that the pack lists but does not describe: the lesson asks the person to check with their leader.
 */
export const LESSON_KEYS = [
  'five-steps',
  'working-habits',
  'law-of-averages',
  'impulse-factors',
  'green-light-theory',
  'gumball-theory',
  'can-cant-controls',
  'buying-signs',
  'strategic-pause',
  'bamboo-theory',
  'pre-emptive-strike',
  'attitude-regain',
  'bullet-theory',
  'straight-line-theory',
  'core-principles',
  'progression-structure',
  'direct-indirect-marketing',
  'assuming-the-role',
  'theory-of-teachback',
  'run-an-impact',
  'go-on-a-roadtrip',
] as const;
export type LessonKey = (typeof LESSON_KEYS)[number];

/**
 * Section anchors a lesson page renders as element ids, so a link like /learning/pack/impulse-factors#greed lands on
 * the right part (L2's annotation chips use them). L1 may add anchors; these must exist.
 */
export const LESSON_ANCHORS = {
  'five-steps': ['introduction', 'short-story', 'presentation', 'close', 'consolidation'],
  'impulse-factors': ['greed', 'indifference', 'fear-of-loss', 'group-effect', 'urgency', 'power-of-suggestion'],
  'bullet-theory': ['no-money', 'no-time', 'other-charities', 'bank-details', 'direct-debit', 'cows', 'air', 'feel-felt-found', 'rrr'],
  'straight-line-theory': ['form', 'two-to-one'],
} as const satisfies Partial<Record<LessonKey, readonly string[]>>;

/** How the hub groups the lesson cards (L1 decides the mapping from LessonKey to group). */
export type LessonGroup = 'fundamentals' | 'in-the-field' | 'objections' | 'attitude' | 'leadership' | 'tasks';

/** The hub's group order (the pack's checklist blocks, top to bottom; the practical tasks last). */
export const LESSON_GROUPS: LessonGroup[] = ['fundamentals', 'in-the-field', 'attitude', 'objections', 'leadership', 'tasks'];

/** Where one person is on one lesson. */
export type LessonState = 'new' | 'learned' | 'teachback_sent' | 'taught';

/** One row of learning_progress for one person and lesson (all null when they have not started it). */
export interface LessonProgress {
  lessonKey: LessonKey;
  /** Set when the self-check first passed (every answer right), or by a sign-off of a lesson not yet learned. */
  learnedAt: string | null;
  /** The last self-check score (right answers) and how many questions it had. */
  quizScore: number | null;
  quizTotal?: number | null;
  /**
   * When the self-check was first passed (every answer right; a task: ticked as done). A later retake never clears it,
   * so it says whether the self-check was ever passed even when the last score is a miss. null when it has not been
   * passed (the lesson can still be learned through a sign-off). New in 1.2, optional.
   */
  quizPassedAt?: string | null;
  /** The person's own words; only the person, their team leader and admins ever receive it (else null). */
  teachbackText: string | null;
  teachbackAt: string | null;
  /** The leader or admin who signed the teach-back off ("taught"). */
  taughtSignedOffBy: number | null;
  taughtSignedOffByName?: string | null;
  taughtSignedOffAt: string | null;
  state: LessonState;
}

/** GET /learning/progress[?userId=] — one person's progress, one row per LESSON_KEYS entry in that order. */
export interface LearningProgress {
  userId: number;
  userName: string;
  lessons: LessonProgress[];
  learned: number;
  taught: number;
  /** LESSON_KEYS.length */
  total: number;
}

/**
 * POST /learning/progress/:lessonKey/quiz — the option picked for each question (0-based, in question order); the
 * server grades them against the answer key (shared/src/logic/learningQuiz.ts). A practical task sends `[]` to tick it
 * as done. A body with only `score` / `total` is refused (400): the score is never taken from the phone.
 */
export interface LessonQuizInput {
  answers: number[];
}

/** The graded self-check; learned on the first pass (every answer right). */
export interface LessonQuizResult {
  passed: boolean;
  progress: LessonProgress;
  /** Right answers and questions (a task ticked as done: 1 of 1). */
  score?: number;
  total?: number;
  /** One entry per question: whether the option picked was right. Never says which option is right. */
  correct?: boolean[];
}

/** POST /learning/progress/:lessonKey/teachback — "write the theory in your own words" (saved for the leader). */
export interface TeachbackInput {
  text: string;
}

/** POST /learning/progress/:userId/:lessonKey/signoff — the leader of that person's team, or an admin. */
export interface TeachbackSignoffInput {
  /** false withdraws a sign-off. Default true. */
  signedOff?: boolean;
}

/**
 * The sign-off's answer: the lesson as it now stands. An in-person sign-off also counts as learned: when the lesson
 * was not learned yet, the server sets `learnedAt` to the sign-off time and says so with `markedLearned: true`.
 */
export interface TeachbackSignoffResult extends LessonProgress {
  markedLearned?: boolean;
}

/** One person on the checklist page (GET /learning/team). */
export interface TeamLearningRow {
  userId: number;
  userName: string;
  position: Position;
  avatarColor: string;
  teamId: number | null;
  teamName: string | null;
  learned: number;
  taught: number;
  /** Teach-backs written and waiting for a sign-off. */
  awaitingSignOff: number;
  lessons: Pick<LessonProgress, 'lessonKey' | 'learnedAt' | 'teachbackAt' | 'taughtSignedOffAt' | 'state'>[];
}

/** One teach-back written and waiting for a sign-off (the checklist page's queue for leaders and admins). */
export interface TeachbackAwaiting {
  userId: number;
  userName: string;
  avatarColor: string;
  lessonKey: LessonKey;
  /** The person's own words (null when they asked for an in-person sign-off without writing one). */
  teachbackText: string | null;
  teachbackAt: string;
}

/** GET /learning/team — leader: own team; admin: everyone active; rep / recruiter: 403. */
export interface TeamLearning {
  rows: TeamLearningRow[];
  /** LESSON_KEYS.length */
  total: number;
  /** L1: teach-backs waiting for a sign-off from this viewer (never the viewer's own), newest first. */
  pending?: TeachbackAwaiting[];
}

/** The pack's career ladder (pre-management structure, then post-management). */
export type CareerLevel =
  | 'entry'
  | 'leadership'
  | 'campaign_manager'
  | 'assistant_director'
  | 'senior_director'
  | 'promoting_owner'
  | 'regional_consultant'
  | 'national_consultant';

export const CAREER_LEVELS: CareerLevel[] = [
  'entry',
  'leadership',
  'campaign_manager',
  'assistant_director',
  'senior_director',
  'promoting_owner',
  'regional_consultant',
  'national_consultant',
];

/** One measurable condition for the next level, with real numbers. */
export interface ProgressionCriterion {
  /** e.g. 'sales_week', 'sales_two_weeks', 'pack_learned', 'pack_taught', 'trained_leaders', 'team_sales_two_weeks', 'four_plus_one'. */
  key: string;
  /** e.g. "14 sales in a week". */
  label: string;
  met: boolean;
  current: number | null;
  target: number | null;
  /** e.g. "12 of 14 sales this week". */
  detail: string;
  /** True for a condition the admin ticks by hand (no data behind it). */
  manual?: boolean;
}

/**
 * Conditions the office ticks by hand (no data behind them): PUT /learning/milestones/:userId/:key (admin). The value
 * is a count for the "N people / offices" ones and 0 / 1 for the rest (targets in PROGRESSION_MILESTONES, shared logic).
 */
export type ProgressionMilestoneKey =
  | 'trained_leaders'
  | 'trained_personalities'
  | 'four_plus_one'
  | 'consistency'
  | 'team_profitable'
  | 'ready'
  | 'mentored_office'
  | 'first_gen_offices_4'
  | 'wire_50k'
  | 'first_gen_offices_7'
  | 'wire_75k';

export const PROGRESSION_MILESTONE_KEYS: ProgressionMilestoneKey[] = [
  'trained_leaders',
  'trained_personalities',
  'four_plus_one',
  'consistency',
  'team_profitable',
  'ready',
  'mentored_office',
  'first_gen_offices_4',
  'wire_50k',
  'first_gen_offices_7',
  'wire_75k',
];

/** PUT /learning/milestones/:userId/:key — admin only; answers the updated Progression. */
export interface ProgressionMilestoneInput {
  /** Whole number 0–99 (a tick is 1, an untick 0). */
  value: number;
}

/** One Mon–Sun week of the tracker's window: oldest first, the last one is this week so far (zero-filled). */
export interface ProgressionWeek {
  weekStart: string;
  /** The person's own logged sales that week. */
  sales: number;
  /** Sales logged by everyone on the person's current team (them included); null when they have no team. */
  teamSales: number | null;
}

/** A requirement is met when ANY of its options is (e.g. 14 sales in a week OR 12 two weeks running). */
export interface ProgressionRequirement {
  key: string;
  label: string;
  met: boolean;
  options: ProgressionCriterion[];
}

/** GET /learning/progression/:userId — where someone is on the ladder and what the next level needs. */
export interface Progression {
  userId: number;
  userName: string;
  position: Position;
  /** null for people outside the field ladder (recruiters). */
  level: CareerLevel | null;
  nextLevel: CareerLevel | null;
  /** All must be met to reach `nextLevel`. */
  requirements: ProgressionRequirement[];
  /** One sentence for the dashboard card, e.g. "Your next level: 12 of 14 sales this week; 9 of 21 lessons learned". */
  headline: string;
  /** L1: the weeks behind the sales criteria (PROGRESSION_RULES.windowWeeks, oldest first, this week last). */
  weeks?: ProgressionWeek[];
  /** L1: the person's COD pack counts (as GET /learning/progress). */
  learned?: number;
  taught?: number;
  total?: number;
  /** L1: false while the smart kill switch is on (LM_SMART=0): requirements [], weeks [], headline ''. */
  enabled?: boolean;
}
