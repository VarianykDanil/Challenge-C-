/**
 * Release 1.3 — OWNED BY P3 statements. This package's audit specs: one entry per write route of /statements, in the
 * shape of lib/auditSpecs.ts (AuditRouteSpec: method, pattern, before, after → AuditDraft[]), registered through
 * ./registry.ts (P9 owns the registry). Literal paths come before `:id` ones.
 *
 * Snapshots are small and never hold the app password, or anything about it but whether one is saved — and that only
 * in the summary ("app password replaced"), because shared redaction blanks every key containing "password" anyway.
 * A save that changed nothing writes no row. Automatic steps (the mail job fetching or applying) are recorded by
 * lib/statements/* with recordSystemEvent (actor "Linear Hub"), not here.
 */
import { auditDiff, formatStatementPeriod, STATEMENT_FIELD_LABELS, STATEMENT_FIELDS, type StatementColumnMapping } from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import type { AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';
import { readMailState } from '../statements/mail.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}£${Math.abs(n).toFixed(2)}`;

/** A statement as the trail keeps it. */
function statementSnapshot(db: Db, id: number | null): Snap | null {
  if (!id) return null;
  return (
    get<Snap>(
      db,
      `SELECT s.id, c.code AS campaignCode, s.source, s.file_name AS fileName, s.period_start AS periodStart, s.period_end AS periodEnd,
              s.status, s.sender, (SELECT COUNT(*) FROM statement_rows r WHERE r.statement_id = s.id) AS rowCount,
              (SELECT COUNT(*) FROM statement_rows r WHERE r.statement_id = s.id AND r.user_id IS NOT NULL) AS matchedCount
         FROM statements s LEFT JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ?`,
      [id],
    ) ?? null
  );
}

/** "the BCN statement for 5–11 Oct 2026" */
function statementName(s: Snap | null): string {
  if (!s) return 'a statement';
  const what = [s.campaignCode, 'statement'].filter(Boolean).join(' ');
  return s.periodStart ? `the ${what} for ${formatStatementPeriod(String(s.periodStart), String(s.periodEnd ?? s.periodStart))}` : `the ${what} ${s.fileName ? `“${String(s.fileName)}”` : ''}`.trim();
}

const mailSnapshot = (db: Db): Snap => {
  const s = readMailState(db);
  return { address: s.address, automaticCheck: s.enabled, gmailKeySaved: Boolean(s.passwordEnc) };
};

function sendersSnapshot(db: Db): Snap {
  const out: Snap = {};
  for (const r of all<{ code: string; address: string }>(db, `SELECT c.code, s.address FROM campaign_statement_senders s JOIN campaigns c ON c.id = s.campaign_id ORDER BY c.code, s.address`)) {
    out[r.code] = [...((out[r.code] as string[] | undefined) ?? []), r.address];
  }
  return out;
}

function refsSnapshot(db: Db, userId: number | null): Snap | null {
  if (!userId) return null;
  const person = get<{ name: string }>(db, `SELECT TRIM(first_name || ' ' || last_name) AS name FROM users WHERE id = ?`, [userId]);
  if (!person) return null;
  const refs: Snap = {};
  for (const r of all<{ code: string; ref: string }>(db, `SELECT c.code, r.ref FROM user_client_refs r JOIN campaigns c ON c.id = r.campaign_id WHERE r.user_id = ? ORDER BY c.code`, [userId])) refs[r.code] = r.ref;
  return { name: person.name, refs };
}

function templateSnapshot(db: Db, campaignId: number | null): Snap | null {
  if (!campaignId) return null;
  const row = get<{ mapping: string; code: string }>(db, `SELECT t.mapping, c.code FROM statement_templates t JOIN campaigns c ON c.id = t.campaign_id WHERE t.campaign_id = ?`, [campaignId]);
  if (!row) return null;
  let mapping: StatementColumnMapping = {};
  try {
    mapping = JSON.parse(row.mapping) as StatementColumnMapping;
  } catch {
    /* unreadable: an empty mapping */
  }
  const columns: Snap = {};
  for (const f of STATEMENT_FIELDS) if (mapping[f] !== undefined) columns[STATEMENT_FIELD_LABELS[f]] = mapping[f];
  return { campaignCode: row.code, columns };
}

const campaignCode = (db: Db, id: number | null) => (id ? (get<{ code: string }>(db, `SELECT code FROM campaigns WHERE id = ?`, [id])?.code ?? null) : null);

const one = (draft: AuditDraft): AuditDraft[] => [draft];

export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    method: 'PUT',
    pattern: '/statements/mail',
    before: (db) => mailSnapshot(db),
    after(db, done, before: Snap | undefined) {
      const after = mailSnapshot(db);
      const body = isRecord(done.body) ? done.body : {};
      const parts: string[] = [];
      if (before?.address !== after.address) parts.push(after.address ? `address ${String(after.address)}` : 'address removed');
      if (typeof body.appPassword === 'string') parts.push(body.appPassword === '' ? 'app password removed' : before?.gmailKeySaved ? 'app password replaced' : 'app password saved');
      if (before?.automaticCheck !== after.automaticCheck) parts.push(after.automaticCheck ? 'automatic check on' : 'automatic check off');
      if (!parts.length) return [];
      return one({ entity: 'settings', entityId: null, summary: `Changed the Gmail statements settings: ${parts.join(', ')}`, before: before ?? null, after });
    },
  } satisfies AuditRouteSpec<Snap>,
  {
    method: 'POST',
    pattern: '/statements/mail/test',
    after(_db, done) {
      const r = responseOf(done);
      return one({ entity: 'settings', entityId: null, summary: r.ok ? 'Tested the Gmail connection: connected' : `Tested the Gmail connection: failed (${String(r.message ?? 'no reason')})` });
    },
  },
  {
    method: 'POST',
    pattern: '/statements/check-now',
    after(_db, done) {
      const r = responseOf(done);
      const fetched = Number(r.fetched ?? 0);
      const applied = Number(r.applied ?? 0);
      const errors = Array.isArray(r.errors) ? r.errors.length : 0;
      const summary = `Checked Gmail for statements: ${fetched ? plural(fetched, 'new statement') : 'nothing new'}${applied ? `, ${applied} applied automatically` : ''}${errors ? `, ${plural(errors, 'problem')}` : ''}`;
      return one({ entity: 'statement', entityId: null, summary, after: { checked: r.checked, fetched, parsed: r.parsed, applied, errors: r.errors } });
    },
  },
  {
    method: 'PUT',
    pattern: '/statements/senders',
    before: (db) => sendersSnapshot(db),
    after(db, _done, before: Snap | undefined) {
      const after = sendersSnapshot(db);
      const diff = auditDiff(before ?? {}, after);
      if (!diff.length) return [];
      const added: string[] = [];
      const removed: string[] = [];
      for (const code of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
        const was = new Set((before?.[code] as string[] | undefined) ?? []);
        const now = new Set((after[code] as string[] | undefined) ?? []);
        for (const a of now) if (!was.has(a)) added.push(`${code} ${a}`);
        for (const a of was) if (!now.has(a)) removed.push(`${code} ${a}`);
      }
      const parts = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean);
      return one({ entity: 'settings', entityId: null, summary: `Changed the statement senders: ${parts.join('; ')}`, before: before ?? null, after });
    },
  } satisfies AuditRouteSpec<Snap>,
  {
    method: 'PUT',
    pattern: '/statements/templates/:campaignId',
    before: (db, call) => templateSnapshot(db, toId(call.params.campaignId)),
    after(db, done, before: Snap | null | undefined) {
      const campaignId = toId(done.params.campaignId);
      const after = templateSnapshot(db, campaignId);
      if (before && after && !auditDiff(before, after).length) return [];
      const cols = after && isRecord(after.columns) ? Object.entries(after.columns).map(([k, v]) => `${k} = “${String(v)}”`).join(', ') : '';
      return one({ entity: 'campaign', entityId: campaignId, summary: `Saved the statement columns for ${campaignCode(db, campaignId) ?? 'a campaign'}: ${cols}`, before: before ?? null, after });
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'PUT',
    pattern: '/statements/client-refs/:userId',
    before: (db, call) => refsSnapshot(db, toId(call.params.userId)),
    after(db, done, before: Snap | null | undefined) {
      const userId = toId(done.params.userId);
      const after = refsSnapshot(db, userId);
      if (!after) return [];
      const was = (isRecord(before?.refs) ? before!.refs : {}) as Record<string, string>;
      const now = after.refs as Record<string, string>;
      const parts: string[] = [];
      for (const code of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
        if (was[code] === now[code]) continue;
        parts.push(now[code] ? `${code} ${now[code]}` : `${code} removed`);
      }
      if (!parts.length) return [];
      return one({ entity: 'user', entityId: userId, summary: `Changed ${String(after.name)}’s client IDs: ${parts.join(', ')}`, before: before ?? null, after });
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'POST',
    pattern: '/statements/upload',
    after(db, done) {
      const id = toId(responseOf(done).id);
      const after = statementSnapshot(db, id);
      const failed = after?.status === 'failed';
      // re-review fix: the same PDF again after it could not be read replaces the failed copy (routes/statements.ts)
      const replaced = toId(responseOf(done).replacedFailedId) !== null;
      const instead = replaced ? `it replaces the copy received before, which could not be read${failed ? ' either' : ''}` : '';
      const counts = after ? ` (${plural(Number(after.rowCount ?? 0), 'row')}, ${Number(after.matchedCount ?? 0)} matched${instead ? `; ${instead}` : ''})` : '';
      const summary = `Uploaded a statement: ${statementName(after).replace(/^the /, '')}${failed ? `, which could not be read${instead ? ` (${instead})` : ''}` : counts}`;
      return one({ entity: 'statement', entityId: id, summary, after: replaced ? { ...after, replacedFailedId: responseOf(done).replacedFailedId } : after });
    },
  },
  {
    method: 'POST',
    pattern: '/statements/:id/apply',
    before: (db, call) => statementSnapshot(db, toId(call.params.id)),
    after(db, done, before: Snap | null | undefined) {
      const id = toId(done.params.id);
      const r = responseOf(done);
      const people = Array.isArray(r.people) ? (r.people as { cancelled?: number }[]) : [];
      const cancelled = people.reduce((s, p) => s + (Number(p.cancelled) || 0), 0);
      // re-review fix: the people a replacement dropped are in the total too
      const dropped = Array.isArray(r.dropped) ? r.dropped.length : 0;
      const back = dropped ? `, ${plural(dropped, 'person', 'people')} back to the subs they logged` : '';
      const effect = isRecord(r.effect) ? r.effect : {};
      const diff = Number(effect.totalDifference ?? 0);
      const summary = `Applied ${statementName(before ?? null)}: ${plural(people.length, 'person', 'people')}${back}, ${plural(cancelled, 'cancelled sub')}, ${diff ? `${money(diff)} on the next pay runs` : 'no change to pay'}`;
      return one({ entity: 'statement', entityId: id, summary, before: before ?? null, after: statementSnapshot(db, id) });
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'PUT',
    pattern: '/statements/:id/rows/:rowId',
    before(db, call) {
      return get<Snap>(
        db,
        `SELECT r.id, r.name, r.fundraiser_ref AS fundraiserRef, r.user_id AS userId, r.match,
                CASE WHEN u.id IS NULL THEN NULL ELSE TRIM(u.first_name || ' ' || u.last_name) END AS userName
           FROM statement_rows r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.statement_id = ?`,
        [toId(call.params.rowId), toId(call.params.id)],
      ) ?? null;
    },
    after(db, done, before: Snap | null | undefined) {
      const id = toId(done.params.id);
      const r = responseOf(done);
      const st = statementSnapshot(db, id);
      const more = Number(r.alsoMatched ?? 0);
      const row = `“${String(r.name ?? r.fundraiserRef ?? 'a row')}”${more ? ` (and ${plural(more, 'more row')} written the same way)` : ''}`;
      const summary = r.userId
        ? `Matched ${row} on ${statementName(st)} to ${String(r.userName ?? 'a person')}${r.rememberedRef ? ` (saved ${String(r.rememberedRef)} as their client ID)` : ''}`
        : `Marked ${row} on ${statementName(st)} as not one of ours`;
      return one({ entity: 'statement', entityId: id, summary, before: before ?? null, after: { id: r.id, name: r.name, fundraiserRef: r.fundraiserRef, userId: r.userId, userName: r.userName, match: r.match } });
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'PATCH',
    pattern: '/statements/:id',
    before: (db, call) => statementSnapshot(db, toId(call.params.id)),
    after(db, done, before: Snap | null | undefined) {
      const id = toId(done.params.id);
      const after = statementSnapshot(db, id);
      const parts: string[] = [];
      if (before?.campaignCode !== after?.campaignCode) parts.push(`campaign ${String(after?.campaignCode ?? 'none')}`);
      if (before?.periodStart !== after?.periodStart || before?.periodEnd !== after?.periodEnd) parts.push(`period ${formatStatementPeriod(after?.periodStart as string | null, after?.periodEnd as string | null)}`);
      if (!parts.length) return [];
      return one({ entity: 'statement', entityId: id, summary: `Changed ${statementName(before ?? null)}: ${parts.join(', ')}`, before: before ?? null, after });
    },
  } satisfies AuditRouteSpec<Snap | null>,
  {
    method: 'DELETE',
    pattern: '/statements/:id',
    before: (db, call) => statementSnapshot(db, toId(call.params.id)),
    after(_db, done, before: Snap | null | undefined) {
      const rows = before ? ` (${plural(Number(before.rowCount ?? 0), 'row')})` : '';
      return one({ entity: 'statement', entityId: toId(done.params.id), summary: `Discarded ${statementName(before ?? null)}${rows}`, before: before ?? null });
    },
  } satisfies AuditRouteSpec<Snap | null>,
];
