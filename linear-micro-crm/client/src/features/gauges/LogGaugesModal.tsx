// Log (upsert) a day's gauges for an event. Used from Event detail, Gauges and the Dashboard.
// Smart release 1.1 (p7-signal-proof-logging): saves without signal go to the gauge outbox on this phone; `prefill`
// starts from the tally's counts or an entry kept on the phone; smart defaults (today's event, a check-in chip, the
// first rep without an entry) apply when the modal is opened with no event and no entry.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GaugeEntryWithMeta, GaugeKey, GaugeTotals, GaugeUpsertInput, SalesEventWithMeta } from '@lm/shared';
import { EMPTY_TOTALS, GAUGE_KEYS, GAUGE_LABELS, GAUGE_MAX_PER_DAY, firstMemberWithoutEntry, funnelRatios, inCheckInWindow, preselectTodayEvent, validateGaugeFunnel } from '@lm/shared';
import { AlertTriangle, Clock, Smartphone } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Stepper, Textarea, useToast } from '@/components/ui';
import { ApiError, isNetworkError } from '@/api/client';
import { useEvent, useGauges, useUpdateGauge, useUpsertGauge, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorDetails, errorMessage, RatioCell } from '@/features/common';
import { isoToLocalInput, nowLocalInput, todayISO } from '@/lib/dates';
import { formatDate, formatDateShort, formatStopsPerSale, formatTime, fullName } from '@/lib/format';
import { BENCHMARK_KEYS, RATIO_LABELS } from '@/lib/ratios';
import { GAUGE_HELP } from '@/content/copy';
import { format } from 'date-fns';
import { cachedMembers, useLoggableEvents } from './loggableEvents';
import { discardOutboxItem, enqueueGauge, outboxAvailable, outboxItemFor, useOutbox, type OutboxItem } from './outbox';

/** The server caps every gauge count (shared `GAUGE_MAX_PER_DAY`; the funnel rule keeps the later stages at or below stops). */
export const GAUGE_MAX = GAUGE_MAX_PER_DAY;

/** Values to start the form from instead of an empty one (the tally's counts, or an entry kept on this phone). */
export interface GaugePrefill {
  gauges: GaugeTotals;
  /** Preselect this event in the picker (ignored when `event` or `entry` is given). */
  eventId?: number;
  /** Preselect this person (leaders and admins). */
  userId?: number;
  /** A check-in ("YYYY-MM-DDTHH:mm") or note to start from; omitted keeps whatever the stored entry has. */
  checkedInAt?: string;
  notes?: string;
}

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
  /**
   * Start from these values. When the day already has an entry, saving updates it with these counts (the form says
   * so); its check-in and notes are kept unless the prefill carries its own.
   */
  prefill?: GaugePrefill | null;
  /** The save was kept on this phone (no signal) instead of reaching Linear Hub; the modal then closes. */
  onQueued?: (item: OutboxItem) => void;
}

export function LogGaugesModal(props: LogGaugesModalProps) {
  // Modal unmounts its children when closed, so the form state resets naturally on every open.
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.entry ? 'Update gauges' : 'Log gauges'} description="Stops ≥ to table ≥ presentations ≥ closes ≥ taps ≥ sales. Saving again for the same event updates the entry." size="lg">
      <LogGaugesForm {...props} />
    </Modal>
  );
}

/** Why an event cannot take gauges right now (the server rejects cancelled, future and not-yet-started events with 400/409). */
export function eventBlockReason(ev: SalesEventWithMeta | null, today: string, nowHHMM: string): string | null {
  if (!ev) return null;
  if (ev.status === 'cancelled') return 'This event was cancelled, so gauges cannot be logged for it.';
  if (ev.date > today) return `This event is on ${formatDate(ev.date)} — gauges can be logged from that day.`;
  if (ev.date === today && ev.startTime > nowHHMM) return `This event starts at ${formatTime(ev.startTime)} — gauges can be logged from then.`;
  return null;
}

interface Baseline { checkIn: string; notes: string }

/** Where the form's values came from: the existing-entry lookup may replace 'empty' / 'server' values, never the others. */
type ValuesFrom = 'empty' | 'entry' | 'server' | 'prefill' | 'outbox';

/** Re-render every 30 s so the "starts at" block and the check-in chip follow the clock while the form is open. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** navigator.onLine, kept current. */
function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

function LogGaugesForm({ onClose, event, defaultUserId, entry, onSaved, prefill, onQueued }: LogGaugesModalProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const qc = useQueryClient();
  const uid = useId();
  const today = todayISO();
  const now = useNow();
  const nowHHMM = format(now, 'HH:mm');
  const browserOnline = useBrowserOnline();
  const [canKeepOnPhone] = useState(outboxAvailable);
  const outbox = useOutbox(me.id);
  const canPickRep = (me.role === 'admin' || me.role === 'leader') && !entry;
  // Smart defaults only when the modal was opened without an event and without an entry (spec: p7).
  const smart = !event && !entry;
  const usePrefill = !!prefill && !entry;

  const [eventId, setEventId] = useState<number | null>(entry?.eventId ?? event?.id ?? (usePrefill ? prefill!.eventId ?? null : null));
  const [userId, setUserId] = useState<number | null>(entry?.userId ?? (usePrefill ? prefill!.userId : undefined) ?? defaultUserId ?? me.id);
  const [repTouched, setRepTouched] = useState(false);
  const [gauges, setGauges] = useState<GaugeTotals>(() => (entry ? pick(entry) : usePrefill ? pick(prefill!.gauges) : { ...EMPTY_TOTALS }));
  const [checkIn, setCheckIn] = useState<string>(entry ? isoToLocalInput(entry.checkedInAt) : usePrefill && prefill!.checkedInAt ? isoToLocalInput(prefill!.checkedInAt) : '');
  const [notes, setNotes] = useState<string>(entry?.notes ?? (usePrefill ? prefill!.notes ?? '' : ''));
  const [prefilledId, setPrefilledId] = useState<number | null>(entry?.id ?? null);
  // submittedAt of the entry the form shows (server clock): the outbox replays against it, not the phone's clock.
  const [seenSubmittedAt, setSeenSubmittedAt] = useState<string | null>(entry?.submittedAt ?? null);
  // What the stored entry held when it was prefilled: check-in / notes are only sent when the user changed them,
  // so an update never clears a value the rep recorded (the API keeps omitted fields).
  const [baseline, setBaseline] = useState<Baseline>({ checkIn: entry ? isoToLocalInput(entry.checkedInAt) : '', notes: entry?.notes ?? '' });
  const [serverError, setServerError] = useState<{ message: string; details: string[] } | null>(null);
  const valuesFrom = useRef<ValuesFrom>(entry ? 'entry' : usePrefill ? 'prefill' : 'empty');
  // The check-in / note the prefill (or the outbox item) carried; undefined → keep the stored entry's.
  const carried = useRef<{ checkIn?: string; notes?: string }>(usePrefill ? { checkIn: prefill!.checkedInAt ? isoToLocalInput(prefill!.checkedInAt) : undefined, notes: prefill!.notes || undefined } : {});
  const userTyped = useRef(false);

  // Event picker: the last three weeks up to today (reps and leaders: own team only). Cancelled events are not offered.
  // Without signal the events already seen this session stand in (see loggableEvents.ts).
  const loggable = useLoggableEvents({ enabled: !event });
  const events = useMemo(() => {
    const list = loggable.events ?? [];
    return event && !list.some((e) => e.id === event.id) ? [event, ...list] : list;
  }, [loggable.events, event]);
  const selectedEvent = useMemo(() => events.find((e) => e.id === eventId) ?? event ?? null, [events, eventId, event]);
  // The gauge date is the event's date (server contract) — shown read-only, never typed.
  const date = selectedEvent?.date ?? entry?.date ?? '';
  const blocked = eventBlockReason(selectedEvent, today, nowHHMM);

  // Smart default 1: today's one live (or completed) own-team event is preselected.
  const [autoEventId, setAutoEventId] = useState<number | null>(null);
  const autoEventTried = useRef(false);
  useEffect(() => {
    if (!smart || autoEventTried.current || eventId != null || !loggable.events) return;
    autoEventTried.current = true;
    const id = preselectTodayEvent(loggable.events, today, me.teamId);
    if (id != null) {
      setEventId(id);
      setAutoEventId(id);
    }
  }, [smart, eventId, loggable.events, today, me.teamId]);

  // Rep picker for leaders / admin: members of the event's team (admin: everyone when no event chosen).
  const pickerTeamId = selectedEvent?.teamId ?? (me.role === 'leader' ? me.teamId : undefined);
  const usersQuery = useUsers({ teamId: pickerTeamId }, { enabled: canPickRep });
  // Without signal, the team lists already seen this session stand in for a leader's picker.
  const usersOffline = usersQuery.fetchStatus === 'paused' || (usersQuery.isError && !usersQuery.isFetching && isNetworkError(usersQuery.error));
  const members = useMemo(
    () => usersQuery.data ?? (canPickRep && usersOffline && pickerTeamId != null ? nonEmpty(cachedMembers(qc, pickerTeamId)) : undefined),
    [usersQuery.data, canPickRep, usersOffline, pickerTeamId, qc],
  );
  const repOptions = useMemo(() => {
    if (!canPickRep) return [me];
    const list = members ?? [];
    // Admins may log their own field day at any team's event, so keep them selectable.
    return me.role === 'admin' && list.length && !list.some((u) => u.id === me.id) ? [...list, me] : list;
  }, [canPickRep, members, me]);
  // Editing a supplied entry: its owner is the rep, whoever the viewer is (admins and own-team leaders correct reps' days).
  const repValid = entry ? userId === entry.userId : userId != null && repOptions.some((u) => u.id === userId);
  // Keep state and the visible option in sync: never submit a rep the dropdown is not showing. A preselected person
  // who is not in the event team's list (an admin opening a team's event) is cleared so the rep is chosen explicitly.
  useEffect(() => {
    if (!canPickRep || repTouched || !members) return;
    if (userId != null && !members.some((u) => u.id === userId)) setUserId(null);
  }, [canPickRep, repTouched, members, userId]);

  // Smart default 3: a leader or admin (no defaultUserId) starts on the first active member with no entry yet.
  const autoRep = smart && canPickRep && defaultUserId === undefined && !(usePrefill && prefill!.userId != null) && !repTouched;
  const eventDetail = useEvent(autoRep ? eventId : null);
  const [autoRepFor, setAutoRepFor] = useState<number | null>(null);
  useEffect(() => {
    if (!autoRep || eventId == null || autoRepFor === eventId) return;
    const detail = eventDetail.data;
    if (!members || !detail || detail.id !== eventId) return;
    setAutoRepFor(eventId);
    const first = firstMemberWithoutEntry(members, detail.entries.filter((g) => g.date === detail.date).map((g) => g.userId));
    if (first != null) setUserId(first);
  }, [autoRep, eventId, autoRepFor, members, eventDetail.data]);
  const autoRepSettled = eventDetail.isError || eventDetail.fetchStatus === 'paused' || (usersQuery.isError && !members) || (usersQuery.fetchStatus === 'paused' && !members);
  const autoRepPending = autoRep && eventId != null && autoRepFor !== eventId && !autoRepSettled;

  // When the chosen (event, rep) already has an entry, prefill it so saving updates rather than duplicates.
  // Saving is blocked until this lookup has answered: posting early would silently overwrite the rep's logged day.
  // Without signal (the lookup is paused or fails with a NetworkError) the save goes to this phone instead, where the
  // replay repeats the lookup before sending.
  const lookupEnabled = !entry && eventId != null && userId != null && !!date && repValid && !autoRepPending;
  const existingQuery = useGauges({ eventId, userId, from: date, to: date, limit: 5 }, { enabled: lookupEnabled });
  const lookupOffline = lookupEnabled && (existingQuery.fetchStatus === 'paused' || (existingQuery.isError && !existingQuery.isFetching && isNetworkError(existingQuery.error)));
  const lookupPending = lookupEnabled && !lookupOffline && (existingQuery.isPending || existingQuery.isFetching);
  const lookupFailed = lookupEnabled && existingQuery.isError && !existingQuery.isFetching && !isNetworkError(existingQuery.error);
  const existing = useMemo(() => existingQuery.data?.find((g) => g.eventId === eventId && g.userId === userId && g.date === date) ?? null, [existingQuery.data, eventId, userId, date]);
  useEffect(() => {
    if (!existing) {
      if (prefilledId != null && !entry) {
        setPrefilledId(null);
        setSeenSubmittedAt(null);
        setBaseline({ checkIn: '', notes: '' });
        if (valuesFrom.current === 'server') {
          valuesFrom.current = 'empty';
          setGauges({ ...EMPTY_TOTALS });
          setCheckIn('');
          setNotes('');
        }
      }
      return;
    }
    if (existing.id !== prefilledId) {
      const ci = isoToLocalInput(existing.checkedInAt);
      setPrefilledId(existing.id);
      setSeenSubmittedAt(existing.submittedAt);
      setBaseline({ checkIn: ci, notes: existing.notes ?? '' });
      if (valuesFrom.current === 'prefill' || valuesFrom.current === 'outbox') {
        // Keep the tally's / phone's counts; the stored check-in and notes stay unless those values carried their own.
        setCheckIn(carried.current.checkIn ?? ci);
        setNotes(carried.current.notes ?? existing.notes ?? '');
      } else {
        valuesFrom.current = 'server';
        setGauges(pick(existing));
        setCheckIn(ci);
        setNotes(existing.notes ?? '');
      }
    }
  }, [existing, prefilledId, entry]);

  // A day saved on this phone and still waiting: start from it (saving again replaces it in the outbox).
  const kept = outboxItemFor(outbox, { eventId, userId, date });
  const appliedKept = useRef<string | null>(null);
  useEffect(() => {
    if (!kept || kept.status !== 'waiting' || entry || usePrefill || userTyped.current || appliedKept.current === kept.id) return;
    appliedKept.current = kept.id;
    valuesFrom.current = 'outbox';
    const ci = kept.input.checkedInAt ? isoToLocalInput(kept.input.checkedInAt) : undefined;
    const nt = kept.input.notes || undefined;
    carried.current = { checkIn: ci, notes: nt };
    setGauges(pick(kept.input));
    if (ci !== undefined) setCheckIn(ci);
    if (nt !== undefined) setNotes(nt);
  }, [kept, entry, usePrefill]);

  const warnings = useMemo(() => validateGaugeFunnel(gauges), [gauges]);
  const ratios = useMemo(() => funnelRatios(gauges), [gauges]);
  const upsert = useUpsertGauge();
  const update = useUpdateGauge();
  const saving = upsert.isPending || update.isPending;
  const invalidKeys = useMemo(() => {
    const set = new Set<GaugeKey>();
    for (let i = 1; i < GAUGE_KEYS.length; i++) if (gauges[GAUGE_KEYS[i]!] > gauges[GAUGE_KEYS[i - 1]!]) set.add(GAUGE_KEYS[i]!);
    return set;
  }, [gauges]);

  // No signal and the phone can keep it: the save goes to the outbox ("Save on this phone").
  const keepOnPhone = canKeepOnPhone && (!browserOnline || lookupOffline);
  const lookupBlocks = lookupPending || lookupFailed || (lookupOffline && !canKeepOnPhone);
  const canSubmit = eventId != null && userId != null && !!date && repValid && !blocked && warnings.length === 0 && !saving && !lookupBlocks && !autoRepPending;

  // Smart default 2: "Checking in? Use now" around the start of today's event; it never fills itself.
  const showCheckInChip = smart && !!selectedEvent && selectedEvent.date === today && prefilledId == null && !checkIn && inCheckInWindow(selectedEvent.startTime, nowHHMM);

  const repName = () => {
    if (entry) return entry.userName;
    const u = repOptions.find((o) => o.id === userId);
    return u ? fullName(u) : fullName(me);
  };
  const eventName = () => selectedEvent?.name ?? entry?.eventName ?? 'Event';

  const submit = async () => {
    if (eventId == null || userId == null || !canSubmit) return;
    setServerError(null);
    // Check-in is the wall-clock value the rep typed ("YYYY-MM-DDTHH:mm"); the server stores it verbatim.
    const fields: GaugeUpsertInput = { ...gauges, eventId, userId, date };
    if (prefilledId == null) {
      // A new entry carries everything typed (an empty check-in / notes is simply not recorded).
      fields.checkedInAt = checkIn || null;
      fields.notes = notes.trim() || null;
    } else {
      // An update only sends what changed: omitted keys keep the stored values, an explicit null clears them.
      if (checkIn !== baseline.checkIn) fields.checkedInAt = checkIn || null;
      if (notes.trim() !== baseline.notes.trim()) fields.notes = notes.trim() || null;
    }
    const keep = (): boolean => {
      if (!canKeepOnPhone) return false;
      const item = enqueueGauge(me.id, { input: fields, expectedExistingId: prefilledId, seenSubmittedAt: prefilledId != null ? seenSubmittedAt : null, eventName: eventName(), userName: repName() });
      if (!item) return false;
      toast.info("Saved on this phone — it will send when you're back online", `${fields.sales} sale${fields.sales === 1 ? '' : 's'} from ${fields.stops} stops · ${item.eventName}`);
      onQueued?.(item);
      onClose();
      return true;
    };
    if (keepOnPhone) {
      if (keep()) return;
      // The day could not be checked for an earlier entry, so a blind POST could overwrite one: do not send.
      if (lookupOffline) {
        toast.error('Could not save gauges', "This phone couldn't keep it (its storage is full, or 50 entries are already waiting). Send or discard those first.");
        return;
      }
    }
    try {
      let saved: GaugeEntryWithMeta;
      let created: boolean;
      if (prefilledId != null) {
        // An entry we already know about is updated in place (PATCH) — never re-posted through the upsert.
        saved = await update.mutateAsync({ id: prefilledId, ...fields });
        created = false;
      } else {
        const r = await upsert.mutateAsync(fields);
        saved = r.entry;
        created = r.created; // 201 = logged, 200 = the server found and updated the existing day
      }
      // This save supersedes anything kept on the phone for the same day.
      if (kept) discardOutboxItem(me.id, kept.id);
      toast.success(created ? 'Gauges logged' : 'Gauges updated', `${saved.sales} sale${saved.sales === 1 ? '' : 's'} from ${saved.stops} stops · ${saved.eventName}`);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      // No answer at all (the signal dropped mid-save): keep it on the phone. The replay looks the day up first, so a
      // save that did land is recognised and never sent twice.
      if (isNetworkError(e) && keep()) return;
      // Validation and conflict replies (400/403/409) belong in the form; anything else is a toast.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setServerError({ message: e.message, details: errorDetails(e) });
      else toast.error('Could not save gauges', errorMessage(e));
    }
  };

  const typed = <T,>(setter: (v: T) => void) => (v: T) => {
    userTyped.current = true;
    setter(v);
  };
  const set = (k: GaugeKey) => typed((v: number) => setGauges((g) => ({ ...g, [k]: v })));
  const repLabel = (u: { id: number; firstName: string; lastName: string }) => `${fullName(u)}${u.id === me.id ? ' (you)' : ''}`;
  const fromValues = valuesFrom.current === 'prefill' || valuesFrom.current === 'outbox';
  const dateHint = lookupPending
    ? 'Checking for an existing entry…'
    : prefilledId
      ? fromValues
        ? 'An entry already exists for this event — saving will update it with these counts.'
        : 'An entry already exists for this event — saving will update it.'
      : kept && kept.status === 'waiting'
        ? keepOnPhone
          ? 'Saved on this phone and waiting to send — saving again replaces it.'
          : 'Saved on this phone and waiting to send — saving now sends it.'
        : lookupOffline
          ? "No signal — Linear Hub checks this day for an earlier entry before it's sent."
          : 'Gauges are logged against the event date.';
  const submitLabel = keepOnPhone ? 'Save on this phone' : prefilledId ? 'Update gauges' : lookupPending || autoRepPending ? 'Checking for an existing entry…' : 'Save gauges';
  const eventPlaceholder = loggable.isLoading ? 'Loading events…' : events.length ? 'Choose an event' : loggable.offline ? 'No signal — no events loaded yet' : 'No events in the last three weeks';
  const eventHint = autoEventId != null && eventId === autoEventId ? "Today's event selected" : loggable.fromCache && !event && !entry ? 'No signal — showing events already loaded on this phone' : undefined;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-5"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Event" required htmlFor={`${uid}-event`} className="min-w-0 md:col-span-2" error={blocked ?? undefined} hint={eventHint}>
          {event || entry ? (
            // Fixed by the page, or locked while editing an existing entry.
            <Input id={`${uid}-event`} value={event ? `${event.name} · ${formatDateShort(event.date)} · ${event.venue}` : `${entry!.eventName} · ${formatDateShort(entry!.date)}`} readOnly aria-readonly invalid={!!blocked} />
          ) : (
            <Select
              id={`${uid}-event`}
              value={eventId ?? ''}
              onChange={(e) => { setEventId(e.target.value ? Number(e.target.value) : null); setAutoEventId(null); setServerError(null); }}
              placeholder={eventPlaceholder}
              options={events.map((e) => ({ value: String(e.id), label: `${formatDateShort(e.date)} · ${e.name} (${e.campaignCode}) · ${e.teamName}` }))}
              required
            />
          )}
        </Field>
        {canPickRep ? (
          <Field label="Rep" required htmlFor={`${uid}-user`} className="min-w-0" hint={autoRep && autoRepFor === eventId && userId != null && repValid ? 'First on the team without an entry yet' : undefined}>
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
        <Field label="Date" htmlFor={`${uid}-date`} className="min-w-0" hint={dateHint}>
          <Input id={`${uid}-date`} value={date ? formatDate(date) : 'Choose an event first'} readOnly aria-readonly />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-fg">Gauges</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {GAUGE_KEYS.map((k) => (
            <Stepper key={k} label={GAUGE_LABELS[k]} value={gauges[k]} onChange={set(k)} max={GAUGE_MAX} invalid={invalidKeys.has(k)} fullWidth size="md" />
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
            <Input id={`${uid}-checkin`} aria-label="Checked in at" type="datetime-local" value={checkIn} onChange={(e) => { userTyped.current = true; setCheckIn(e.target.value); }} className="min-w-0" />
            <Button type="button" variant="outline" aria-label="Set check-in time to now" onClick={() => { userTyped.current = true; setCheckIn(nowLocalInput()); }}>Now</Button>
          </div>
          {showCheckInChip && (
            <button
              type="button"
              data-checkin-chip
              onClick={() => { userTyped.current = true; setCheckIn(nowLocalInput()); }}
              className="focus-ring mt-2 inline-flex min-h-10 items-center gap-2 rounded-full border border-primary/30 bg-primary-soft px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/15 active:bg-primary/20"
            >
              <Clock className="h-4 w-4 shrink-0" aria-hidden />
              Checking in? Use now ({nowHHMM})
            </button>
          )}
        </Field>
        <Field label="Notes" htmlFor={`${uid}-notes`} className="min-w-0">
          <Textarea id={`${uid}-notes`} rows={2} value={notes} onChange={(e) => { userTyped.current = true; setNotes(e.target.value); }} placeholder="Weather, footfall, objections heard…" />
        </Field>
      </div>

      {lookupFailed && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Could not check whether this day was already logged ({errorMessage(existingQuery.error)}). Saving is paused so nothing is overwritten.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void existingQuery.refetch()}>Try again</Button>
        </div>
      )}

      {lookupOffline && !canKeepOnPhone && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Could not check whether this day was already logged ({errorMessage(existingQuery.error, "Can't reach Linear Hub")}). Saving is paused so nothing is overwritten.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void existingQuery.refetch()}>Try again</Button>
        </div>
      )}

      {keepOnPhone && (
        <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-soft p-3 text-sm text-fg">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
          <span>No signal right now. Saving keeps these gauges on this phone and sends them when you&apos;re back online.</span>
        </p>
      )}

      {serverError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <span className="font-semibold">Not saved.</span> {serverError.message}
            {serverError.details.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {serverError.details.map((d) => <li key={d}>{d}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit} loading={saving} aria-busy={lookupPending || autoRepPending || undefined} leftIcon={keepOnPhone ? <Smartphone className="h-4 w-4" aria-hidden /> : undefined}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function pick(t: GaugeTotals): GaugeTotals {
  return { stops: t.stops, table: t.table, presentations: t.presentations, closes: t.closes, taps: t.taps, sales: t.sales };
}

function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}
