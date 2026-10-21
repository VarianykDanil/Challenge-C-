/**
 * Release 1.3 — OWNED BY P7 recruitment-plus (laid down by r3-foundation: tables and the column are the contract; P7
 * seeds the default question set — plain, lawful questions only — in BOTH `upgrade` (existing databases, guarded with
 * a meta flag, INSERT OR IGNORE) and `seed`, and adds further columns with addColumnIfMissing).
 *
 *  - candidates.date_of_birth: YYYY-MM-DD or NULL (the profile shows the age and an "Under 18" warning).
 *  - interview_questions: the bank per interview type ('phone' | 'first' | 'observation' | 'final'), optionally per
 *    position, ordered (sort), active / inactive (Settings → Recruitment).
 *  - interview_answers: the questions AS ASKED (question_text copied when the sheet is first opened) with the
 *    interviewer's written answer and an optional 1–5 score; later edits to the bank never change a past interview.
 *  - interview_changes: interviewer reassignments and reschedules (field, from, to, who, when), written by P7's
 *    PATCH /recruitment/interviews/:id. "Who handled each stage" is stage_changes.changed_by_id (already recorded).
 * Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';
import { addColumnIfMissing } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS interview_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_type TEXT NOT NULL,
  position TEXT,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_interview_questions_type ON interview_questions(interview_type, sort);

CREATE TABLE IF NOT EXISTS interview_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES interview_questions(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  answer TEXT NOT NULL DEFAULT '',
  score INTEGER,
  updated_at TEXT,
  updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_interview_answers_interview ON interview_answers(interview_id, sort);

CREATE TABLE IF NOT EXISTS interview_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  changed_by INTEGER,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_changes_interview ON interview_changes(interview_id, changed_at);
`;

export const extension: DbExtension = {
  name: 'recruitment',
  sql: SQL,
  upgrade(db) {
    return [addColumnIfMissing(db, 'candidates', 'date_of_birth', 'TEXT')].filter((name): name is string => name !== null);
  },
};
