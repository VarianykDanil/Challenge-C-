/**
 * Release 1.3 — OWNED BY P7 recruitment-plus. This package's audit specs, in the shape of lib/auditSpecs.ts
 * (AuditRouteSpec: method, pattern, before, after → AuditDraft[]), registered through ./registry.ts (P9 owns the
 * registry; this file is the only one this package edits for audit):
 *
 *   POST  /recruitment/questions              "Added a phone screen question: “When could you start?”"
 *   PATCH /recruitment/questions/:id          "Edited a first interview question: text" · "Turned off a phone screen
 *                                             question: “…”" (a save of the same values writes nothing)
 *   PUT   /recruitment/questions/order        "Reordered the phone screen questions" (the same order writes nothing)
 *   PUT   /recruitment/interviews/:id/answers "Started / Updated the first interview sheet for Sam Brown: 4 of 6
 *                                             answered" — filed under the candidate, like every interview row; the
 *                                             snapshot holds the questions as asked, the answers and scores; an
 *                                             identical autosave writes nothing
 *   POST  /recruitment/candidates,
 *   PATCH /recruitment/candidates/:id         refined from the 1.2 specs (lib/auditSpecs.ts, P9's): the same rows and
 *                                             wording, plus the date of birth this package added, so a change to it is
 *                                             explained ("Updated candidate Sam Brown: date of birth set to 12 Mar 2001")
 *                                             instead of "(no changes)". When the date of birth did not change, the
 *                                             1.2 rows are passed through untouched. If a 1.2 spec is ever not found,
 *                                             only this refinement is lost (a warning at start-up), never the server.
 * The 1.2 specs of POST / PATCH /recruitment/interviews stay as they are (the interview snapshot already holds the
 * interviewer, time, type and outcome); interview_changes is the candidate page's own record of them.
 * Snapshots never include PINs, passwords, app passwords, secrets, tokens or codes (lib/audit.ts redacts again).
 */
import { AUDIT_DIFF_SKIPPED, INTERVIEW_TYPE_NAMES, auditChangeText, auditDiff, sheetSummary, type AuditFieldChange, type InterviewType } from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import { AUDIT_ROUTES, type AuditCall, type AuditDone, type AuditDraft, type AuditRouteSpec } from '../auditSpecs.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const paramId = (call: AuditCall) => toId(call.params.id);
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});
const bodyOf = (call: AuditCall): Record<string, unknown> => (isRecord(call.body) ? call.body : {});
const typeWord = (t: unknown) => (INTERVIEW_TYPE_NAMES[t as InterviewType] ?? 'interview').toLowerCase();
const quoted = (text: unknown) => {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  return `“${flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat}”`;
};
const changes = (diff: AuditFieldChange[], skip: readonly string[] = []) => auditChangeText(diff, { skip: [...skip, ...AUDIT_DIFF_SKIPPED], max: 3 });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2001-03-12" → "12 Mar 2001" (the trail's own day label leaves the year out, which a date of birth needs). */
export function fullDateLabel(date: unknown): string {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
}

// ───────────────────────────── snapshots ─────────────────────────────

export function questionSnapshot(db: Db, id: number): Snap | null {
  const row = get<Snap>(db, `SELECT id, interview_type AS interviewType, position, text, sort, active FROM interview_questions WHERE id = ?`, [id]);
  return row ? { ...row, active: row.active === 1 || row.active === true } : null;
}

function questionOrder(db: Db, type: unknown): string[] {
  if (typeof type !== 'string') return [];
  return all<{ text: string }>(db, `SELECT text FROM interview_questions WHERE interview_type = ? ORDER BY sort, id`, [type]).map((r) => r.text);
}

/** One interview's sheet as the trail keeps it: the candidate, the interview, and each question as asked with its answer. */
export function sheetSnapshot(db: Db, interviewId: number): Snap | null {
  const iv = get<Snap>(
    db,
    `SELECT i.id AS interviewId, i.candidate_id AS candidateId, TRIM(c.first_name || ' ' || c.last_name) AS candidateName, i.type
     FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.id = ?`,
    [interviewId],
  );
  if (!iv) return null;
  const answers = all<{ question: string; answer: string; score: number | null }>(
    db,
    `SELECT question_text AS question, answer, score FROM interview_answers WHERE interview_id = ? ORDER BY sort, id`,
    [interviewId],
  );
  return { ...iv, answers: answers.map((a) => ({ question: a.question, answer: a.answer, score: a.score })) };
}

const dateOfBirthOf = (db: Db, candidateId: number): string | null =>
  get<{ dob: string | null }>(db, `SELECT date_of_birth AS dob FROM candidates WHERE id = ?`, [candidateId])?.dob ?? null;

// ───────────────────────────── wording ─────────────────────────────

/** "date of birth set to 12 Mar 2001" · "changed from … to …" · "removed (was …)"; '' when unchanged. */
export function dateOfBirthChangeText(before: string | null, after: string | null): string {
  if (before === after) return '';
  if (!before) return `date of birth set to ${fullDateLabel(after)}`;
  if (!after) return `date of birth removed (was ${fullDateLabel(before)})`;
  return `date of birth changed from ${fullDateLabel(before)} to ${fullDateLabel(after)}`;
}

function sheetSummaryText(before: Snap | null, after: Snap | null): string {
  const answers = Array.isArray(after?.answers) ? (after.answers as { answer: string; score: number | null }[]) : [];
  const s = sheetSummary(answers);
  const started = !before || !Array.isArray(before.answers) || before.answers.length === 0;
  const head = `${started ? 'Started' : 'Updated'} the ${typeWord(after?.type ?? before?.type)} sheet for ${str(after?.candidateName ?? before?.candidateName, 'a candidate')}`;
  return `${head}: ${s.answered} of ${s.questions} answered${s.averageScore !== null ? `, average score ${s.averageScore}` : ''}`;
}

// ───────────────────────────── the specs ─────────────────────────────

interface QuestionState {
  id: number | null;
  before: Snap | null;
}

const addQuestion: AuditRouteSpec<undefined> = {
  method: 'POST',
  pattern: '/recruitment/questions',
  after(db, done) {
    const id = toId(responseOf(done).id);
    const after = id ? questionSnapshot(db, id) : null;
    if (!id || !after) return [];
    return [{ entity: 'interview_question', entityId: id, summary: `Added a ${typeWord(after.interviewType)} question: ${quoted(after.text)}`, before: null, after }];
  },
};

const editQuestion: AuditRouteSpec<QuestionState> = {
  method: 'PATCH',
  pattern: '/recruitment/questions/:id',
  before(db, call) {
    const id = paramId(call);
    return { id, before: id ? questionSnapshot(db, id) : null };
  },
  after(db, _done, state) {
    const id = state?.id ?? null;
    const before = state?.before ?? null;
    const after = id ? questionSnapshot(db, id) : null;
    if (!id || !after) return [];
    const diff = auditDiff(before, after);
    if (before && !diff.length) return [];
    const onlyActive = diff.length === 1 && diff[0]!.field === 'active';
    const summary = onlyActive
      ? `Turned ${after.active ? 'on' : 'off'} a ${typeWord(after.interviewType)} question: ${quoted(after.text)}`
      : `Edited a ${typeWord(after.interviewType)} question${diff.some((d) => d.field === 'text') ? '' : ` ${quoted(after.text)}`}: ${changes(diff) || 'details'}`;
    return [{ entity: 'interview_question', entityId: id, summary, before, after }];
  },
};

const reorderQuestions: AuditRouteSpec<{ type: unknown; before: string[] }> = {
  method: 'PUT',
  pattern: '/recruitment/questions/order',
  before(db, call) {
    const type = bodyOf(call).interviewType;
    return { type, before: questionOrder(db, type) };
  },
  after(db, _done, state) {
    if (!state) return [];
    const after = questionOrder(db, state.type);
    if (JSON.stringify(after) === JSON.stringify(state.before)) return [];
    return [{ entity: 'interview_question', entityId: null, summary: `Reordered the ${typeWord(state.type)} questions`, before: { order: state.before }, after: { order: after } }];
  },
};

const saveAnswers: AuditRouteSpec<{ id: number | null; before: Snap | null }> = {
  method: 'PUT',
  pattern: '/recruitment/interviews/:id/answers',
  before(db, call) {
    const id = paramId(call);
    return { id, before: id ? sheetSnapshot(db, id) : null };
  },
  after(db, _done, state) {
    const id = state?.id ?? null;
    const after = id ? sheetSnapshot(db, id) : null;
    if (!id || !after) return [];
    const before = state?.before ?? null;
    if (before && JSON.stringify(before.answers) === JSON.stringify(after.answers)) return [];
    const draft: AuditDraft = {
      entity: 'candidate',
      entityId: toId(after.candidateId),
      summary: sheetSummaryText(before, after),
      before: before && Array.isArray(before.answers) && before.answers.length ? before : null,
      after,
    };
    return [draft];
  },
};

/** The 1.2 spec for a route (lib/auditSpecs.ts, P9's), looked up once; null (with a warning) when it is not there. */
function spec12(method: AuditRouteSpec['method'], pattern: string, routes: readonly AuditRouteSpec<any>[]): AuditRouteSpec<unknown> | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  const found = routes.find((s) => s.method === method && s.pattern === pattern);
  if (!found) {
    // Never stop the server for a refinement: without it the route keeps whatever spec the registry finds for it.
    console.warn(`[audit] No 1.2 audit spec for ${method} ${pattern}: the date of birth is not added to its rows`);
    return null;
  }
  return found as AuditRouteSpec<unknown>;
}

interface DobState {
  base: unknown;
  id: number | null;
  dob: string | null;
}

/**
 * A 1.2 candidate spec with the date of birth added: the 1.2 rows unchanged unless the date of birth changed; then the
 * first row's snapshots gain `dateOfBirth` and (for an edit) the summary says what happened to it. Null when the 1.2
 * spec is not in `routes` (it then is not refined, and the server still starts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withDateOfBirth(method: 'POST' | 'PATCH', pattern: string, routes: readonly AuditRouteSpec<any>[] = AUDIT_ROUTES): AuditRouteSpec<DobState> | null {
  const base = spec12(method, pattern, routes);
  if (!base) return null;
  return {
    method,
    pattern,
    before(db, call) {
      const id = method === 'PATCH' ? paramId(call) : null;
      return { base: base.before?.(db, call), id, dob: id ? dateOfBirthOf(db, id) : null };
    },
    after(db, done, state) {
      const drafts = base.after(db, done, state?.base);
      const id = state?.id ?? toId(responseOf(done).id);
      if (!id || !drafts.length) return drafts;
      const before = state?.dob ?? null;
      const after = dateOfBirthOf(db, id);
      if (before === after) return drafts;
      const [first, ...rest] = drafts as [AuditDraft, ...AuditDraft[]];
      const b = isRecord(first.before) ? { ...first.before, dateOfBirth: before } : first.before;
      const a = isRecord(first.after) ? { ...first.after, dateOfBirth: after } : first.after;
      if (method === 'POST') return [{ ...first, after: a }, ...rest];
      const name = str((isRecord(a) ? a.name : null) ?? (isRecord(b) ? b.name : null), 'someone');
      const others = changes(auditDiff(first.before, first.after));
      const text = [others, dateOfBirthChangeText(before, after)].filter(Boolean).join('; ');
      return [{ ...first, before: b, after: a, summary: `Updated candidate ${name}: ${text}` }, ...rest];
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  // literal paths before `:param` ones
  addQuestion,
  reorderQuestions,
  editQuestion,
  saveAnswers,
  ...[withDateOfBirth('POST', '/recruitment/candidates'), withDateOfBirth('PATCH', '/recruitment/candidates/:id')].filter((spec) => spec !== null),
];
