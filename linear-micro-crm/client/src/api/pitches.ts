// Release 1.2 — L2 learning-pitch hooks — OWNED BY L2 (laid down by r2-foundation). Endpoints: server/src/routes/pitches.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CampaignPitch, PitchListItem, PitchUpsertInput } from '@lm/shared';
import { api } from './client';

export const pitchKeys = {
  all: ['pitches'] as const,
  list: ['pitches', 'list'] as const,
  detail: (campaignCode: string) => ['pitches', 'detail', campaignCode.toUpperCase()] as const,
};

/** GET /pitches — one row per campaign, with or without a pitch. */
export function usePitches({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: pitchKeys.list, queryFn: () => api<PitchListItem[]>('/pitches'), enabled });
}

/** GET /pitches/:campaignCode — 404 (ApiError) when the campaign has no pitch yet. */
export function usePitch(campaignCode: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pitchKeys.detail(campaignCode ?? ''),
    queryFn: () => api<CampaignPitch>(`/pitches/${encodeURIComponent(campaignCode ?? '')}`),
    enabled: enabled && !!campaignCode,
    retry: false,
  });
}

/** PUT /pitches/:campaignCode (admin, leader) */
export function useSavePitch(campaignCode: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PitchUpsertInput) => api<CampaignPitch>(`/pitches/${encodeURIComponent(campaignCode)}`, { method: 'PUT', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pitchKeys.all }),
  });
}
