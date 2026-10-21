// Release 1.3 — P8 venue-insights hooks — OWNED BY P8 (laid down by r3-foundation). Endpoints: server/src/routes/venues.ts
// and server/src/routes/eventPlans.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventBooking, EventPlan, VenueProfile, VenueSummary } from '@lm/shared';
import { api, qs } from './client';

export type VenueSort = 'sales_per_shift' | 'shifts' | 'last_visit';

export const venueKeys = {
  all: ['venues'] as const,
  list: (sort?: VenueSort) => ['venues', 'list', sort ?? null] as const,
  one: (key: string) => ['venues', 'one', key] as const,
  plan: (eventId: number, userId?: number | null) => ['venues', 'plan', eventId, userId ?? null] as const,
  roster: (eventId: number) => ['venues', 'roster', eventId] as const,
};

export function useVenues(sort?: VenueSort, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: venueKeys.list(sort), queryFn: () => api<VenueSummary[]>(`/venues${qs({ sort })}`), enabled });
}

export function useVenue(key: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: venueKeys.one(key ?? ''), queryFn: () => api<VenueProfile>(`/venues/${encodeURIComponent(key ?? '')}`), enabled: enabled && !!key });
}

export function useEventPlan(eventId: number | null | undefined, userId?: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: venueKeys.plan(eventId ?? 0, userId), queryFn: () => api<EventPlan[]>(`/events/${eventId}/plan${qs({ userId: userId ?? undefined })}`), enabled: enabled && eventId != null });
}

export function useEventRoster(eventId: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: venueKeys.roster(eventId ?? 0), queryFn: () => api<EventBooking[]>(`/events/${eventId}/roster`), enabled: enabled && eventId != null });
}

const invalidateRoster = (qc: ReturnType<typeof useQueryClient>, eventId: number) => {
  void qc.invalidateQueries({ queryKey: venueKeys.roster(eventId) });
  void qc.invalidateQueries({ queryKey: ['venues', 'plan', eventId] });
  void qc.invalidateQueries({ queryKey: ['events'] });
};

/** PUT /events/:id/roster — the leader books their team members. */
export function useSaveEventRoster(eventId: number) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (userIds: number[]) => api<EventBooking[]>(`/events/${eventId}/roster`, { method: 'PUT', json: { userIds } }), onSuccess: () => invalidateRoster(qc, eventId) });
}

/** POST / DELETE /events/:id/roster/me — "I'm working this". */
export function useBookMyself(eventId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (booked: boolean) => api<EventBooking[]>(`/events/${eventId}/roster/me`, { method: booked ? 'POST' : 'DELETE' }),
    onSuccess: () => invalidateRoster(qc, eventId),
  });
}
