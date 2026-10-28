// Release 1.4 — F payments-foundation hooks (packages P and A use the same ones). Endpoints: server/src/routes/payments.ts
// and routes/bankDetails.ts; contracts: shared/src/types/payments.ts. Every payment write also refreshes Finance (runs
// paid or failed), the dashboard and the Needs-attention feed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BankDetailsConfirmInput, BankDetailsInput, BankDetailsReportInput, BankDetailsView, PaymentBatch, PaymentBatchInput, PaymentBatchSummary,
  PaymentCancelInput, PaymentConnection, PaymentConnectionInput, PaymentConnectionPatch, PaymentConnectionTestResult, PaymentMarkPaidInput,
  PaymentProviderView, PaymentsSettings, PaymentsSettingsInput, PaymentTestFile, PaymentTestFileInput, PaymentTestFileResultInput,
} from '@lm/shared';
import { api } from './client';

export const paymentKeys = {
  all: ['payments'] as const,
  providers: ['payments', 'providers'] as const,
  connections: ['payments', 'connections'] as const,
  batches: ['payments', 'batches'] as const,
  batch: (id: number) => ['payments', 'batches', id] as const,
  bank: (userId: number | 'me') => ['bank-details', userId] as const,
  settings: ['payments', 'settings'] as const,
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
/** After a bank file's download: `{ confirm: 'NOT UPLOADED', code }` (the file is then void). */
export const useCancelBatch = batchAction<PaymentCancelInput>('cancel');
export const useMarkBatchPaid = batchAction<PaymentMarkPaidInput>('mark-paid');

// ── Settings → Payments: two approvals, the 1p test file ──

export function usePaymentsSettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: paymentKeys.settings, queryFn: () => api<PaymentsSettings>('/payments/settings'), enabled });
}

export function useSavePaymentsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PaymentsSettingsInput) => api<PaymentsSettings>('/payments/settings', { method: 'PUT', json: input }),
    onSuccess: (v) => qc.setQueryData(paymentKeys.settings, v),
  });
}

/** "Make a 1p test file": the file comes back in the answer (never stored); the page saves it. */
export function useMakeTestFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: PaymentTestFileInput }) => api<PaymentTestFile>(`/payments/connections/${id}/test-file`, { method: 'POST', json: input }),
    onSettled: () => void qc.invalidateQueries({ queryKey: paymentKeys.connections }),
  });
}

export function useTestFileResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, result }: { id: number; result: PaymentTestFileResultInput['result'] }) => api<PaymentConnection>(`/payments/connections/${id}/test-file-result`, { method: 'POST', json: { result } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: paymentKeys.connections }),
  });
}

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
export function useConfirmBankDetails(userId: number | null) {
  const qc = useQueryClient();
  const key = paymentKeys.bank(userId ?? 'me');
  return useMutation({
    // an administrator always sends a fresh code; the person ("Yes, these are mine") when they have two-step on
    mutationFn: (input: BankDetailsConfirmInput) =>
      api<BankDetailsView>(userId ? `/users/${userId}/bank-details/confirm` : '/me/bank-details/confirm', { method: 'POST', json: input }),
    onSuccess: (v) => {
      qc.setQueryData(key, v);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/** "These are not my details" (own account only): payments to them stop until new ones are typed in. */
export function useReportBankDetails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankDetailsReportInput) => api<BankDetailsView>('/me/bank-details/report', { method: 'POST', json: input }),
    onSuccess: (v) => {
      qc.setQueryData(paymentKeys.bank('me'), v);
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
