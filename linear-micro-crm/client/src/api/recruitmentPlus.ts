// Release 1.3 — P7 recruitment-plus hooks — OWNED BY P7 (laid down by r3-foundation). Endpoints:
// server/src/routes/recruitmentPlus.ts (and P7's changes to routes/recruitment.ts, used through api/hooks.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CandidateTimelineItem, InterviewAnswerInput, InterviewQuestion, InterviewQuestionInput, InterviewScheduleItem, InterviewSheet, InterviewType,
} from '@lm/shared';
import { api, qs } from './client';

export interface ScheduleParams {
  from?: string;
  to?: string;
  interviewerId?: number | null;
  type?: InterviewType | null;
}

export const recruitmentPlusKeys = {
  all: ['recruitment-plus'] as const,
  schedule: (p: ScheduleParams) => ['recruitment-plus', 'schedule', p] as const,
  timeline: (candidateId: number) => ['recruitment-plus', 'timeline', candidateId] as const,
  questions: (type?: InterviewType | null) => ['recruitment-plus', 'questions', type ?? null] as const,
  sheet: (interviewId: number) => ['recruitment-plus', 'sheet', interviewId] as const,
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

export function useInterviewQuestions(type?: InterviewType | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.questions(type), queryFn: () => api<InterviewQuestion[]>(`/recruitment/questions${qs({ type: type ?? undefined })}`), enabled });
}

export function useSaveInterviewQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<InterviewQuestionInput> & { id?: number }) =>
      id ? api<InterviewQuestion>(`/recruitment/questions/${id}`, { method: 'PATCH', json: input }) : api<InterviewQuestion>('/recruitment/questions', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recruitment-plus', 'questions'] }),
  });
}

export function useInterviewSheet(interviewId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: recruitmentPlusKeys.sheet(interviewId ?? 0), queryFn: () => api<InterviewSheet>(`/recruitment/interviews/${interviewId}/sheet`), enabled: enabled && interviewId != null });
}

/** PUT /recruitment/interviews/:id/answers — the sheet's autosave. */
export function useSaveInterviewAnswers(interviewId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (answers: InterviewAnswerInput[]) => api<InterviewSheet>(`/recruitment/interviews/${interviewId}/answers`, { method: 'PUT', json: answers }),
    onSuccess: (sheet) => qc.setQueryData(recruitmentPlusKeys.sheet(interviewId), sheet),
  });
}
