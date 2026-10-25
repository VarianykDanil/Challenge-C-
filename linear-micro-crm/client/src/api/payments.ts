// Release 1.4 — F payments-foundation hooks (packages P and A use the same ones). Endpoints: server/src/routes/payments.ts
// and routes/bankDetails.ts; contracts: shared/src/types/payments.ts. Every payment write also refreshes Finance (runs
// paid or failed), the dashboard and the Needs-attention feed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BankDetailsInput, BankDetailsView, PaymentBatch, PaymentBatchInput, PaymentBatchSummary, PaymentConnection, PaymentConnectionInput,
  PaymentConnectionPatch, PaymentConnectionTestResult, PaymentMarkPaidInput, PaymentProviderView,
} from '@lm/shared';
import { api } from './client';

export const paymentKeys = {
  all: ['payments'] as const,
  providers: ['payments', 'providers'] as const,
  connections: ['payments', 'connections'] as const,
  batches: ['payments', 'batches'] as const,
  batch: (id: number) => ['payments', 'batches', id] as const,
  bank: (userId: number | 'me') => ['bank-details', userId] as const,
};

function invalidatePayments(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: paymentKeys.all });
  void qc.invalidateQueries({ queryKey: ['finance'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function usePaymentProviders({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: paymentKeys.providers, queryFn: () => api<PaymentProviderView[]>('/payments/providers'), enabled, staleTime: 5 * 60_000 });
}

export function usePaymentConnections({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: paymentKeys.connections, queryFn: () => api<PaymentConnection[]>('/payments/connections'), enabled });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: PaymentConnectionInput) => api<PaymentConnection>('/payments/connections', { method: 'POST', json: input }), onSuccess: () => invalidatePayments(qc) });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: PaymentConnectionPatch }) => api<PaymentConnection>(`/payments/connections/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => invalidatePayments(qc),
  });
}

export function useDisconnectConnection() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<PaymentConnection>(`/payments/connections/${id}`, { method: 'DELETE' }), onSuccess: () => invalidatePayments(qc) });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<PaymentConnectionTestResult>(`/payments/connections/${id}/test`, { method: 'POST' }),
    onSettled: () => invalidatePayments(qc),
  });
}

export function usePaymentBatches({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: paymentKeys.batches, queryFn: () => api<PaymentBatchSummary[]>('/payments/batches'), enabled });
}

/** One payment; `poll` refetches every 10 s while something is still on its way (the server checks the provider). */
export function usePaymentBatch(id: number | null, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: paymentKeys.batch(id ?? 0),
    queryFn: () => api<PaymentBatch>(`/payments/batches/${id}`),
    enabled: id != null && id > 0,
    refetchInterval: (q) => (poll && q.state.data && (q.state.data.status === 'submitted' || q.state.data.status === 'processing') && q.state.data.kind === 'api' ? 10_000 : false),
  });
}

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: PaymentBatchInput) => api<PaymentBatch>('/payments/batches', { method: 'POST', json: input }), onSuccess: () => invalidatePayments(qc) });
}

function batchAction<T>(path: string, method = 'POST') {
  return function useBatchAction() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: ({ id, body }: { id: number; body?: T }) => api<PaymentBatch>(`/payments/batches/${id}/${path}`, { method, json: body ?? {} }),
      onSuccess: (b) => qc.setQueryData(paymentKeys.batch(b.id), b),
      onSettled: () => invalidatePayments(qc),
    });
  };
}

export const useApproveBatch = batchAction<{ code: string }>('approve');
export const useRefreshBatch = batchAction<Record<string, never>>('refresh');
export const useCancelBatch = batchAction<Record<string, never>>('cancel');
export const useMarkBatchPaid = batchAction<PaymentMarkPaidInput>('mark-paid');

/** The bank file (admin): a plain link (the session cookie goes with it). */
export function paymentFileUrl(id: number): string {
  return `/api/payments/batches/${id}/file`;
}

// ── bank details ──

/** Own (`userId` null) or, for an admin, someone's. */
export function useBankDetails(userId: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentKeys.bank(userId ?? 'me'),
    queryFn: () => api<BankDetailsView>(userId ? `/users/${userId}/bank-details` : '/me/bank-details'),
    enabled,
  });
}

export function useSaveBankDetails(userId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankDetailsInput) => api<BankDetailsView>(userId ? `/users/${userId}/bank-details` : '/me/bank-details', { method: 'PUT', json: input }),
    onSuccess: (v) => {
      qc.setQueryData(paymentKeys.bank(userId ?? 'me'), v);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * Review fix (cross:X-2): sends the `changedAt` of the details on screen, so the server confirms exactly those; if the
 * person changed them again meanwhile it answers 409 and the card reloads to show the new ones.
 */
export function useConfirmBankDetails(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changedAt: string) => api<BankDetailsView>(`/users/${userId}/bank-details/confirm`, { method: 'POST', json: { changedAt } }),
    onSuccess: (v) => {
      qc.setQueryData(paymentKeys.bank(userId), v);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: () => void qc.invalidateQueries({ queryKey: paymentKeys.bank(userId) }),
  });
}
