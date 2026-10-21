// Release 1.2 — L1 learning-pack: the COD pack as typed lessons, in the order of the pack's leadership checklist.
// OWNED BY L1. Pages: /learning (hub), /learning/pack/:lessonKey, /learning/progress.
import { LESSON_GROUP_OF, LESSON_GROUPS, LESSON_KEYS, type LessonGroup, type LessonKey, type LessonState } from '@lm/shared';
import { ATTITUDE_REGAIN, BAMBOO, BUYING_SIGNS, CAN_CANT, GREEN_LIGHT, GUMBALL, PRE_EMPTIVE_STRIKE, STRATEGIC_PAUSE } from './field.ts';
import { FIVE_STEPS, IMPULSE_FACTORS, LAW_OF_AVERAGES, WORKING_HABITS } from './fundamentals.ts';
import {
  ASSUMING_THE_ROLE,
  CORE_PRINCIPLES,
  DIRECT_INDIRECT,
  GO_ON_A_ROADTRIP,
  PROGRESSION_STRUCTURE,
  RUN_AN_IMPACT,
  THEORY_OF_TEACHBACK,
} from './leadership.ts';
import { BULLET_THEORY, STRAIGHT_LINE } from './objections.ts';
import type { Lesson } from './types.ts';

export type { Lesson, LessonBlock, LessonCard, LessonImage, LessonSection, LadderLevel, QuizQuestion, Rich } from './types.ts';
export { IMAGES } from './images.ts';
export { CAREER_LADDER } from './leadership.ts';
export { BULLET_OBJECTIONS } from './objections.ts';

export const LESSONS: Record<LessonKey, Lesson> = {
  'five-steps': FIVE_STEPS,
  'working-habits': WORKING_HABITS,
  'law-of-averages': LAW_OF_AVERAGES,
  'impulse-factors': IMPULSE_FACTORS,
  'green-light-theory': GREEN_LIGHT,
  'gumball-theory': GUMBALL,
  'can-cant-controls': CAN_CANT,
  'buying-signs': BUYING_SIGNS,
  'strategic-pause': STRATEGIC_PAUSE,
  'bamboo-theory': BAMBOO,
  'pre-emptive-strike': PRE_EMPTIVE_STRIKE,
  'attitude-regain': ATTITUDE_REGAIN,
  'bullet-theory': BULLET_THEORY,
  'straight-line-theory': STRAIGHT_LINE,
  'core-principles': CORE_PRINCIPLES,
  'progression-structure': PROGRESSION_STRUCTURE,
  'direct-indirect-marketing': DIRECT_INDIRECT,
  'assuming-the-role': ASSUMING_THE_ROLE,
  'theory-of-teachback': THEORY_OF_TEACHBACK,
  'run-an-impact': RUN_AN_IMPACT,
  'go-on-a-roadtrip': GO_ON_A_ROADTRIP,
};

/** Every lesson in checklist order. */
export const LESSON_LIST: Lesson[] = LESSON_KEYS.map((k) => LESSONS[k]);

export const GROUP_COPY: Record<LessonGroup, { title: string; description: string }> = {
  fundamentals: { title: 'The fundamentals', description: 'Master these first: they are what entry level is built on.' },
  'in-the-field': { title: 'In the field', description: 'Reading people and working the day, stop by stop.' },
  attitude: { title: 'Attitude', description: 'Keeping it, growing it and getting it back.' },
  objections: { title: 'Objections and rapport', description: 'Handling the six objections and staying on the line.' },
  leadership: { title: 'Leadership', description: 'How the business works and how to grow into the next role.' },
  tasks: { title: 'On the checklist: tasks', description: 'Practical tasks your leader ticks off once you have done them.' },
};

/** Lessons grouped for the hub, groups in LESSON_GROUPS order. */
export function lessonsByGroup(list: Lesson[] = LESSON_LIST): { group: LessonGroup; lessons: Lesson[] }[] {
  return LESSON_GROUPS.map((group) => ({ group, lessons: list.filter((l) => LESSON_GROUP_OF[l.key] === group) })).filter((g) => g.lessons.length > 0);
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[’'`]/g, "'").replace(/[^a-z0-9'%:£ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Every searchable word of a lesson (title, summary, key points, keywords, section titles, checklist rows). */
function haystack(l: Lesson): string {
  return norm([l.title, l.short, l.summary, ...l.keyPoints, ...(l.keywords ?? []), ...l.checklist, ...l.sections.map((s) => s.title ?? '')].join(' '));
}
const HAYSTACKS = new Map<LessonKey, string>(LESSON_LIST.map((l) => [l.key, haystack(l)]));

/** Lessons matching every word of `query` (case and punctuation ignored); all of them for an empty query. */
export function searchLessons(query: string): Lesson[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return LESSON_LIST;
  return LESSON_LIST.filter((l) => {
    const h = HAYSTACKS.get(l.key)!;
    return words.every((w) => h.includes(w));
  });
}

export const STATE_COPY: Record<LessonState, { label: string; tone: 'neutral' | 'primary' | 'warning' | 'success' }> = {
  new: { label: 'Not started', tone: 'neutral' },
  learned: { label: 'Learned', tone: 'primary' },
  teachback_sent: { label: 'Teach-back sent', tone: 'warning' },
  taught: { label: 'Taught', tone: 'success' },
};

/** What a task's state reads as ("Done" rather than "Learned"). */
export function stateLabel(state: LessonState, task?: boolean): string {
  if (task && state === 'learned') return 'Done';
  if (task && state === 'teachback_sent') return 'Sent to your leader';
  return STATE_COPY[state].label;
}

/** Field card: the 5 steps on one phone screen. */
export const FIELD_STEPS = [
  { anchor: 'introduction', title: 'Introduction', time: '7–10 s', line: 'Smile, eye contact, excitement. Be 10% more excited.' },
  { anchor: 'short-story', title: 'Short story', time: '10–15 s', line: 'Who? What? Why? Answer the 3 W’s. Keep it short and simple.' },
  { anchor: 'presentation', title: 'Presentation', time: null, line: 'Create the problem, be the solution. Pauses, buzzwords, past tense, group effect.' },
  { anchor: 'close', title: 'Close', time: null, line: 'Assumptive yes / no at the height of impulse. Stand still, no dead air.' },
  { anchor: 'consolidation', title: 'Consolidation', time: null, line: 'Why they signed up, feel-good factors, pre-empt the welcome call, at least 2 years.' },
] as const;

/** Field card: the six objections and the overturn for each, one phone screen. */
export const FIELD_OBJECTIONS = [
  { anchor: 'no-money', title: 'No money', line: 'AIR: acknowledge, ignore, resume (stop → short story).' },
  { anchor: 'no-time', title: 'No time', line: '“Short version” · “I’ll keep it short for you” · “Takes 30 seconds” · “On the last page now”.' },
  { anchor: 'other-charities', title: 'Other charities', line: 'Feel, felt, found (pres → tab): “…however, when they found out…”' },
  { anchor: 'bank-details', title: 'Bank details', line: 'Prevent it: eye contact, rapport. “Data protected”, “non-sensitive”.' },
  { anchor: 'cows', title: 'C.O.W.S', line: '“I’m sure your partner is just as lovely as yourself…” → close!' },
  { anchor: 'direct-debit', title: 'Direct debit', line: 'Your campaign’s overturn (ask your leader), then close.' },
] as const;
