/**
 * Release 1.3 — OWNED BY P8 venue-insights. This package's audit specs, in the shape of lib/auditSpecs.ts
 * (AuditRouteSpec: method, pattern, before, after → AuditDraft[]), registered through ./registry.ts (P9 owns the
 * registry; this file is the only one this package edits for audit). Covered:
 *  - PUT    /events/:id/roster      "Bookings for BCN — Golden Square, 22 Oct: booked Jordan Lee and Sam Patel; took off Alex Kim"
 *  - POST   /events/:id/roster/me   "Jordan Lee is working BCN — Golden Square, 22 Oct (I'm working this)"
 *  - DELETE /events/:id/roster/me   "Jordan Lee can no longer work BCN — Golden Square, 22 Oct"
 * Entity 'event_roster', filed under the EVENT id (Audit → that event's history shows its bookings). The snapshot is
 * the event's name and day and who is booked (names, sorted) — no PINs, codes or secrets are anywhere near it. A save
 * that changes nothing (the same list, booking twice, coming off when not booked) writes no row.
 */
import { auditDayLabel, personName, type UserWithTeam } from '@lm/shared';
import { all, get, type Db } from '../../db/connection.ts';
import type { AuditCall, AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';

interface RosterSnap {
  eventId: number;
  eventName: string;
  date: string;
  booked: string[];
  /** Ids in the same order as `booked` (not shown; lets the summary tell people with the same name apart). */
  ids: number[];
}

const toId = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** The event and who is booked on it, or null when the event does not exist (or the read fails). */
export function rosterSnapshot(db: Db, eventId: number | null): RosterSnap | null {
  if (!eventId) return null;
  try {
    const ev = get<{ id: number; name: string; date: string }>(db, `SELECT id, name, date FROM events WHERE id = ?`, [eventId]);
    if (!ev) return null;
    const people = all<{ id: number; name: string }>(
      db,
      `SELECT u.id, TRIM(u.first_name || ' ' || u.last_name) AS name FROM event_roster r JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ? ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.id`,
      [eventId],
    );
    return { eventId: ev.id, eventName: ev.name, date: ev.date, booked: people.map((p) => p.name), ids: people.map((p) => Number(p.id)) };
  } catch {
    return null;
  }
}

/** What the trail stores: the event, its day and the names booked (ids stay out of the diff). */
const stored = (s: RosterSnap | null) => (s ? { event: s.eventName, date: s.date, booked: s.booked, count: s.booked.length } : null);

const place = (s: RosterSnap) => `${s.eventName}, ${auditDayLabel(s.date)}`;

/** "Jordan Lee", "Jordan Lee and Sam Patel", "Jordan Lee, Sam Patel and Alex Kim", "… and 2 more". */
function names(list: readonly string[], max = 3): string {
  if (list.length <= 1) return list[0] ?? '';
  if (list.length > max) return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

const nameOf = (s: RosterSnap, id: number) => s.booked[s.ids.indexOf(id)] ?? 'Someone';
const meName = (me: UserWithTeam | null) => (me ? personName(me) : 'Someone');

/** Who joined and who left between two snapshots (by id). */
function changes(before: RosterSnap | null, after: RosterSnap): { added: string[]; removed: string[] } {
  const was = new Set(before?.ids ?? []);
  const now = new Set(after.ids);
  return {
    added: after.ids.filter((id) => !was.has(id)).map((id) => nameOf(after, id)),
    removed: (before?.ids ?? []).filter((id) => !now.has(id)).map((id) => nameOf(before!, id)),
  };
}

const before = (db: Db, call: AuditCall) => rosterSnapshot(db, toId(call.params.id));

function draft(after: RosterSnap, prior: RosterSnap | null, summary: string): AuditDraft[] {
  return [{ entity: 'event_roster', entityId: after.eventId, summary, before: stored(prior), after: stored(after) }];
}

export const AUDIT_SPECS: readonly AuditRouteSpec<RosterSnap | null>[] = [
  {
    method: 'POST',
    pattern: '/events/:id/roster/me',
    before,
    after(db: Db, done: AuditDone, prior) {
      const now = rosterSnapshot(db, toId(done.params.id));
      if (!now) return [];
      const { added } = changes(prior ?? null, now);
      if (!added.length) return [];
      return draft(now, prior ?? null, `${meName(done.me)} is working ${place(now)} (I'm working this)`);
    },
  },
  {
    method: 'DELETE',
    pattern: '/events/:id/roster/me',
    before,
    after(db: Db, done: AuditDone, prior) {
      const now = rosterSnapshot(db, toId(done.params.id));
      if (!now) return [];
      const { removed } = changes(prior ?? null, now);
      if (!removed.length) return [];
      return draft(now, prior ?? null, `${meName(done.me)} can no longer work ${place(now)}`);
    },
  },
  {
    method: 'PUT',
    pattern: '/events/:id/roster',
    before,
    after(db: Db, done: AuditDone, prior) {
      const now = rosterSnapshot(db, toId(done.params.id));
      if (!now) return [];
      const { added, removed } = changes(prior ?? null, now);
      if (!added.length && !removed.length) return [];
      const parts = [added.length ? `booked ${names(added)}` : '', removed.length ? `took off ${names(removed)}` : ''].filter(Boolean);
      return draft(now, prior ?? null, `Bookings for ${place(now)}: ${parts.join('; ')}`);
    },
  },
];
