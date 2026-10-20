// Release 1.2 — U4 shift check-in hooks — OWNED BY U4. Endpoints: server/src/routes/checkins.ts.
// Not the 1.1 "Check in with…" list (SmartInsights.team.checkIns).
// The mutations run whatever navigator.onLine says (networkMode 'always'): a paused mutation would leave the button
// spinning without signal, whereas a NetworkError lets the caller keep the tap on the phone (features/checkins/outbox.ts).
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ShiftCheckIn, ShiftCheckInInput, ShiftCheckInList } from '@lm/shared';
import { apiRaw, api, qs } from './client';

export const checkinKeys = {
  all: ['checkins'] as const,
  event: (eventId: number) => ['checkins', 'event', eventId] as const,
};

/** GET /checkins?eventId= — admin: everyone; leader: their team and themself; others: own only. */
export function useEventCheckIns(eventId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: checkinKeys.event(eventId ?? 0),
    queryFn: () => api<ShiftCheckInList>(`/checkins${qs({ eventId: eventId ?? undefined })}`),
    enabled: enabled && eventId != null,
  });
}

/** What POST /checkins answered: the check-in, whether it was new (201) and when the answer arrived (for Undo). */
export interface CheckInResult {
  checkIn: ShiftCheckIn;
  created: boolean;
  receivedAt: number;
}

/** Put a check-in into the event's cached list (replacing the same person's day), so every slot shows it at once. */
export function rememberCheckIn(qc: QueryClient, c: ShiftCheckIn): void {
  qc.setQueryData<ShiftCheckInList>(checkinKeys.event(c.eventId), (old) => {
    const rest = (old?.checkIns ?? []).filter((x) => x.id !== c.id && !(x.userId === c.userId && x.date === c.date));
    return { eventId: c.eventId, checkIns: [...rest, c].sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt) || a.id - b.id) };
  });
}

/** Take a removed check-in out of the event's cached list. */
export function forgetCheckIn(qc: QueryClient, eventId: number, id: number): void {
  qc.setQueryData<ShiftCheckInList>(checkinKeys.event(eventId), (old) => (old ? { ...old, checkIns: old.checkIns.filter((x) => x.id !== id) } : old));
}

/** Everything a check-in changes elsewhere: punctuality on dashboards and profiles (never gauges or pay). */
function refreshAround(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: checkinKeys.all });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['users', 'performance'] });
}

/** POST /checkins — idempotent per person, event and date (201 new, 200 already checked in). */
export function useCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (input: ShiftCheckInInput): Promise<CheckInResult> => {
      const r = await apiRaw<ShiftCheckIn>('/checkins', { method: 'POST', json: input });
      return { checkIn: r.data, created: r.status === 201, receivedAt: Date.now() };
    },
    onSuccess: (r) => {
      rememberCheckIn(qc, r.checkIn);
      refreshAround(qc);
    },
  });
}

/** DELETE /checkins/:id — undo (self within 2 minutes; the person's leader / admin any time). */
export function useUndoCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (c: Pick<ShiftCheckIn, 'id' | 'eventId'>) => {
      await api<void>(`/checkins/${c.id}`, { method: 'DELETE' });
      return c;
    },
    onSuccess: (c) => {
      forgetCheckIn(qc, c.eventId, c.id);
      refreshAround(qc);
    },
  });
}
