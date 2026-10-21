// Release 1.3 — P6 client-portal hooks — OWNED BY P6 (laid down by r3-foundation). Endpoints: server/src/routes/client.ts
// (the portal, client accounts only), routes/clientOffice.ts and routes/campaignPages.ts (the office side).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CampaignPage, ClientAccount, ClientInviteInput, ClientInviteResult, ClientPortal, ClientPost, ClientPostDecisionInput, ClientPostInput,
  ClientPostStatus,
} from '@lm/shared';
import { api, qs } from './client';

export const clientPortalKeys = {
  all: ['client-portal'] as const,
  portal: ['client-portal', 'portal'] as const,
  posts: (p: { status?: ClientPostStatus | null; campaignId?: number | null }) => ['client-portal', 'posts', p] as const,
  unread: ['client-portal', 'unread'] as const,
  campaignPage: (id: number) => ['client-portal', 'campaign-page', id] as const,
  accounts: (campaignId: number) => ['client-portal', 'accounts', campaignId] as const,
};

const invalidateClient = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: clientPortalKeys.all });
  void qc.invalidateQueries({ queryKey: ['announcements'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
};

// ── the client's own portal ──

/** GET /client/portal — their campaign, themself and their posts. */
export function useClientPortal({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: clientPortalKeys.portal, queryFn: () => api<ClientPortal>('/client/portal'), enabled });
}

/** POST /client/posts. */
export function useCreateClientPost() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: ClientPostInput) => api<ClientPost>('/client/posts', { method: 'POST', json: input }), onSuccess: () => invalidateClient(qc) });
}

// ── the office ──

export function useClientPosts(p: { status?: ClientPostStatus | null; campaignId?: number | null } = {}, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: clientPortalKeys.posts(p),
    queryFn: () => api<ClientPost[]>(`/client-posts${qs({ status: p.status ?? undefined, campaignId: p.campaignId ?? undefined })}`),
    enabled,
  });
}

/** The sidebar Campaigns badge (admin, leader). */
export function useUnreadClientPosts({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: clientPortalKeys.unread, queryFn: () => api<{ count: number }>('/client-posts/unread'), enabled, staleTime: 60_000 });
}

export function useMarkClientPostRead() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<void>(`/client-posts/${id}/read`, { method: 'POST' }), onSuccess: () => void qc.invalidateQueries({ queryKey: clientPortalKeys.unread }) });
}

export function useDecideClientPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, ...input }: ClientPostDecisionInput & { id: number; action: 'approve' | 'decline' | 'unpublish' }) =>
      api<ClientPost>(`/client-posts/${id}/${action}`, { method: 'POST', json: input }),
    onSuccess: () => {
      invalidateClient(qc);
      void qc.invalidateQueries({ queryKey: ['pay'] });
    },
  });
}

/** GET /campaigns/:id/page. */
export function useCampaignPage(id: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: clientPortalKeys.campaignPage(id ?? 0), queryFn: () => api<CampaignPage>(`/campaigns/${id}/page`), enabled: enabled && id != null });
}

export function useClientAccounts(campaignId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: clientPortalKeys.accounts(campaignId ?? 0), queryFn: () => api<ClientAccount[]>(`/campaigns/${campaignId}/client-accounts`), enabled: enabled && campaignId != null });
}

export function useInviteClient(campaignId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ClientInviteInput) => api<ClientInviteResult>(`/campaigns/${campaignId}/client-accounts`, { method: 'POST', json: input }),
    onSuccess: () => invalidateClient(qc),
  });
}

export function useUpdateClientAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: ClientAccount['status'] }) => api<ClientAccount>(`/client-accounts/${id}`, { method: 'PATCH', json: { status } }),
    onSuccess: () => invalidateClient(qc),
  });
}

export function useResetClientPin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<ClientAccount>(`/client-accounts/${id}/reset-pin`, { method: 'POST' }), onSuccess: () => invalidateClient(qc) });
}
