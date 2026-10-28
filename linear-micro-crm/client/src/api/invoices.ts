// Release 1.3 — P2 invoices hooks — OWNED BY P2 (laid down by r3-foundation). Endpoints: server/src/routes/invoices.ts.
// Every write invalidates the invoices, the finance views (payroll rows carry run.invoice) and the attention feed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompanySettings, CompanySettingsInput, Invoice, InvoiceDisputeInput, InvoiceDisputeRow, InvoiceListRow, InvoiceProfile, InvoiceProfileInput,
  InvoiceResolveInput, InvoiceStatus, InvoiceVatConfirmInput, PayrollRunWithUser, SelfBillingAgreement,
} from '@lm/shared';
import { api, qs } from './client';

export const invoiceKeys = {
  all: ['invoices'] as const,
  agreement: ['invoices', 'agreement'] as const,
  profile: (userId?: number | null) => ['invoices', 'profile', userId ?? 'me'] as const,
  company: ['invoices', 'company'] as const,
  list: (p: { userId?: number | null; weekStart?: string | null; status?: InvoiceStatus | null }) => ['invoices', 'list', p] as const,
  byRun: (runId: number) => ['invoices', 'by-run', runId] as const,
  one: (id: number) => ['invoices', 'one', id] as const,
  disputes: ['invoices', 'disputes'] as const,
};

const invalidateInvoices = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: invoiceKeys.all });
  void qc.invalidateQueries({ queryKey: ['finance'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
};

export function useAgreement({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.agreement, queryFn: () => api<SelfBillingAgreement>('/invoices/agreement'), enabled, staleTime: 5 * 60_000 });
}

export function useAcceptAgreement() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api<SelfBillingAgreement>('/invoices/agreement/accept', { method: 'POST' }), onSuccess: () => invalidateInvoices(qc) });
}

/** GET /invoices/profile (mine) or /invoices/profile/:userId (admin). */
export function useInvoiceProfile(userId?: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.profile(userId), queryFn: () => api<InvoiceProfile>(userId ? `/invoices/profile/${userId}` : '/invoices/profile'), enabled });
}

export function useSaveInvoiceProfile(userId?: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceProfileInput) => api<InvoiceProfile>(userId ? `/invoices/profile/${userId}` : '/invoices/profile', { method: 'PUT', json: input }),
    onSuccess: () => invalidateInvoices(qc),
  });
}

/** POST /invoices/profile/:userId/vat/confirm (an administrator, with a fresh code): VAT is charged from then on. */
export function useConfirmInvoiceVat(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceVatConfirmInput) => api<InvoiceProfile>(`/invoices/profile/${userId}/vat/confirm`, { method: 'POST', json: input }),
    onSuccess: (p) => {
      qc.setQueryData(invoiceKeys.profile(userId), p);
      invalidateInvoices(qc);
    },
  });
}

export function useCompanySettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.company, queryFn: () => api<CompanySettings>('/invoices/company'), enabled });
}

export function useSaveCompanySettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CompanySettingsInput) => api<CompanySettings>('/invoices/company', { method: 'PUT', json: input }), onSuccess: () => invalidateInvoices(qc) });
}

export function useInvoices(p: { userId?: number | null; weekStart?: string | null; status?: InvoiceStatus | null } = {}, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: invoiceKeys.list(p),
    queryFn: () => api<InvoiceListRow[]>(`/invoices${qs({ userId: p.userId ?? undefined, weekStart: p.weekStart ?? undefined, status: p.status ?? undefined })}`),
    enabled,
  });
}

/** GET /invoices/by-run/:runId — the invoice behind a payslip. Only ask for runs that carry `run.invoice` (else 404). */
export function useInvoiceForRun(runId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.byRun(runId ?? 0), queryFn: () => api<Invoice>(`/invoices/by-run/${runId}`), enabled: enabled && runId != null });
}

export function useInvoice(id: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.one(id ?? 0), queryFn: () => api<Invoice>(`/invoices/${id}`), enabled: enabled && id != null });
}

export function useAcceptInvoice() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<Invoice>(`/invoices/${id}/accept`, { method: 'POST' }), onSettled: () => invalidateInvoices(qc) });
}

export function useDisputeInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: InvoiceDisputeInput & { id: number }) => api<Invoice>(`/invoices/${id}/dispute`, { method: 'POST', json: input }),
    onSettled: () => invalidateInvoices(qc),
  });
}

export function useInvoiceDisputes({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: invoiceKeys.disputes, queryFn: () => api<InvoiceDisputeRow[]>('/invoices/disputes'), enabled });
}

export function useResolveInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: InvoiceResolveInput & { id: number }) => api<Invoice>(`/invoices/${id}/resolve`, { method: 'POST', json: input }),
    onSettled: () => invalidateInvoices(qc),
  });
}

/** P2: Mark paid without an accepted invoice — POST /finance/payroll/:id/pay with the admin's reason (audited). */
export function useMarkPaidWithReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, overrideReason }: { runId: number; overrideReason: string }) =>
      api<PayrollRunWithUser>(`/finance/payroll/${runId}/pay`, { method: 'POST', json: { overrideReason } }),
    onSettled: () => invalidateInvoices(qc),
  });
}
