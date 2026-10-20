// Release 1.2 — U3 audit-trail hooks — OWNED BY U3 (laid down by r2-foundation). Endpoints: server/src/routes/audit.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnnouncementReadStats, AuditEntity, AuditEntryDetail, AuditPage } from '@lm/shared';
import { api, qs } from './client';

export interface AuditParams {
  userId?: number | null;
  entity?: AuditEntity | '';
  entityId?: number | null;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (p: AuditParams) => ['audit', 'list', p] as const,
  entity: (entity: AuditEntity, id: number) => ['audit', 'entity', entity, id] as const,
  announcementReads: ['announcements', 'reads'] as const,
};

/** GET /audit (admin) */
export function useAuditLog(params: AuditParams, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: auditKeys.list(params),
    queryFn: () =>
      api<AuditPage>(`/audit${qs({ userId: params.userId ?? undefined, entity: params.entity || undefined, entityId: params.entityId ?? undefined, from: params.from, to: params.to, limit: params.limit, offset: params.offset })}`),
    enabled,
  });
}

/** GET /audit/:entity/:entityId — the history behind the EntityHistory slot. */
export function useEntityHistory(entity: AuditEntity, entityId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: auditKeys.entity(entity, entityId ?? 0),
    queryFn: () => api<AuditEntryDetail[]>(`/audit/${entity}/${entityId}`),
    enabled: enabled && entityId != null,
  });
}

/** GET /announcements/reads — "Read by 18 of 34" for the announcements the caller may see stats for. */
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
