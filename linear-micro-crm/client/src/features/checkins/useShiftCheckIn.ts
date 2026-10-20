// Release 1.2 — OWNED BY U4 check-ins. One person's check-in at one event, as every U4 slot (and Log gauges) reads
// it: the one Linear Hub holds (GET /checkins?eventId=, already role-scoped) or, for the signed-in person, the tap
// still waiting on this phone (features/checkins/outbox.ts).
import { useEffect, useState } from 'react';
import type { ShiftCheckIn } from '@lm/shared';
import { shiftCheckInLabel, shiftCheckInStatus } from '@lm/shared';
import { useEventCheckIns } from '@/api/checkins';
import { queuedCheckInFor, useCheckInOutbox, type QueuedCheckIn } from './outbox';

export interface PersonCheckIn {
  /** Where it is: on Linear Hub, or waiting on this phone. */
  where: 'server' | 'phone';
  checkedInAt: string;
  minutesLate: number | null;
  onTime: boolean;
  /** "Checked in 09:24 · on time" */
  label: string;
  server: ShiftCheckIn | null;
  queued: QueuedCheckIn | null;
}

export interface UseShiftCheckInArgs {
  eventId: number | null | undefined;
  /** The event's date (a check-in belongs to one event and day). */
  date: string | null | undefined;
  /** The event's start "HH:MM" (for a queued tap's on time / late). */
  startTime?: string | null;
  userId: number | null | undefined;
  /** The signed-in person (only their own queued taps are on this phone). */
  meId: number;
  enabled?: boolean;
}

export function useShiftCheckIn({ eventId, date, startTime, userId, meId, enabled = true }: UseShiftCheckInArgs) {
  const query = useEventCheckIns(eventId, { enabled: enabled && eventId != null && !!date && userId != null });
  const outbox = useCheckInOutbox(meId);
  const server = (date && userId != null ? query.data?.checkIns.find((c) => c.userId === userId && c.date === date) : undefined) ?? null;
  const queuedAny = userId === meId ? queuedCheckInFor(outbox, eventId, date) : null;
  // A failed item is shown in the banner; the button offers a fresh tap instead.
  const queued = queuedAny && queuedAny.status === 'waiting' ? queuedAny : null;

  let current: PersonCheckIn | null = null;
  if (server) {
    current = { where: 'server', checkedInAt: server.checkedInAt, minutesLate: server.minutesLate, onTime: server.onTime, label: shiftCheckInLabel(server.checkedInAt, server), server, queued: null };
  } else if (queued) {
    const status = shiftCheckInStatus(queued.date, startTime ?? queued.startTime, queued.checkedInAt);
    current = { where: 'phone', checkedInAt: queued.checkedInAt, ...status, label: shiftCheckInLabel(queued.checkedInAt, status), server: null, queued };
  }

  // Undo deadline on this device's clock: when the answer arrived + the window the server said was left.
  const undoDeadline = server && (server.undoMsLeft ?? 0) > 0 ? query.dataUpdatedAt + (server.undoMsLeft ?? 0) : null;

  return {
    query,
    current,
    /** Still finding out (nothing known yet, and not offline). */
    loading: !current && query.isPending && query.fetchStatus === 'fetching',
    undoDeadline,
  };
}

/** Re-renders every `ms` (default 20 s) so time-based states (the check-in window) follow the clock. */
export function useTicker(ms = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** True until `deadline` (epoch ms on this device), re-rendering once when it passes. */
export function useBefore(deadline: number | null): boolean {
  const [, force] = useState(0);
  const open = deadline != null && Date.now() < deadline;
  useEffect(() => {
    if (deadline == null) return;
    const left = deadline - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => force((n) => n + 1), left + 50);
    return () => window.clearTimeout(id);
  }, [deadline]);
  return open;
}
