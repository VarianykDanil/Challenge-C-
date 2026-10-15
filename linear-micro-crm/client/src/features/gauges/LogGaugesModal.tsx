// Log (upsert) a day's gauges for an event. Used from Event detail, Gauges and the Dashboard.
import { useEffect, useId, useMemo, useState } from 'react';
import type { GaugeEntryWithMeta, GaugeKey, GaugeTotals, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, GAUGE_LABELS, funnelRatios, validateGaugeFunnel } from '@lm/shared';
import { AlertTriangle } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Stepper, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useEvents, useGauges, useUpsertGauge, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage, RatioCell } from '@/features/common';
import { isoToLocalInput, nowLocalInput, todayISO, toISODate } from '@/lib/dates';
import { formatDate, formatDateShort, formatStopsPerSale, fullName } from '@/lib/format';
import { BENCHMARK_KEYS, RATIO_LABELS } from '@/lib/ratios';
import { GAUGE_HELP } from '@/content/copy';
import { subDays } from 'date-fns';

export interface LogGaugesModalProps {
  open: boolean;
  onClose: () => void;
  /** Fix the event (e.g. from the event page). When omitted an event picker is shown. */
  event?: SalesEventWithMeta | null;
  /** Rep to log for; defaults to the signed-in user. */
  defaultUserId?: number;
  /** Existing entry to edit — prefills every field. */
  entry?: GaugeEntryWithMeta | null;
  onSaved?: (entry: GaugeEntryWithMeta) => void;
}

export function LogGaugesModal(props: LogGaugesModalProps) {
  // Modal unmounts its children when closed, so the form state resets naturally on every open.
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.entry ? 'Edit gauges' : 'Log gauges'} description="Stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales. Saving again for the same event updates the entry." size="lg">
      <LogGaugesForm {...props} />
    </Modal>
  );
}

/** Why an event cannot take gauges right now (server rejects cancelled and future events with 400/409). */
function eventBlockReason(ev: SalesEventWithMeta | null, today: string): string | null {
  if (!ev) return null;
  if (ev.status === 'cancelled') return 'This event was cancelled, so gauges cannot be logged for it.';
  if (ev.date > today) return `This event is on ${formatDate(ev.date)} — gauges can be logged from that day.`;
  return null;
}

function LogGaugesForm({ onClose, event, defaultUserId, entry, onSaved }: LogGaugesModalProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const uid = useId();
  const today = todayISO();
  const canPickRep = (me.role === 'admin' || me.role === 'leader') && !entry;

  const [eventId, setEventId] = useState<number | null>(entry?.eventId ?? event?.id ?? null);
  const [userId, setUserId] = useState<number | null>(entry?.userId ?? defaultUserId ?? me.id);
  const [repTouched, setRepTouched] = useState(false);
  const [gauges, setGauges] = useState<GaugeTotals>(() => (entry ? pick(entry) : { ...EMPTY_TOTALS }));
  const [checkIn, setCheckIn] = useState<string>(entry ? isoToLocalInput(entry.checkedInAt) : '');
  const [notes, setNotes] = useState<string>(entry?.notes ?? '');
  const [prefilledId, setPrefilledId] = useState<number | null>(entry?.id ?? null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Event picker: the last three weeks up to today (reps and leaders: own team only). Cancelled events are not offered.
  const eventsRange = useMemo(() => ({ from: toISODate(subDays(new Date(), 21)), to: today }), [today]);
  const eventsQuery = useEvents({ ...eventsRange, teamId: me.role === 'rep' || me.role === 'leader' ? me.teamId : undefined }, { enabled: !event });
  const events = useMemo(() => {
    const list = (eventsQuery.data ?? []).filter((e) => e.status !== 'cancelled' && e.date <= today);
    return event && !list.some((e) => e.id === event.id) ? [event, ...list] : list;
  }, [eventsQuery.data, event, today]);
  const selectedEvent = useMemo(() => events.find((e) => e.id === eventId) ?? event ?? null, [events, eventId, event]);
  // The gauge date is the event's date (server contract) — shown read-only, never typed.
  const date = selectedEvent?.date ?? entry?.date ?? '';
  const blocked = eventBlockReason(selectedEvent, today);

  // Rep picker for leaders / admin: members of the event's team (admin: everyone when no event chosen).
  const usersQuery = useUsers({ teamId: selectedEvent?.teamId ?? (me.role === 'leader' ? me.teamId : undefined) }, { enabled: canPickRep });
  const repOptions = useMemo(() => {
    if (!canPickRep) return [me];
    const list = usersQuery.data ?? [];
    // Admins may log their own field day at any team's event, so keep them selectable.
    return me.role === 'admin' && list.length && !list.some((u) => u.id === me.id) ? [...list, me] : list;
  }, [canPickRep, usersQuery.data, me]);
  const repValid = userId != null && repOptions.some((u) => u.id === userId);
  // Keep state and the visible option in sync: never submit a rep the dropdown is not showing. A preselected person
  // who is not in the event team's list (an admin opening a team's event) is cleared so the rep is chosen explicitly.
  useEffect(() => {
    if (!canPickRep || repTouched || !usersQuery.data) return;
    const members = usersQuery.data;
    if (userId != null && !members.some((u) => u.id === userId)) setUserId(null);
  }, [canPickRep, repTouched, usersQuery.data, userId]);

  // When the chosen (event, rep) already has an entry, prefill it so saving updates rather than duplicates.
  const existingQuery = useGauges({ eventId, userId, from: date, to: date, limit: 5 }, { enabled: !entry && eventId != null && userId != null && !!date && repValid });
  const existing = useMemo(() => existingQuery.data?.find((g) => g.eventId === eventId && g.userId === userId && g.date === date) ?? null, [existingQuery.data, eventId, userId, date]);
  useEffect(() => {
    if (!existing) {
      if (prefilledId != null && !entry) {
        setPrefilledId(null);
        setGauges({ ...EMPTY_TOTALS });
        setCheckIn('');
        setNotes('');
      }
      return;
    }
    if (existing.id !== prefilledId) {
      setPrefilledId(existing.id);
      setGauges(pick(existing));
      setCheckIn(isoToLocalInput(existing.checkedInAt));
      setNotes(existing.notes ?? '');
    }
  }, [existing, prefilledId, entry]);

  const warnings = useMemo(() => validateGaugeFunnel(gauges), [gauges]);
  const ratios = useMemo(() => funnelRatios(gauges), [gauges]);
  const upsert = useUpsertGauge();
  const invalidKeys = useMemo(() => {
    const set = new Set<GaugeKey>();
    for (let i = 1; i < GAUGE_KEYS.length; i++) if (gauges[GAUGE_KEYS[i]!] > gauges[GAUGE_KEYS[i - 1]!]) set.add(GAUGE_KEYS[i]!);
    return set;
  }, [gauges]);

  const canSubmit = eventId != null && userId != null && !!date && repValid && !blocked && warnings.length === 0 && !upsert.isPending;

  const submit = async () => {
    if (eventId == null || userId == null || !canSubmit) return;
    setServerError(null);
    try {
      // Send the wall-clock value the rep typed ("YYYY-MM-DDTHH:mm"); the server stores it verbatim.
      const saved = await upsert.mutateAsync({ ...gauges, eventId, userId, date, checkedInAt: checkIn || null, notes: notes.trim() || null });
      toast.success(prefilledId ? 'Gauges updated' : 'Gauges logged', `${saved.sales} sale${saved.sales === 1 ? '' : 's'} from ${saved.stops} stops · ${saved.eventName}`);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      // Validation and conflict replies (400/403/409) belong in the form; anything else is a toast.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setServerError(errorMessage(e));
      else toast.error('Could not save gauges', errorMessage(e));
    }
  };

  const set = (k: GaugeKey) => (v: number) => setGauges((g) => ({ ...g, [k]: v }));
  const repLabel = (u: { id: number; firstName: string; lastName: string }) => `${fullName(u)}${u.id === me.id ? ' (you)' : ''}`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-5"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Event" required htmlFor={`${uid}-event`} className="min-w-0 md:col-span-2" error={blocked ?? undefined}>
          {event ? (
            <Input id={`${uid}-event`} value={`${event.name} · ${formatDateShort(event.date)} · ${event.venue}`} readOnly aria-readonly invalid={!!blocked} />
          ) : (
            <Select
              id={`${uid}-event`}
              value={eventId ?? ''}
              onChange={(e) => { setEventId(e.target.value ? Number(e.target.value) : null); setServerError(null); }}
              placeholder={eventsQuery.isLoading ? 'Loading events…' : events.length ? 'Choose an event' : 'No events in the last three weeks'}
              options={events.map((e) => ({ value: String(e.id), label: `${formatDateShort(e.date)} · ${e.name} (${e.campaignCode}) · ${e.teamName}` }))}
              required
            />
          )}
        </Field>
        {canPickRep ? (
          <Field label="Rep" required htmlFor={`${uid}-user`} className="min-w-0">
            <Select
              id={`${uid}-user`}
              value={repValid ? String(userId) : ''}
              onChange={(e) => { setUserId(e.target.value ? Number(e.target.value) : null); setRepTouched(true); setServerError(null); }}
              placeholder={usersQuery.isLoading ? 'Loading reps…' : 'Choose a rep'}
              options={repOptions.map((u) => ({ value: String(u.id), label: repLabel(u) }))}
              required
            />
          </Field>
        ) : (
          <Field label="Rep" htmlFor={`${uid}-user`} className="min-w-0">
            <Input id={`${uid}-user`} value={entry ? `${entry.userName}${entry.userId === me.id ? ' (you)' : ''}` : repLabel(me)} readOnly aria-readonly />
          </Field>
        )}
        <Field label="Date" htmlFor={`${uid}-date`} className="min-w-0" hint={prefilledId ? 'An entry already exists for this event — saving will update it.' : 'Gauges are logged against the event date.'}>
          <Input id={`${uid}-date`} value={date ? formatDate(date) : 'Choose an event first'} readOnly aria-readonly />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-fg">Gauges</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {GAUGE_KEYS.map((k) => (
            <Stepper key={k} label={GAUGE_LABELS[k]} value={gauges[k]} onChange={set(k)} invalid={invalidKeys.has(k)} fullWidth size="md" />
          ))}
        </div>
        <details className="mt-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer select-none font-medium text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">What counts as what?</summary>
          <dl className="mt-2 space-y-1">
            {GAUGE_KEYS.map((k) => (
              <div key={k} className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-fg">{GAUGE_LABELS[k]}</dt><dd>{GAUGE_HELP[k]}</dd></div>
            ))}
          </dl>
        </details>
        {warnings.length > 0 && (
          <ul role="alert" className="mt-3 space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="rounded-lg border border-border bg-surface-2 p-3">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted">
          <span>Live ratios vs law of averages</span>
          <span>Stops per sale: <span className="font-semibold text-fg">{formatStopsPerSale(ratios.stopsPerSale)}</span></span>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[...BENCHMARK_KEYS, 'overallConversion' as const].map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <dt className="truncate text-[11px] text-muted" title={RATIO_LABELS[k]}>{RATIO_LABELS[k]}</dt>
              <dd><RatioCell keyName={k} value={ratios[k]} digits={k === 'overallConversion' ? 1 : 0} /></dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field as="div" label="Checked in at" className="min-w-0" hint={selectedEvent ? `Event starts ${selectedEvent.startTime} · 5 min grace` : 'Optional'}>
          <div className="flex gap-2">
            <Input id={`${uid}-checkin`} aria-label="Checked in at" type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="min-w-0" />
            <Button type="button" variant="outline" aria-label="Set check-in time to now" onClick={() => setCheckIn(nowLocalInput())}>Now</Button>
          </div>
        </Field>
        <Field label="Notes" htmlFor={`${uid}-notes`} className="min-w-0">
          <Textarea id={`${uid}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Weather, footfall, objections heard…" />
        </Field>
      </div>

      {serverError && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span><span className="font-semibold">Not saved.</span> {serverError}</span>
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit} loading={upsert.isPending}>{prefilledId ? 'Update gauges' : 'Save gauges'}</Button>
      </div>
    </form>
  );
}

function pick(t: GaugeTotals): GaugeTotals {
  return { stops: t.stops, table: t.table, presentations: t.presentations, closes: t.closes, taps: t.taps, sales: t.sales };
}
