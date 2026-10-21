// Release 1.3 — P1 pay-rule hooks — OWNED BY P1 (laid down by r3-foundation). Endpoints: server/src/routes/pay.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BonusInput, CampaignRate, CampaignRateInput, ManualAdjustmentInput, PayAdjustment, PayRuleSettings, PayRuleSettingsInput, WeekPayBreakdown } from '@lm/shared';
import { api, qs } from './client';

export const payKeys = {
  all: ['pay'] as const,
  settings: ['pay', 'settings'] as const,
  rates: (campaignId?: number | null) => ['pay', 'rates', campaignId ?? null] as const,
  breakdown: (userId: number, weekStart: string) => ['pay', 'breakdown', userId, weekStart] as const,
  adjustments: (userId?: number | null, weekStart?: string | null) => ['pay', 'adjustments', userId ?? null, weekStart ?? null] as const,
};

/** Every pay-related query (the finance pages' too) — invalidate after a pay write. */
const invalidatePay = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: payKeys.all });
  void qc.invalidateQueries({ queryKey: ['finance'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
};

/** GET /pay/settings (admin). */
export function usePaySettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: payKeys.settings, queryFn: () => api<PayRuleSettings>('/pay/settings'), enabled });
}

/** PUT /pay/settings (admin). */
export function useUpdatePaySettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: PayRuleSettingsInput) => api<PayRuleSettings>('/pay/settings', { method: 'PUT', json: input }), onSuccess: () => invalidatePay(qc) });
}

/** GET /pay/rates?campaignId= (admin, leader). */
export function useCampaignRates(campaignId?: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: payKeys.rates(campaignId), queryFn: () => api<CampaignRate[]>(`/pay/rates${qs({ campaignId: campaignId ?? undefined })}`), enabled });
}

/** POST /pay/rates (admin). */
export function useAddCampaignRate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CampaignRateInput) => api<CampaignRate>('/pay/rates', { method: 'POST', json: input }), onSuccess: () => invalidatePay(qc) });
}

/** GET /pay/breakdown?userId=&weekStart= — one person's week under the 1.3 rule. */
export function usePayBreakdown(userId: number | null | undefined, weekStart: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: payKeys.breakdown(userId ?? 0, weekStart ?? ''),
    queryFn: () => api<WeekPayBreakdown>(`/pay/breakdown${qs({ userId: userId ?? undefined, weekStart: weekStart ?? undefined })}`),
    enabled: enabled && userId != null && !!weekStart,
  });
}

/** GET /pay/adjustments?userId=&weekStart=. */
export function usePayAdjustments(userId?: number | null, weekStart?: string | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: payKeys.adjustments(userId, weekStart),
    queryFn: () => api<PayAdjustment[]>(`/pay/adjustments${qs({ userId: userId ?? undefined, weekStart: weekStart ?? undefined })}`),
    enabled,
  });
}

/** POST /pay/bonuses (admin) — "Add a bonus". */
export function useAddBonus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: BonusInput) => api<PayAdjustment>('/pay/bonuses', { method: 'POST', json: input }), onSuccess: () => invalidatePay(qc) });
}

/** POST /pay/adjustments (admin). */
export function useAddAdjustment() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: ManualAdjustmentInput) => api<PayAdjustment>('/pay/adjustments', { method: 'POST', json: input }), onSuccess: () => invalidatePay(qc) });
}

/** DELETE /pay/adjustments/:id (admin). */
export function useRemoveAdjustment() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<void>(`/pay/adjustments/${id}`, { method: 'DELETE' }), onSuccess: () => invalidatePay(qc) });
}
