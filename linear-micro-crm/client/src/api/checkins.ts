// Release 1.2 — U4 shift check-in hooks — OWNED BY U4 (laid down by r2-foundation). Endpoints: server/src/routes/checkins.ts.
// Not the 1.1 "Check in with…" list (SmartInsights.team.checkIns).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftCheckIn, ShiftCheckInInput, ShiftCheckInList } from '@lm/shared';
import { api, qs } from './client';

export const checkinKeys = {
  all: ['checkins'] as const,
  event: (eventId: number) => ['checkins', 'event', eventId] as const,
};

/** GET /checkins?eventId= — leader / admin: the event's people in scope; rep: own only. */
export function useEventCheckIns(eventId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: checkinKeys.event(eventId ?? 0),
    queryFn: () => api<ShiftCheckInList>(`/checkins${qs({ eventId: eventId ?? undefined })}`),
    enabled: enabled && eventId != null,
  });
}

/** POST /checkins — idempotent per person, event and date. */
export function useCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShiftCheckInInput) => api<ShiftCheckIn>('/checkins', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: checkinKeys.all });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** DELETE /checkins/:id — undo (self within 2 minutes; leader / admin any time). */
export function useUndoCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/checkins/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: checkinKeys.all });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
