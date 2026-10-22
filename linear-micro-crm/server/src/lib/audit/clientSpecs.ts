/**
 * Release 1.3 — OWNED BY P6 client-portal. This package's audit specs, in the shape of lib/auditSpecs.ts
 * (AuditRouteSpec: method, pattern, before, after → AuditDraft[]), registered through ./registry.ts (P9 owns the
 * registry; this file is the only one this package edits for audit). Every client-portal action is recorded with the
 * client account as the actor:
 *
 *   POST /client/posts                       "Breast Cancer Now posted an update: “New welcome pack”" (a double tap
 *                                            answered with the first post writes nothing)
 *   POST /client-posts/:id/approve           "Approved Breast Cancer Now's commission change: £22.00 per sub to the
 *                                            fundraiser, from Mon 2 Nov" (+ the campaign_rate row it added)
 *   POST /client-posts/:id/decline           "Declined … : <the reason the client sees>"
 *   POST /client-posts/:id/unpublish         "Unpublished …" (+ the announcement it removed, with its text)
 *   POST /client-posts/:id/read, /read       skipped (read receipts have their own table, like announcement reads)
 *   POST /campaigns/:id/client-accounts      "Invited Jo Bloggs (CL-0002) to the Breast Cancer Now client portal"
 *   PATCH /client-accounts/:id               "Deactivated / Reactivated / Updated the client account of …"
 *   POST /client-accounts/:id/reset-pin      "Reset the PIN of … ; they create a new one at their next sign-in"
 *   POST /campaigns, PATCH /campaigns/:id    refined from the 1.2 specs (same wording) so the snapshot also holds the
 *                                            campaign page's brief (long description, brief, contact) this package added.
 * Snapshots never include PINs, hashes, tokens or two-step codes (a PIN is only ever "pinSet"; lib/audit.ts redacts
 * again before storing). The access code is stored as `accessCode`: like an employee ID, it is half of a sign-in.
 */
import {
  AUDIT_DIFF_SKIPPED,
  CLIENT_POST_KIND_LABELS,
  auditChangeText,
  auditDiff,
  clientCommissionSummary,
  type AuditFieldChange,
  type ClientPostKind,
} from '@lm/shared';
import { get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';

type Snap = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const paramId = (call: AuditCall) => toId(call.params.id);
const responseOf = (done: AuditDone): Record<string, unknown> => (isRecord(done.response) ? done.response : {});

/** Reads that depend on another package's table (campaign_rates, P1) never break the request: any error → fallback. */
function soft<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function changes(diff: AuditFieldChange[], skip: readonly string[] = []): string {
  return auditChangeText(diff, { skip: [...skip, ...AUDIT_DIFF_SKIPPED], max: 3 });
}
const withChanges = (head: string, diff: AuditFieldChange[], skip: readonly string[] = []) => {
  const text = changes(diff, skip);
  return text ? `${head}: ${text}` : `${head} (no changes)`;
};
/** The head alone when nothing but the skipped fields changed ("Reactivated …"), else the head and the changes. */
const withOtherChanges = (head: string, diff: AuditFieldChange[], skip: readonly string[]) => {
  const text = changes(diff, skip);
  return text ? `${head}: ${text}` : head;
};

// ───────────────────────────── snapshots ─────────────────────────────

export function clientPostSnapshot(db: Db, id: number): Snap | null {
  return (
    get<Snap>(
      db,
      `SELECT p.id, p.kind, p.title, p.body, p.rate_rep AS rateRep, p.rate_payout AS ratePayout, p.effective_from AS effectiveFrom,
              p.requested_from AS requestedFrom, p.status, p.decision_note AS decisionNote, p.announcement_id AS announcementId,
              p.campaign_id AS campaignId, c.name AS campaignName, c.code AS campaignCode,
              a.first_name || ' ' || a.last_name AS authorName, d.first_name || ' ' || d.last_name AS decidedByName
       FROM client_posts p JOIN campaigns c ON c.id = p.campaign_id JOIN users a ON a.id = p.author_id LEFT JOIN users d ON d.id = p.decided_by
       WHERE p.id = ?`,
      [id],
    ) ?? null
  );
}

export function clientAccountSnapshot(db: Db, id: number): Snap | null {
  const row = get<Snap>(
    db,
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.employee_id AS accessCode, u.status,
            (u.pin_hash IS NOT NULL) AS pinSet, u.client_campaign_id AS campaignId, c.name AS campaignName
     FROM users u LEFT JOIN campaigns c ON c.id = u.client_campaign_id WHERE u.id = ? AND u.role = 'client'`,
    [id],
  );
  return row ? { ...row, pinSet: row.pinSet === 1 || row.pinSet === true } : null;
}

/** The 1.2 campaign snapshot plus the brief (the code as `campaignCode`: a bare `code` key is redacted). */
export function campaignBriefSnapshot(db: Db, id: number): Snap | null {
  const row = get<Snap>(
    db,
    `SELECT id, name, code AS campaignCode, sector, type, payout_per_sale AS payoutPerSale,
            rep_commission_per_sale AS repCommissionPerSale, color, active, start_date AS startDate, description,
            long_description AS longDescription, brief, contact_name AS contactName, contact_email AS contactEmail,
            contact_phone AS contactPhone
     FROM campaigns WHERE id = ?`,
    [id],
  );
  return row ? { ...row, active: row.active === 1 || row.active === true } : null;
}

function announcementSnapshot(db: Db, id: number | null): Snap | null {
  if (!id) return null;
  const row = get<Snap>(
    db,
    `SELECT a.id, a.title, a.body, a.pinned, a.author_id AS authorId, u.first_name || ' ' || u.last_name AS authorName
     FROM announcements a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = ?`,
    [id],
  );
  return row ? { ...row, pinned: row.pinned === 1 || row.pinned === true } : null;
}

// ───────────────────────────── wording ─────────────────────────────

const kindWord = (k: unknown) => (CLIENT_POST_KIND_LABELS[k as ClientPostKind] ?? 'post').toLowerCase();
const campaignOf = (s: Snap | null) => str(s?.campaignName, 'A client');
const possessive = (name: string) => (name.endsWith('s') ? `${name}’` : `${name}’s`);
const commissionText = (s: Snap | null) =>
  clientCommissionSummary({ rateRep: num(s?.rateRep), ratePayout: num(s?.ratePayout), effectiveFrom: typeof s?.effectiveFrom === 'string' ? s.effectiveFrom : null });
const titleOf = (s: Snap | null) => `“${str(s?.title, 'Untitled')}”`;
const campaignLabel = (s: Snap | null) => (s ? `${str(s.name, 'a campaign')} (${str(s.campaignCode)})` : 'a campaign');
const personOf = (s: Snap | null) => `${str(s?.name, 'a client')}${s?.campaignName ? ` (${str(s.campaignName)})` : ''}`;

/** The summary of a new client post, as the trail shows it. Exported for the tests. */
export function clientPostSummary(s: Snap | null): string {
  if (!s) return 'A client posted from the client portal';
  if (s.kind === 'commission') {
    const what = commissionText(s);
    return `${campaignOf(s)} asked for a commission change${what ? `: ${what}` : ''}`;
  }
  return `${campaignOf(s)} posted ${s.kind === 'announcement' ? 'an announcement' : 'an update'}: ${titleOf(s)}`;
}

// ───────────────────────────── the specs ─────────────────────────────

interface Before {
  id: number | null;
  before: Snap | null;
}

/** A decision on a client post (approve, decline, unpublish): the post before and after, plus `extra` rows. */
function decision(pattern: string, summary: (before: Snap | null, after: Snap | null, call: AuditDone) => string, extra?: (db: Db, before: Snap | null, after: Snap | null) => AuditDraft[]): AuditRouteSpec<Before> {
  return {
    method: 'POST',
    pattern,
    before(db, call) {
      const id = paramId(call);
      return { id, before: id ? clientPostSnapshot(db, id) : null };
    },
    after(db, done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      const before = state?.before ?? null;
      const after = clientPostSnapshot(db, id);
      return [{ entity: 'client_post', entityId: id, summary: summary(before, after, done), before, after }, ...(extra?.(db, before, after) ?? [])];
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  // ── the client's own portal (the actor is the client account) ──
  {
    method: 'POST',
    pattern: '/client/posts',
    after(db, done) {
      if (done.status !== 201) return []; // 200: a double tap answered with the first post, nothing new
      const id = toId(responseOf(done).id);
      const after = id ? clientPostSnapshot(db, id) : null;
      if (!id || !after) return [];
      return [{ entity: 'client_post', entityId: id, summary: clientPostSummary(after), before: null, after }];
    },
  } satisfies AuditRouteSpec<undefined>,

  // ── the office's decisions ──
  { method: 'POST', pattern: '/client-posts/:id/read', skip: true, after: () => [] },
  { method: 'POST', pattern: '/client-posts/read', skip: true, after: () => [] },
  decision(
    '/client-posts/:id/approve',
    (_b, after) => `Approved ${possessive(campaignOf(after))} commission change: ${commissionText(after) || titleOf(after)}`,
    (db, _b, after) => {
      const id = toId(after?.id);
      const rate = id
        ? soft(() => get<Snap>(db, `SELECT id, campaign_id AS campaignId, rep_rate AS repRate, payout_rate AS payoutRate, effective_from AS effectiveFrom, source FROM campaign_rates WHERE client_post_id = ? ORDER BY id DESC LIMIT 1`, [id]), undefined)
        : undefined;
      if (!rate) return [];
      return [{
        entity: 'campaign_rate',
        entityId: toId(rate.id),
        summary: `New ${str(after?.campaignCode)} rate from the client's change: ${clientCommissionSummary({ rateRep: num(rate.repRate), ratePayout: num(rate.payoutRate), effectiveFrom: str(rate.effectiveFrom) || null })}`,
        before: null,
        after: { ...rate, campaignName: after?.campaignName ?? null },
      }];
    },
  ),
  decision('/client-posts/:id/decline', (before, after) => {
    const what = commissionText(before ?? after);
    return `Declined ${possessive(campaignOf(after ?? before))} commission change${what ? ` (${what})` : ''}: ${str(after?.decisionNote, 'no reason given')}`;
  }),
  decision(
    '/client-posts/:id/unpublish',
    (before, after) => {
      const note = str(after?.decisionNote);
      return `Unpublished ${possessive(campaignOf(after ?? before))} ${kindWord((after ?? before)?.kind)} ${titleOf(after ?? before)} from Announcements${note ? `: ${note}` : ''}`;
    },
    (db, before) => {
      // The removed Announcements row: its text stays in the trail (the row and its read receipts are gone).
      const announcementId = toId(before?.announcementId);
      if (!announcementId) return [];
      const removed = announcementSnapshot(db, announcementId);
      if (removed) return []; // still there: nothing was removed
      return [{
        entity: 'announcement',
        entityId: announcementId,
        summary: `Removed from Announcements: ${titleOf(before)} (from ${campaignOf(before)})`,
        before: { id: announcementId, title: before?.title ?? null, body: before?.body ?? null, authorName: before?.authorName ?? null },
        after: null,
      }];
    },
  ),

  // ── client accounts (admin) ──
  {
    method: 'POST',
    pattern: '/campaigns/:id/client-accounts',
    after(db, done) {
      const account = responseOf(done).account;
      const id = toId(isRecord(account) ? account.id : null);
      const after = id ? clientAccountSnapshot(db, id) : null;
      if (!id || !after) return [];
      return [{
        entity: 'client_account',
        entityId: id,
        summary: `Invited ${str(after.name, 'a client')} (${str(after.accessCode)}) to the ${str(after.campaignName, 'client')} client portal`,
        before: null,
        after,
      }];
    },
  } satisfies AuditRouteSpec<undefined>,
  {
    method: 'PATCH',
    pattern: '/client-accounts/:id',
    before(db, call) {
      const id = paramId(call);
      return { id, before: id ? clientAccountSnapshot(db, id) : null };
    },
    after(db, _done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      const before = state?.before ?? null;
      const after = clientAccountSnapshot(db, id);
      const diff = auditDiff(before, after);
      if (before && after && !diff.length) return [];
      const status = diff.find((d) => d.field === 'status');
      const who = personOf(after ?? before);
      const summary =
        status?.after === 'left'
          ? `Deactivated the client account of ${who}`
          : status?.before === 'left'
            ? withOtherChanges(`Reactivated the client account of ${who}`, diff, ['status'])
            : withChanges(`Updated the client account of ${who}`, diff);
      return [{ entity: 'client_account', entityId: id, summary, before, after }];
    },
  } satisfies AuditRouteSpec<Before>,
  {
    method: 'POST',
    pattern: '/client-accounts/:id/reset-pin',
    before(db, call) {
      const id = paramId(call);
      return { id, before: id ? clientAccountSnapshot(db, id) : null };
    },
    after(db, _done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      const after = clientAccountSnapshot(db, id);
      return [{
        entity: 'client_account',
        entityId: id,
        summary: `Reset the PIN of ${personOf(after ?? state?.before ?? null)}; they create a new one at their next sign-in`,
        before: state?.before ?? null,
        after,
      }];
    },
  } satisfies AuditRouteSpec<Before>,

  // ── campaigns: the 1.2 entries, with the brief in the snapshot ──
  {
    method: 'POST',
    pattern: '/campaigns',
    after(db, done) {
      const id = toId(responseOf(done).id);
      const after = id ? campaignBriefSnapshot(db, id) : null;
      if (!id) return [];
      return [{ entity: 'campaign', entityId: id, summary: `Added campaign: ${campaignLabel(after)}`, before: null, after }];
    },
  } satisfies AuditRouteSpec<undefined>,
  {
    method: 'PATCH',
    pattern: '/campaigns/:id',
    before(db, call) {
      const id = paramId(call);
      return { id, before: id ? campaignBriefSnapshot(db, id) : null };
    },
    after(db, _done, state) {
      const id = state?.id ?? null;
      if (!id) return [];
      const before = state?.before ?? null;
      const after = campaignBriefSnapshot(db, id);
      const diff = auditDiff(before, after);
      return [{ entity: 'campaign', entityId: id, summary: withChanges(`Updated campaign ${campaignLabel(before ?? after)}`, diff), before, after }];
    },
  } satisfies AuditRouteSpec<Before>,
];
