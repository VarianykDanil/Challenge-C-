// Log (upsert) a day's gauges for an event. Used from Event detail, Gauges and the Dashboard.
import { useEffect, useId, useMemo, useState } from 'react';
import type { GaugeEntryWithMeta, GaugeKey, GaugeTotals, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, GAUGE_LABELS, funnelRatios, validateGaugeFunnel } from '@lm/shared';
import { AlertTriangle } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Stepper, Textarea, useToast } from '@/components/ui';
import { useEvents, useGauges, useUpsertGauge, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage, RatioCell } from '@/features/common';
import { isoToLocalInput, localInputToISO, nowLocalInput, presetRange, todayISO, toISODate } from '@/lib/dates';
import { formatDateShort, formatStopsPerSale, fullName } from '@/lib/format';
import { BENCHMARK_KEYS, RATIO_LABELS } from '@/lib/ratios';
import { GAUGE_HELP } from '@/content/copy';
import { addDays, subDays } from 'date-fns';

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
    <Modal open={props.open} onClose={props.onClose} title={props.entry ? 'Edit gauges' : 'Log gauges'} description="Stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales. Saving again for the same day updates the entry." size="lg">
      <LogGaugesForm {...props} />
    </Modal>
  );
}

function LogGaugesForm({ onClose, event, defaultUserId, entry, onSaved }: LogGaugesModalProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const uid = useId();
  const canPickRep = me.role === 'admin' || me.role === 'leader';

  const [eventId, setEventId] = useState<number | null>(entry?.eventId ?? event?.id ?? null);
  const [userId, setUserId] = useState<number>(entry?.userId ?? defaultUserId ?? me.id);
  const [date, setDate] = useState<string>(entry?.date ?? event?.date ?? todayISO());
  const [gauges, setGauges] = useState<GaugeTotals>(() => (entry ? pick(entry) : { ...EMPTY_TOTALS }));
  const [checkIn, setCheckIn] = useState<string>(entry ? isoToLocalInput(entry.checkedInAt) : '');
  const [notes, setNotes] = useState<string>(entry?.notes ?? '');
  const [prefilledId, setPrefilledId] = useState<number | null>(entry?.id ?? null);

  // Event picker: recent + upcoming events (reps: own team only).
  const eventsRange = useMemo(() => ({ from: toISODate(subDays(new Date(), 21)), to: toISODate(addDays(new Date(), 7)) }), []);
  const eventsQuery = useEvents({ ...eventsRange, teamId: me.role === 'rep' ? me.teamId : undefined }, { enabled: !event });
  const events = useMemo(() => {
    const list = eventsQuery.data ?? [];
    return event && !list.some((e) => e.id === event.id) ? [event, ...list] : list;
  }, [eventsQuery.data, event]);
  const selectedEvent = useMemo(() => events.find((e) => e.id === eventId) ?? event ?? null, [events, eventId, event]);

  // Rep picker for leaders / admin: members of the event's team (admin: everyone when no event chosen).
  const usersQuery = useUsers({ teamId: selectedEvent?.teamId ?? (me.role === 'leader' ? me.teamId : undefined) }, { enabled: canPickRep });

  // When the chosen (event, rep, date) already has an entry, prefill it so saving updates rather than duplicates.
  const existingQuery = useGauges({ eventId, userId, from: date, to: date, limit: 5 }, { enabled: !entry && eventId != null && !!date });
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

  // Default the date to the event's date when switching events.
  useEffect(() => {
    if (selectedEvent && !entry) setDate(selectedEvent.date);
  }, [selectedEvent?.id, selectedEvent?.date, entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const warnings = useMemo(() => validateGaugeFunnel(gauges), [gauges]);
  const ratios = useMemo(() => funnelRatios(gauges), [gauges]);
  const upsert = useUpsertGauge();
  const invalidKeys = useMemo(() => {
    const set = new Set<GaugeKey>();
    for (let i = 1; i < GAUGE_KEYS.length; i++) if (gauges[GAUGE_KEYS[i]!] > gauges[GAUGE_KEYS[i - 1]!]) set.add(GAUGE_KEYS[i]!);
    return set;
  }, [gauges]);

  const canSubmit = eventId != null && !!date && warnings.length === 0 && !upsert.isPending;

  const submit = async () => {
    if (eventId == null) return;
    try {
      const saved = await upsert.mutateAsync({ ...gauges, eventId, userId, date, checkedInAt: localInputToISO(checkIn), notes: notes.trim() || null });
      toast.success(prefilledId ? 'Gauges updated' : 'Gauges logged', `${saved.sales} sale${saved.sales === 1 ? '' : 's'} from ${saved.stops} stops · ${saved.eventName}`);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error('Could not save gauges', errorMessage(e));
    }
  };

  const set = (k: GaugeKey) => (v: number) => setGauges((g) => ({ ...g, [k]: v }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-5"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Event" required htmlFor={`${uid}-event`} className="md:col-span-2">
          {event ? (
            <Input id={`${uid}-event`} value={`${event.name} · ${formatDateShort(event.date)} · ${event.venue}`} readOnly aria-readonly />
          ) : (
            <Select
              id={`${uid}-event`}
              value={eventId ?? ''}
              onChange={(e) => setEventId(e.target.value ? Number(e.target.value) : null)}
              placeholder={eventsQuery.isLoading ? 'Loading events…' : 'Choose an event'}
              options={events.map((e) => ({ value: String(e.id), label: `${formatDateShort(e.date)} · ${e.name} (${e.campaignCode}) · ${e.teamName}` }))}
              required
            />
          )}
        </Field>
        {canPickRep ? (
          <Field label="Rep" required htmlFor={`${uid}-user`}>
            <Select
              id={`${uid}-user`}
              value={String(userId)}
              onChange={(e) => setUserId(Number(e.target.value))}
              options={(usersQuery.data ?? [me]).map((u) => ({ value: String(u.id), label: `${fullName(u)}${u.id === me.id ? ' (you)' : ''}` }))}
            />
          </Field>
        ) : (
          <Field label="Rep" htmlFor={`${uid}-user`}>
            <Input id={`${uid}-user`} value={`${fullName(me)} (you)`} readOnly aria-readonly />
          </Field>
        )}
        <Field label="Date" required htmlFor={`${uid}-date`} hint={prefilledId ? 'An entry already exists for this day — saving will update it.' : undefined}>
          <Input id={`${uid}-date`} type="date" value={date} max={presetRange('this_week').to} onChange={(e) => setDate(e.target.value)} required />
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

      <div className="grid gap-4 md:grid-cols-2">
        <Field as="div" label="Checked in at" hint={selectedEvent ? `Event starts ${selectedEvent.startTime} · 5 min grace` : 'Optional'}>
          <div className="flex gap-2">
            <Input id={`${uid}-checkin`} aria-label="Checked in at" type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            <Button type="button" variant="outline" aria-label="Set check-in time to now" onClick={() => setCheckIn(nowLocalInput())}>Now</Button>
          </div>
        </Field>
        <Field label="Notes" htmlFor={`${uid}-notes`}>
          <Textarea id={`${uid}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Weather, footfall, objections heard…" />
        </Field>
      </div>

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
