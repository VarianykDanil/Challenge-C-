/**
 * Release 1.2 — OWNED BY L1 learning-pack (laid down empty by r2-foundation).
 * Planned: learning_progress(user_id, lesson_key, learned_at, quiz_score, teachback_text, teachback_at,
 * taught_signed_off_by, taught_signed_off_at, PRIMARY KEY(user_id, lesson_key)) plus any table the progression
 * tracker needs (e.g. admin-ticked manual criteria), and demo progress in `seed`. Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'learning',
  sql: '',
  upgrade: () => [],
};
