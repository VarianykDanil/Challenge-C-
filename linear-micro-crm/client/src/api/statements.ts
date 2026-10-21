// Release 1.3 — P3 statements hooks — OWNED BY P3 (laid down by r3-foundation). Endpoints: server/src/routes/statements.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckNowResult, ClientRef, MailSettings, MailSettingsInput, MailTestResult, StatementColumnMapping, StatementDetail, StatementRow,
  StatementSender, StatementStatus, StatementSummary, StatementTemplate,
} from '@lm/shared';
import { api, qs } from './client';

export const statementKeys = {
  all: ['statements'] as const,
  list: (p: { campaignId?: number | null; status?: StatementStatus | null }) => ['statements', 'list', p] as const,
  one: (id: number) => ['statements', 'one', id] as const,
  mail: ['statements', 'mail'] as const,
  senders: ['statements', 'senders'] as const,
  template: (campaignId: number) => ['statements', 'template', campaignId] as const,
  clientRefs: (userId: number) => ['statements', 'client-refs', userId] as const,
};

const invalidateStatements = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: statementKeys.all });
  void qc.invalidateQueries({ queryKey: ['finance'] });
  void qc.invalidateQueries({ queryKey: ['pay'] });
};

export function useStatements(p: { campaignId?: number | null; status?: StatementStatus | null } = {}, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: statementKeys.list(p),
    queryFn: () => api<StatementSummary[]>(`/statements${qs({ campaignId: p.campaignId ?? undefined, status: p.status ?? undefined })}`),
    enabled,
  });
}

export function useStatement(id: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: statementKeys.one(id ?? 0), queryFn: () => api<StatementDetail>(`/statements/${id}`), enabled: enabled && id != null });
}

/** The stored PDF, for an <iframe> or a download link. */
export const statementFileUrl = (id: number) => `/api/statements/${id}/file`;

export function useApplyStatement() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<StatementDetail>(`/statements/${id}/apply`, { method: 'POST' }), onSuccess: () => invalidateStatements(qc) });
}

export function useMatchStatementRow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statementId, rowId, userId }: { statementId: number; rowId: number; userId: number | null }) =>
      api<StatementRow>(`/statements/${statementId}/rows/${rowId}`, { method: 'PUT', json: { userId } }),
    onSuccess: () => invalidateStatements(qc),
  });
}

export function useCheckStatementsNow() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api<CheckNowResult>('/statements/check-now', { method: 'POST' }), onSuccess: () => invalidateStatements(qc) });
}

export function useMailSettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: statementKeys.mail, queryFn: () => api<MailSettings>('/statements/mail'), enabled });
}

export function useSaveMailSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: MailSettingsInput) => api<MailSettings>('/statements/mail', { method: 'PUT', json: input }), onSuccess: () => invalidateStatements(qc) });
}

export function useTestMail() {
  return useMutation({ mutationFn: () => api<MailTestResult>('/statements/mail/test', { method: 'POST' }) });
}

export function useStatementSenders({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: statementKeys.senders, queryFn: () => api<StatementSender[]>('/statements/senders'), enabled });
}

export function useSaveStatementSenders() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (rows: StatementSender[]) => api<StatementSender[]>('/statements/senders', { method: 'PUT', json: rows }), onSuccess: () => invalidateStatements(qc) });
}

export function useStatementTemplate(campaignId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: statementKeys.template(campaignId ?? 0), queryFn: () => api<StatementTemplate>(`/statements/templates/${campaignId}`), enabled: enabled && campaignId != null });
}

export function useSaveStatementTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, mapping }: { campaignId: number; mapping: StatementColumnMapping }) =>
      api<StatementTemplate>(`/statements/templates/${campaignId}`, { method: 'PUT', json: mapping }),
    onSuccess: () => invalidateStatements(qc),
  });
}

/** Team → person → "Client IDs" (admin). */
export function useClientRefs(userId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: statementKeys.clientRefs(userId ?? 0), queryFn: () => api<ClientRef[]>(`/statements/client-refs${qs({ userId: userId ?? undefined })}`), enabled: enabled && userId != null });
}

export function useSaveClientRefs(userId: number) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (refs: ClientRef[]) => api<ClientRef[]>(`/statements/client-refs/${userId}`, { method: 'PUT', json: refs }), onSuccess: () => invalidateStatements(qc) });
}

/** POST /statements/upload — a PDF as multipart/form-data (field "file"; P3 decides the extra fields). */
export function useUploadStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api<StatementSummary>('/statements/upload', { method: 'POST', body: form }),
    onSuccess: () => invalidateStatements(qc),
  });
}
