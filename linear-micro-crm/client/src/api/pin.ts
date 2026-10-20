// Release 1.2 — U1 sign-in-pin hooks — OWNED BY U1 (laid down by r2-foundation). Endpoints: server/src/routes/auth.ts.
// Keys start with 'auth', so the existing ['auth'] invalidations refresh them too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PinSetInput, PinStatus, SecuritySettings } from '@lm/shared';
import { api } from './client';

export const pinKeys = {
  status: ['auth', 'pin'] as const,
  securitySettings: ['auth', 'security-settings'] as const,
};

/** GET /auth/pin — your own PIN state. */
export function usePinStatus({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: pinKeys.status, queryFn: () => api<PinStatus>('/auth/pin'), enabled });
}

/** POST /auth/pin — set, or change with the current PIN. */
export function useSetPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PinSetInput) => api<void>('/auth/pin', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auth'] }),
  });
}

/** POST /auth/pin/reset/:userId (admin) — clears another person's PIN and signs them out. */
export function useResetUserPin(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/auth/pin/reset/${userId}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

/** GET /auth/security-settings (admin) */
export function useSecuritySettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: pinKeys.securitySettings, queryFn: () => api<SecuritySettings>('/auth/security-settings'), enabled });
}

/** PUT /auth/security-settings (admin) */
export function useUpdateSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<SecuritySettings>) => api<SecuritySettings>('/auth/security-settings', { method: 'PUT', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auth'] }),
  });
}
