/**
 * What a restricted demo account (lib/trial.ts isRestrictedDemo: a one-tap demo sign-in, or one of the demo company's
 * people, while in trial mode) may write. During the trial anyone on the office network can open those accounts, so:
 *  - its own account, the demo company's people and records, and new records: yes (that is what the demo is for);
 *  - a person of the office's own (their details, role, status, sign-in, client IDs, gauges, learning) or a record the
 *    office made: no;
 *  - money of anyone but the demo company (pay adjustments, bonuses, pay runs, payment batches, invoices, bank
 *    details): no, its own included when it is a real person signing in one-tap;
 *  - office-wide settings that touch money, security or sign-in, payment connections, approving a payment and the
 *    payment file: no.
 * Every write route is listed in DEMO_WRITE_RULES; a write route that is not listed is refused, so a new route is safe
 * until someone decides what a demo account may do with it (test/access-demo-writes.test.ts checks the list covers
 * every route). Reads are allowed except the few in DEMO_READ_RULES.
 */
import type { UserWithTeam } from '@lm/shared';
import { all, get, type Db } from '../db/connection.ts';
import { AUDIT_ENTITY, CREATE_ACTIONS } from './demoRecords.ts';
import { isDemoPerson, readSeedMarks, type SeedMarkTable } from './trialMode.ts';

export interface DemoCall {
  db: Db;
  me: Pick<UserWithTeam, 'id'>;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/** null: allowed; otherwise what is refused, finishing "Demo accounts cannot …". */
export type DemoCheck = (c: DemoCall) => string | null;

export const DEMO_REFUSALS = {
  people: 'change your own people’s details, sign-in or work',
  money: 'change or pay anyone’s pay but the demo company’s',
  records: 'change records your office made',
  other: 'make this change',
} as const;

// ── what a check reads ──

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(num).filter((n): n is number => n !== null) : []);
const param = (name: string) => (c: DemoCall) => [num(c.params[name])].filter((n): n is number => n !== null);
const field = (name: string) => (c: DemoCall) => [num(c.body[name])].filter((n): n is number => n !== null);
/** User ids from a row looked up by the path's `:id` (SQL with one `?`). */
const lookup = (sql: string, name = 'id') => (c: DemoCall) => {
  const id = num(c.params[name]);
  return id === null ? [] : all<{ u: number | null }>(c.db, sql, [id]).map((r) => r.u).filter((u): u is number => u !== null);
};

/** The ids that are people of the office's own (they exist and are not the demo company). */
function ownPeople(db: Db, ids: readonly number[]): number[] {
  if (!ids.length) return [];
  const existing = all<{ id: number }>(db, `SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...new Set(ids)])]).map((r) => r.id);
  return existing.filter((id) => !isDemoPerson(db, id));
}

/** The people it touches are the demo company or the caller. */
const people = (...sources: ((c: DemoCall) => number[])[]): DemoCheck => (c) =>
  ownPeople(c.db, sources.flatMap((s) => s(c))).some((id) => id !== c.me.id) ? DEMO_REFUSALS.people : null;

/** Money: the people it pays or changes pay for are the demo company only (never a real person, the caller included). */
const money = (...sources: ((c: DemoCall) => number[])[]): DemoCheck => (c) =>
  ownPeople(c.db, sources.flatMap((s) => s(c))).length ? DEMO_REFUSALS.money : null;

/**
 * A company record is the demo's when the demo seed made it (at or below its seed mark) or the audit trail shows a demo
 * account, or the caller, created it.
 */
export function isDemoRecord(db: Db, me: Pick<UserWithTeam, 'id'>, table: SeedMarkTable, id: number): boolean {
  if (id <= (readSeedMarks(db)[table] ?? 0)) return true;
  const entity = AUDIT_ENTITY[table];
  if (!entity) return false;
  const creator = get<{ u: number | null }>(
    db,
    `SELECT user_id AS u FROM audit_log WHERE entity = ? AND entity_id = ? AND action IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1`,
    [entity, id, JSON.stringify(CREATE_ACTIONS[table])],
  )?.u;
  return typeof creator === 'number' && (creator === me.id || isDemoPerson(db, creator));
}

/** A record that does not exist is let through, so the route answers its own 404. */
const record = (table: SeedMarkTable, source: (c: DemoCall) => number[] = param('id')): DemoCheck => (c) =>
  source(c).every((id) => !get(c.db, `SELECT 1 FROM ${table} WHERE id = ?`, [id]) || isDemoRecord(c.db, c.me, table, id)) ? null : DEMO_REFUSALS.records;

const all_ = (...checks: DemoCheck[]): DemoCheck => (c) => {
  for (const check of checks) {
    const refused = check(c);
    if (refused) return refused;
  }
  return null;
};

const allow: DemoCheck = () => null;
const deny = (what: string): DemoCheck => () => what;

/** The people a roster change books or unbooks (the whole list replaces the current one). */
const rosterPeople = (c: DemoCall): number[] => {
  if (Array.isArray(c.body.userIds)) {
    const next = new Set(nums(c.body.userIds));
    const id = num(c.params.id);
    const current = id === null ? [] : all<{ u: number }>(c.db, `SELECT user_id AS u FROM event_roster WHERE event_id = ?`, [id]).map((r) => r.u);
    return [...[...next].filter((u) => !current.includes(u)), ...current.filter((u) => !next.has(u))];
  }
  return [...nums(c.body.add), ...nums(c.body.remove)];
};
const bulkRows = (c: DemoCall): number[] =>
  Array.isArray(c.body.rows) ? c.body.rows.map((r) => num((r as { userId?: unknown } | null)?.userId)).filter((n): n is number => n !== null) : [];
const runPeople = (c: DemoCall): number[] => {
  const ids = nums(c.body.runIds);
  return ids.length ? all<{ u: number }>(c.db, `SELECT user_id AS u FROM payroll_runs WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]).map((r) => r.u) : [];
};
const campaignByCode = (c: DemoCall): number[] => {
  const code = c.params.campaignCode;
  const id = code ? get<{ id: number }>(c.db, `SELECT id FROM campaigns WHERE lower(code) = lower(?)`, [code])?.id : undefined;
  return id ? [id] : [];
};
/** A campaign's pay per sale sets real people's pay: a demo account may save the form, but not change those. */
const campaignPayUnchanged: DemoCheck = (c) => {
  const id = num(c.params.id);
  const row = id === null ? undefined : get<{ payout: number; rep: number }>(c.db, `SELECT payout_per_sale AS payout, rep_commission_per_sale AS rep FROM campaigns WHERE id = ?`, [id]);
  if (!row) return null;
  const changed = (field: string, now: number) => field in c.body && Number(c.body[field]) !== now;
  return changed('payoutPerSale', row.payout) || changed('repCommissionPerSale', row.rep) ? 'change a campaign’s pay per sale' : null;
};

/** Write routes ("METHOD /pattern", as the route table lists them) → what a demo account may do there. */
export const DEMO_WRITE_RULES: Readonly<Record<string, DemoCheck>> = {
  // ── its own account ──
  'POST /auth/login': allow,
  'POST /auth/login/2fa': allow,
  'POST /auth/logout': allow,
  'POST /auth/2fa/setup': allow,
  'POST /auth/2fa/enable': allow,
  'POST /auth/2fa/disable': allow,
  'POST /auth/2fa/recovery-codes': allow,
  'POST /auth/pin': allow,
  'POST /auth/pin/remove': allow,
  'POST /audit/events': allow,
  'POST /announcements/:id/read': allow,
  'POST /checkins': allow,
  'POST /client-posts/read': allow,
  'POST /client-posts/:id/read': allow,
  'POST /client/posts': allow,
  'POST /events/:id/roster/me': allow,
  'DELETE /events/:id/roster/me': allow,
  'POST /invoices/:id/accept': allow,
  'POST /invoices/:id/dispute': allow,
  'POST /invoices/agreement/accept': allow,
  'PUT /invoices/profile': allow,
  'POST /learning/progress/:lessonKey/quiz': allow,
  'POST /learning/progress/:lessonKey/teachback': allow,
  'POST /videos/:id/progress': allow,

  // ── people ──
  'POST /users': allow, // never an administrator (routes/users.ts asks for the admin's code, which a demo account cannot give)
  'PATCH /users/:id': people(param('id')),
  'PATCH /client-accounts/:id': people(param('id')),
  'POST /gauges': people(field('userId')),
  'POST /gauges/bulk': people(bulkRows),
  'PATCH /gauges/:id': people(lookup(`SELECT user_id AS u FROM gauge_entries WHERE id = ?`), field('userId')), // and whom it moves to
  'DELETE /gauges/:id': people(lookup(`SELECT user_id AS u FROM gauge_entries WHERE id = ?`)),
  'DELETE /checkins/:id': people(lookup(`SELECT user_id AS u FROM check_ins WHERE id = ?`)),
  'POST /learning/progress/:userId/:lessonKey/signoff': people(param('userId')),
  'PUT /learning/milestones/:userId/:key': people(param('userId')),
  'PUT /statements/client-refs/:userId': people(param('userId')),
  'POST /client-posts/:id/approve': people(lookup(`SELECT author_id AS u FROM client_posts WHERE id = ?`)),
  'POST /client-posts/:id/decline': people(lookup(`SELECT author_id AS u FROM client_posts WHERE id = ?`)),
  'POST /client-posts/:id/unpublish': people(lookup(`SELECT author_id AS u FROM client_posts WHERE id = ?`)),
  'POST /users/:id/2fa/reset': deny('reset anyone’s sign-in'),
  'POST /users/:id/setup-code': deny('give anyone a setup code'),
  'POST /auth/pin/reset/:userId': deny('reset anyone’s sign-in'),
  'POST /client-accounts/:id/reset-2fa': deny('reset anyone’s sign-in'),
  'POST /client-accounts/:id/reset-pin': deny('reset anyone’s sign-in'),

  // ── money ──
  'PUT /me/bank-details': (c) => (isDemoPerson(c.db, c.me.id) ? null : 'see or change a real person’s bank details'),
  'PUT /users/:id/bank-details': (c) => (ownPeople(c.db, param('id')(c)).length ? 'see or change a real person’s bank details' : null),
  'POST /users/:id/bank-details/confirm': (c) => (ownPeople(c.db, param('id')(c)).length ? 'see or change a real person’s bank details' : null),
  'POST /pay/adjustments': money(field('userId')),
  'POST /pay/bonuses': money(field('userId')),
  'DELETE /pay/adjustments/:id': money(lookup(`SELECT user_id AS u FROM pay_adjustments WHERE id = ?`)),
  'POST /finance/payroll/:id/pay': money(lookup(`SELECT user_id AS u FROM payroll_runs WHERE id = ?`)),
  'POST /invoices/:id/resolve': money(lookup(`SELECT user_id AS u FROM invoices WHERE id = ?`)),
  'PUT /invoices/profile/:userId': money(param('userId')),
  'POST /payments/batches': money(runPeople),
  'POST /payments/batches/:id/cancel': money(lookup(`SELECT user_id AS u FROM payment_items WHERE batch_id = ?`)),
  'POST /payments/batches/:id/mark-paid': money(lookup(`SELECT user_id AS u FROM payment_items WHERE batch_id = ?`)),
  'POST /payments/batches/:id/refresh': money(lookup(`SELECT user_id AS u FROM payment_items WHERE batch_id = ?`)),
  'POST /payments/batches/:id/approve': deny('approve a payment'),
  'POST /payments/connections': deny('add or change a payment connection'),
  'PATCH /payments/connections/:id': deny('add or change a payment connection'),
  'DELETE /payments/connections/:id': deny('add or change a payment connection'),
  'POST /payments/connections/:id/test': deny('add or change a payment connection'),

  // ── office-wide settings (money, security, sign-in, statements, the interview questions, videos) ──
  'PUT /auth/security-settings': deny('change the sign-in security settings'),
  'PUT /pay/settings': deny('change the pay settings'),
  'POST /pay/rates': deny('change pay rates'),
  'PUT /invoices/company': deny('change the company details on invoices'),
  'PUT /statements/mail': deny('change the statement settings'),
  'POST /statements/mail/test': deny('change the statement settings'),
  'POST /statements/check-now': deny('change the statement settings'),
  'PUT /statements/senders': deny('change the statement settings'),
  'PUT /statements/templates/:campaignId': deny('change the statement settings'),
  'POST /recruitment/questions': deny('change the interview questions'),
  'PUT /recruitment/questions/order': deny('change the interview questions'),
  'PATCH /recruitment/questions/:id': deny('change the interview questions'),
  'PUT /videos/settings': deny('change the video settings'),

  // ── company records: the demo's, new ones, and those a demo account made ──
  'POST /announcements': allow,
  'POST /campaigns': allow,
  'PATCH /campaigns/:id': all_(campaignPayUnchanged, record('campaigns')),
  'POST /campaigns/:id/client-accounts': record('campaigns'),
  'PUT /pitches/:campaignCode': record('campaigns', campaignByCode),
  'POST /events': allow,
  'PATCH /events/:id': record('events'),
  'DELETE /events/:id': record('events'),
  'PUT /events/:id/roster': all_(record('events'), people(rosterPeople)),
  'POST /finance/expenses': allow,
  'DELETE /finance/expenses/:id': record('expenses'),
  'POST /recruitment/candidates': allow,
  'PATCH /recruitment/candidates/:id': record('candidates'),
  'POST /recruitment/candidates/:id/stage': record('candidates'),
  'POST /recruitment/interviews': record('candidates', field('candidateId')),
  'PATCH /recruitment/interviews/:id': record('candidates', lookup(`SELECT candidate_id AS u FROM interviews WHERE id = ?`)),
  'PUT /recruitment/interviews/:id/answers': record('candidates', lookup(`SELECT candidate_id AS u FROM interviews WHERE id = ?`)),
  'POST /statements/upload': allow,
  'PATCH /statements/:id': record('statements'),
  'DELETE /statements/:id': record('statements'),
  'POST /statements/:id/apply': record('statements'),
  'PUT /statements/:id/rows/:rowId': record('statements'),
  'POST /videos': allow,
  'POST /videos/upload': allow,
  'PATCH /videos/:id': record('learning_videos'),
  'DELETE /videos/:id': record('learning_videos'),
  'POST /videos/:id/poster': record('learning_videos'),
};

/** Reads a demo account may not make. */
export const DEMO_READ_RULES: Readonly<Record<string, DemoCheck>> = {
  'GET /payments/batches/:id/file': deny('download a payment file'),
  'GET /me/bank-details': (c) => (isDemoPerson(c.db, c.me.id) ? null : 'see or change a real person’s bank details'),
  'GET /users/:id/bank-details': (c) => (ownPeople(c.db, param('id')(c)).length ? 'see or change a real person’s bank details' : null),
};

interface Compiled {
  method: string;
  re: RegExp;
  names: string[];
  check: DemoCheck;
}

function compile(rules: Readonly<Record<string, DemoCheck>>): Compiled[] {
  return Object.entries(rules).map(([key, check]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    const names: string[] = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          names.push(part.slice(1));
          return '([^/]+)';
        }
        return part.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      })
      .join('/');
    return { method, re: new RegExp(`^${source}$`), names, check };
  });
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const WRITES = compile(DEMO_WRITE_RULES);
const READS = compile(DEMO_READ_RULES);

/**
 * What a restricted demo account may not do with this request: a phrase for "Demo accounts cannot …", or null.
 * `path` is relative to /api, lower case, without a trailing slash.
 */
export function demoRefusalFor(db: Db, me: Pick<UserWithTeam, 'id'>, method: string, path: string, body: unknown): string | null {
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const rules = read ? READS : WRITES;
  const hit = rules.find((r) => r.method === (method === 'HEAD' ? 'GET' : method) && r.re.test(path));
  if (!hit) return read ? null : DEMO_REFUSALS.other;
  const m = hit.re.exec(path)!;
  const params = Object.fromEntries(hit.names.map((n, i) => [n, decode(m[i + 1] ?? '')]));
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return hit.check({ db, me, params, body: b });
}
