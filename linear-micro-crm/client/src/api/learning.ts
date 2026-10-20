// Release 1.2 — L1 learning-pack hooks — OWNED BY L1 (laid down by r2-foundation). Endpoints: server/src/routes/learning.ts.
// Every key starts with 'learning', so invalidating ['learning'] refreshes all of them.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningProgress, LessonKey, LessonProgress, LessonQuizInput, LessonQuizResult, Progression, ProgressionMilestoneInput, ProgressionMilestoneKey, TeachbackInput, TeachbackSignoffInput, TeamLearning } from '@lm/shared';
import { api, qs } from './client';

export const learningKeys = {
  all: ['learning'] as const,
  progress: (userId?: number | null) => ['learning', 'progress', userId ?? 'me'] as const,
  team: ['learning', 'team'] as const,
  progression: (userId: number) => ['learning', 'progression', userId] as const,
};

/** GET /learning/progress — your own, or (leader / admin) someone's in scope with `userId`. */
export function useLearningProgress(userId?: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.progress(userId),
    queryFn: () => api<LearningProgress>(`/learning/progress${qs({ userId: userId ?? undefined })}`),
    enabled,
  });
}

/** GET /learning/team — leader: own team; admin: everyone. */
export function useTeamLearning({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: learningKeys.team, queryFn: () => api<TeamLearning>('/learning/team'), enabled });
}

/** GET /learning/progression/:userId — level and what the next one needs. */
export function useProgression(userId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.progression(userId ?? 0),
    queryFn: () => api<Progression>(`/learning/progression/${userId}`),
    enabled: enabled && userId != null,
  });
}

function useInvalidateLearning() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: learningKeys.all });
}

/** POST /learning/progress/:lessonKey/quiz */
export function useSubmitQuiz() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: ({ lessonKey, ...input }: LessonQuizInput & { lessonKey: LessonKey }) =>
      api<LessonQuizResult>(`/learning/progress/${lessonKey}/quiz`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** POST /learning/progress/:lessonKey/teachback */
export function useSubmitTeachback() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: ({ lessonKey, ...input }: TeachbackInput & { lessonKey: LessonKey }) =>
      api<LessonProgress>(`/learning/progress/${lessonKey}/teachback`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** POST /learning/progress/:userId/:lessonKey/signoff (that person's team leader, or admin) */
export function useSignOffTeachback() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: ({ userId, lessonKey, ...input }: TeachbackSignoffInput & { userId: number; lessonKey: LessonKey }) =>
      api<LessonProgress>(`/learning/progress/${userId}/${lessonKey}/signoff`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** PUT /learning/milestones/:userId/:key (admin) — tick or count one of the criteria the office confirms by hand. */
export function useSetMilestone() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: ({ userId, key, ...input }: ProgressionMilestoneInput & { userId: number; key: ProgressionMilestoneKey }) =>
      api<Progression>(`/learning/milestones/${userId}/${key}`, { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}
