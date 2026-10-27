// "Today" at the top of a rep's or leader's dashboard: today's event for their team, with Check in, Log gauges and
// Quick gauges one tap away (before, the only Check in was four screens down, in Upcoming events). It reads the same
// events list as Log gauges, which the phone also keeps for opening with no signal (src/offline/fieldKit.ts), so the
// card is there offline too. Renders nothing on a day without an event.
import { Link } from 'react-router-dom';
import { CalendarCheck, MapPin, PlusCircle, Tally5 } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCurrentUser } from '@/auth/AuthProvider';
import { CheckInButton } from '@/features/checkins/CheckInButton';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { useLoggableEvents } from '@/features/gauges/loggableEvents';
import { todayISO } from '@/lib/dates';
import { formatTime } from '@/lib/format';
import { actionHref } from '@/lib/useActionParam';
import { todaysShifts } from './todayShift';

export function TodayShift({ onLog }: { onLog: () => void }) {
  const me = useCurrentUser();
  const { events } = useLoggableEvents();
  const shifts = todaysShifts(events, me, todayISO());
  if (!shifts.length) return null;
  return (
    <section aria-labelledby="today-shift-title" className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-4 shadow-card sm:p-5" data-today-shift>
      <h2 id="today-shift-title" className="flex items-center gap-2 text-sm font-semibold text-primary">
        <CalendarCheck className="h-4 w-4" aria-hidden />
        Today
      </h2>
      <ul className="mt-2 space-y-4">
        {shifts.map((e) => (
          <li key={e.id}>
            <Link to={`/events/${e.id}`} className="block text-base font-semibold leading-snug text-fg hover:underline">{e.name}</Link>
            <p className="mt-0.5 flex items-start gap-1 text-sm text-muted">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{formatTime(e.startTime)} to {formatTime(e.endTime)} · {e.venue}{e.city ? `, ${e.city}` : ''}</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ErrorBoundary name="today-check-in" fallback={null}>
                <CheckInButton event={e} variant="hero" />
              </ErrorBoundary>
              <Button variant="outline" onClick={onLog} leftIcon={<PlusCircle className="h-4 w-4" aria-hidden />} className="max-sm:h-11">
                Log gauges
              </Button>
              <Link
                to={actionHref.quick({ eventId: e.id })}
                className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-primary/10 max-sm:h-11"
              >
                <Tally5 className="h-4 w-4" aria-hidden />
                Quick gauges
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
