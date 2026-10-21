/**
 * Release 1.2 (UI fix group UC) — every COD pack lesson's title by its key, for words the server writes itself
 * (audit summaries: "Learned “Pre-emptive strike”: self-check passed"). The lessons themselves live in
 * client/src/content/learning and stay the source: lessonTitles.test.ts loads them and fails when a title here differs
 * from the lesson's own `title`, so change both together.
 */
import type { LessonKey } from '../types/learning.ts';

export const LESSON_TITLES: Readonly<Record<LessonKey, string>> = {
  'five-steps': '5 steps to a conversation',
  'working-habits': '8 working habits',
  'law-of-averages': 'Law of averages',
  'impulse-factors': '6 impulse factors (GIFGUP)',
  'green-light-theory': 'Green light theory',
  'gumball-theory': 'Gumball theory and ABC days',
  'can-cant-controls': 'Can and can’t controls',
  'buying-signs': 'Buying and non-buying signs',
  'strategic-pause': 'Strategic pause',
  'bamboo-theory': 'Bamboo theory',
  'pre-emptive-strike': 'Pre-emptive strike',
  'attitude-regain': 'Attitude regain theory',
  'bullet-theory': 'Bullet theory',
  'straight-line-theory': 'Straight line theory',
  'core-principles': '3 core principles',
  'progression-structure': 'Pre- and post-management progression structure',
  'direct-indirect-marketing': 'Direct vs indirect marketing',
  'assuming-the-role': 'Assuming the role',
  'theory-of-teachback': 'Theory of teachback',
  'run-an-impact': 'Run an impact',
  'go-on-a-roadtrip': 'Go on a roadtrip',
};

/** The lesson's title, or null for a key that is not one of the lessons (an old or mistyped key). */
export function lessonTitle(key: unknown): string | null {
  return typeof key === 'string' && Object.hasOwn(LESSON_TITLES, key) ? LESSON_TITLES[key as LessonKey] : null;
}
