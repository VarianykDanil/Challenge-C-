/**
 * Release 1.2 — OWNED BY L1 learning-pack (laid down by r2-foundation). Pure rules for the COD pack lessons and the
 * progression tracker: lesson keys, lesson state, quiz pass rule, career level from position, and the criteria for
 * the next level from weekly sales / team sales / lessons (the server gathers the numbers, this module judges them).
 */
import { LESSON_KEYS, type LessonKey } from '../types/learning.ts';

/** True for one of the 21 lesson keys (route params, stored rows). */
export function isLessonKey(value: unknown): value is LessonKey {
  return typeof value === 'string' && (LESSON_KEYS as readonly string[]).includes(value);
}
