// "Which event are you counting?" — the tally's event list, shared by the Tally card (TallyMode.tsx) and the Quick
// gauges page (pages/QuickGauges.tsx), with the same empty and no-signal lines.
import type { SalesEventWithMeta } from '@lm/shared';
import { EventStatusBadge } from '@/features/common/StatusBadges';
import { formatDateShort, formatTime } from '@/lib/format';
import type { StoredTally } from './tallyStore';

export interface TallyEventPickerProps {
  options: SalesEventWithMeta[];
  stored: StoredTally[];
  today: string;
  /** A linked event (?eventId) that isn't one the person can count today. */
  linkMissed: boolean;
  offline: boolean;
  onPick: (eventId: number) => void;
}

export function TallyEventPicker({ options, stored, today, linkMissed, offline, onPick }: TallyEventPickerProps) {
  return (
    <>
      {linkMissed && <p className="mb-3 text-sm text-muted">That event isn&apos;t one you can count today.</p>}
      {options.length ? (
        <>
          <p className="mb-3 text-sm font-medium text-fg">Which event are you counting?</p>
          <ul className="space-y-2">
            {options.map((e) => {
              const t = stored.find((s) => s.eventId === e.id && s.date === e.date);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onPick(e.id)}
                    className="focus-ring flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 active:bg-surface-3"
                  >
                    <span className="h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.campaignColor }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{e.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {e.date === today ? 'Today' : formatDateShort(e.date)} · {formatTime(e.startTime)} · {e.teamName}
                        {t ? ` · ${t.counts.stops} stops counted${e.date !== today ? ' (not finished)' : ''}` : ''}
                      </span>
                    </span>
                    <EventStatusBadge status={e.status} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted">
          {offline ? "No signal, and no events loaded on this phone yet — open the tally again once you're back online." : 'Nothing on today for your team, so there is no shift to count.'}
        </p>
      )}
    </>
  );
}
