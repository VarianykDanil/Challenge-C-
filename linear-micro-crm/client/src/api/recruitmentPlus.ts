// Release 1.3 — P7 recruitment-plus hooks — OWNED BY P7 (laid down by r3-foundation). Endpoints:
// server/src/routes/recruitmentPlus.ts (and P7's changes to routes/recruitment.ts, used through api/hooks.ts).
//
// The keys live under ['recruitment', 'plus', …], so the 1.0 recruitment hooks (useCreateInterview,
// useUpdateInterview, useMoveCandidateStage …, which invalidate ['recruitment']) refresh the schedule, the timeline
// and the sheets as well.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CandidateSheet, CandidateTimelineItem, InterviewAnswerInput, InterviewQuestion, InterviewQuestionInput, InterviewQuestionOrderInput, InterviewScheduleItem,
  InterviewSheet, InterviewType,
} from '@lm/shared';
import { api, qs } from './client';

export interface ScheduleParams {
  from?: string;
  to?: string;
  /** A person, 'none' (no interviewer yet) or nothing (everyone). */
  interviewerId?: number | 'none' | null;
  type?: InterviewType | null;
}

export const recruitmentPlusKeys = {
  all: ['recruitment', 'plus'] as const,
  schedule: (p: ScheduleParams) => ['recruitment', 'plus', 'schedule', p] as const,
  timeline: (candidateId: number) => ['recruitment', 'plus', 'timeline', candidateId] as const,
  sheets: (candidateId: number) => ['recruitment', 'plus', 'sheets', candidateId] as const,
  questions: (type?: InterviewType | null) => ['recruitment', 'plus', 'questions', type ?? null] as const,
  sheet: (interviewId: number) => ['recruitment', 'plus', 'sheet', interviewId] as const,
};

export function useInterviewSchedule(p: ScheduleParams, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: recruitmentPlusKeys.schedule(p),
    queryFn: () => api<InterviewScheduleItem[]>(`/recruitment/schedule${qs({ from: p.from, to: p.to, interviewerId: p.interviewerId ?? undefined, type: p.type ?? undefined })}`),
    enabled,
  });
}

export function useCandidateTimeline(candidateId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.timeline(candidateId ?? 0), queryFn: () => api<CandidateTimelineItem[]>(`/recruitment/candidates/${candidateId}/timeline`), enabled: enabled && candidateId != null });
}

/** The candidate's saved interview sheets: the questions and answers as asked. */
export function useCandidateSheets(candidateId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.sheets(candidateId ?? 0), queryFn: () => api<CandidateSheet[]>(`/recruitment/candidates/${candidateId}/sheets`), enabled: enabled && candidateId != null });
}

export function useInterviewQuestions(type?: InterviewType | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.questions(type), queryFn: () => api<InterviewQuestion[]>(`/recruitment/questions${qs({ type: type ?? undefined })}`), enabled });
}

export function useSaveInterviewQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<InterviewQuestionInput> & { id?: number }) =>
      id ? api<InterviewQuestion>(`/recruitment/questions/${id}`, { method: 'PATCH', json: input }) : api<InterviewQuestion>('/recruitment/questions', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recruitment', 'plus', 'questions'] }),
  });
}

/** PUT /recruitment/questions/order — every question of one type, in the new order. */
export function useReorderInterviewQuestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InterviewQuestionOrderInput) => api<InterviewQuestion[]>('/recruitment/questions/order', { method: 'PUT', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recruitment', 'plus', 'questions'] }),
  });
}

export function useInterviewSheet(interviewId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.sheet(interviewId ?? 0), queryFn: () => api<InterviewSheet>(`/recruitment/interviews/${interviewId}/sheet`), enabled: enabled && interviewId != null });
}

/**
 * PUT /recruitment/interviews/:id/answers — the sheet's autosave: the questions this device changed, each with its
 * `base` (409 with InterviewSheetConflictDetails when another device changed the same question first). A plain
 * function, not a hook, so a save queued as the page is left still runs and still updates the cache
 * (features/recruitment/sheetSaveQueue.ts). `keepalive` for the last save as the tab closes. With `qc` null the caller
 * stores the answer itself (the sheet page merges it into its rows first, then calls storeSavedSheet).
 */
export async function putInterviewAnswers(qc: QueryClient | null, interviewId: number, answers: InterviewAnswerInput[], { keepalive = false }: { keepalive?: boolean } = {}): Promise<InterviewSheet> {
  const sheet = await api<InterviewSheet>(`/recruitment/interviews/${interviewId}/answers`, { method: 'PUT', json: answers, keepalive });
  if (qc) storeSavedSheet(qc, sheet);
  return sheet;
}

/** A sheet the server sent back (a save, or a 409's latest): into the cache, and the views that count its answers refreshed. */
export function storeSavedSheet(qc: QueryClient, sheet: InterviewSheet): void {
  qc.setQueryData(recruitmentPlusKeys.sheet(sheet.interview.id), sheet);
  void qc.invalidateQueries({ queryKey: recruitmentPlusKeys.sheets(sheet.candidate.id) });
  void qc.invalidateQueries({ queryKey: ['recruitment', 'plus', 'schedule'] });
}

/** The same save as a mutation hook (foundation contract); the sheet page uses putInterviewAnswers through its queue. */
export function useSaveInterviewAnswers(interviewId: number) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (answers: InterviewAnswerInput[]) => putInterviewAnswers(qc, interviewId, answers) });
}
