// Release 1.2 — U3 audit-trail hooks — OWNED BY U3. Endpoints: server/src/routes/audit.ts.
import { useCallback } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnnouncementReadStats, AuditEntity, AuditEntryDetail, AuditPage } from '@lm/shared';
import { api, qs } from './client';

export interface AuditParams {
  userId?: number | null;
  entity?: AuditEntity | '';
  entityId?: number | null;
  from?: string;
  to?: string;
  /** Words in the summary ("marked paid", "Jordan"). */
  q?: string;
  /** false leaves sign-ins and sign-outs out (changes only). */
  signIns?: boolean;
  limit?: number;
  offset?: number;
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (p: AuditParams) => ['audit', 'list', p] as const,
  entity: (entity: AuditEntity, id: number) => ['audit', 'entity', entity, id] as const,
  announcementReads: ['announcements', 'reads'] as const,
};

/** GET /audit (admin). Keeps the previous page on screen while the next one loads. */
export function useAuditLog(params: AuditParams, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: auditKeys.list(params),
    queryFn: () =>
      api<AuditPage>(
        `/audit${qs({ userId: params.userId ?? undefined, entity: params.entity || undefined, entityId: params.entityId ?? undefined, from: params.from, to: params.to, q: params.q, signIns: params.signIns === false ? 0 : undefined, limit: params.limit, offset: params.offset })}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

/** GET /audit/:entity/:entityId — the history behind the EntityHistory slot. */
export function useEntityHistory(entity: AuditEntity, entityId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: auditKeys.entity(entity, entityId ?? 0),
    queryFn: () => api<AuditEntryDetail[]>(`/audit/${entity}/${entityId}`),
    enabled: enabled && entityId != null,
    // fetched afresh each time a payslip or entry is opened: a change made a moment ago must show
    staleTime: 0,
  });
}

/** GET /announcements/reads — "Read by 18 of 34" for the announcements the caller may see stats for (newest 50). */
export function useAnnouncementReads({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: auditKeys.announcementReads, queryFn: () => api<AnnouncementReadStats[]>('/announcements/reads'), enabled });
}

/** POST /announcements/:id/read — idempotent. */
export function useMarkAnnouncementRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (announcementId: number) => api<void>(`/announcements/${announcementId}/read`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: auditKeys.announcementReads }),
  });
}

// ── "seen" receipts, batched ──
// Each announcement is reported once per person and device: the ids already reported live in memory and in
// localStorage ('lm-announcement-reads:<userId>', newest 200), so the dashboard does not post on every visit. Several
// cards coming into view together are sent in one burst followed by a single refresh of the stats.

const SEEN_KEY = (userId: number) => `lm-announcement-reads:${userId}`;
const SEEN_MAX = 200;
const seenByUser = new Map<number, Set<number>>();
const queued = new Map<number, Set<number>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function seenSet(userId: number): Set<number> {
  let set = seenByUser.get(userId);
  if (!set) {
    set = new Set<number>();
    try {
      const raw = window.localStorage.getItem(SEEN_KEY(userId));
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') set.add(id);
    } catch {
      /* storage blocked or corrupt: report again, the server ignores repeats */
    }
    seenByUser.set(userId, set);
  }
  return set;
}

function rememberSeen(userId: number, ids: number[]): void {
  const set = seenSet(userId);
  for (const id of ids) set.add(id);
  try {
    window.localStorage.setItem(SEEN_KEY(userId), JSON.stringify([...set].slice(-SEEN_MAX)));
  } catch {
    /* in-memory only */
  }
}

/** True when this person has already reported the announcement from this device. */
export function announcementSeen(userId: number, announcementId: number): boolean {
  return seenSet(userId).has(announcementId);
}

/** Returns `markSeen(id)`: queues POST /announcements/:id/read (once per person and device) and sends the batch shortly after. */
export function useMarkAnnouncementSeen(userId: number) {
  const qc = useQueryClient();
  return useCallback(
    (announcementId: number) => {
      if (announcementSeen(userId, announcementId)) return;
      const q = queued.get(userId) ?? new Set<number>();
      q.add(announcementId);
      queued.set(userId, q);
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const batches = [...queued.entries()];
        queued.clear();
        void Promise.all(
          batches.map(async ([uid, ids]) => {
            const list = [...ids];
            const results = await Promise.allSettled(list.map((id) => api<void>(`/announcements/${id}/read`, { method: 'POST' })));
            const sent = list.filter((_, i) => results[i]!.status === 'fulfilled');
            if (sent.length) rememberSeen(uid, sent);
            return sent.length;
          }),
        ).then((counts) => {
          if (counts.some((n) => n > 0)) void qc.invalidateQueries({ queryKey: auditKeys.announcementReads });
        });
      }, 400);
    },
    [qc, userId],
  );
}
