// Create / edit a sales event (admin, or leader for their own team).
import { useId, useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import type { EventForecast, EventStatus, EventType, SalesEvent, SalesEventWithMeta } from '@lm/shared';
import { EVENT_TYPE_LABELS, repsNeededFor, scheduledFlag } from '@lm/shared';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useCampaigns, useCreateEvent, useEventForecast, useTeams, useUpdateEvent, type EventInput } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { formatNumber, pluralise } from '@/lib/format';
import { EVENT_STATUS_LABELS, optionsFrom } from '@/lib/labels';
import { ForecastFlag, forecastBasisLabel, forecastRange } from './EventForecastChip';

export interface EventFormModalProps {
  open: boolean;
  onClose: () => void;
  event?: SalesEventWithMeta | null;
  onSaved?: (event: SalesEventWithMeta) => void;
}

export function EventFormModal(props: EventFormModalProps) {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.event ? 'Edit event' : 'New event'} description={props.event ? undefined : 'Schedule a day in the field for a team.'} size="lg">
      <EventForm {...props} />
    </Modal>
  );
}

interface FormState {
  name: string;
  campaignId: string;
  teamId: string;
  venue: string;
  city: string;
  type: EventType;
  date: string;
  startTime: string;
  endTime: string;
  targetSales: string;
  status: EventStatus;
  notes: string;
}

function EventForm({ onClose, event, onSaved }: EventFormModalProps) {
  const me = useCurrentUser();
  const toast = useToast();
  const uid = useId();
  const teams = useTeams();
  const campaigns = useCampaigns(event ? undefined : true);
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const lockTeam = me.role === 'leader' && me.teamId != null;
  // Every aggregate groups gauges on the event's date, team and campaign: once a day has been logged those three are
  // fixed (the API answers 409). The fields are shown locked instead of letting the save fail.
  const hasEntries = !!event && event.repCount > 0;

  const [f, setF] = useState<FormState>({
    name: event?.name ?? '',
    campaignId: event ? String(event.campaignId) : '',
    teamId: event ? String(event.teamId) : lockTeam ? String(me.teamId) : '',
    venue: event?.venue ?? '',
    city: event?.city ?? 'Manchester',
    type: event?.type ?? 'private_site',
    date: event?.date ?? todayISO(),
    startTime: event?.startTime ?? '10:00',
    endTime: event?.endTime ?? '18:00',
    targetSales: String(event?.targetSales ?? 10),
    status: event?.status ?? 'scheduled',
    notes: event?.notes ?? '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!f.name.trim()) e.name = 'Give the event a name';
    if (!f.campaignId) e.campaignId = 'Choose a campaign';
    if (!f.teamId) e.teamId = 'Choose a team';
    if (!f.venue.trim()) e.venue = 'Venue is required';
    if (!f.city.trim()) e.city = 'City is required';
    if (!f.date) e.date = 'Pick a date';
    if (f.endTime <= f.startTime) e.endTime = 'End time must be after the start';
    if (!Number.isInteger(Number(f.targetSales)) || Number(f.targetSales) < 0) e.targetSales = 'Whole number ≥ 0';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setServerError(null);
    const input: EventInput = {
      name: f.name.trim(),
      campaignId: Number(f.campaignId),
      teamId: Number(f.teamId),
      venue: f.venue.trim(),
      city: f.city.trim(),
      type: f.type,
      date: f.date,
      startTime: f.startTime,
      endTime: f.endTime,
      targetSales: Number(f.targetSales),
      notes: f.notes.trim() || null,
      // Only an edit carries a status; on create the server derives it from the date (completed / live / scheduled).
      ...(event ? { status: f.status } : {}),
    };
    try {
      let saved: SalesEventWithMeta;
      if (event) {
        const patch: Partial<SalesEvent> = { ...input };
        if (hasEntries) {
          // Locked on screen, so never sent: the server would refuse a change to any of them.
          delete patch.date;
          delete patch.teamId;
          delete patch.campaignId;
        }
        saved = await update.mutateAsync({ id: event.id, ...patch });
      } else {
        saved = await create.mutateAsync(input);
      }
      toast.success(event ? 'Event updated' : 'Event created', `${saved.name} · ${saved.date}`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      // Validation / permission / conflict replies (400, 403, 409) belong in the form; anything else is a toast.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) setServerError(errorMessage(err));
      else toast.error('Could not save event', errorMessage(err));
    }
  };

  // Smart release 1.1 (p6): a data-driven suggested target once campaign, team and type are chosen. Only a suggestion:
  // it fills the field when "Use" is tapped and never overwrites what was typed. Planned (scheduled) events only.
  const suggest = !event || f.status === 'scheduled';
  const forecastQ = useEventForecast({ campaignId: f.campaignId ? Number(f.campaignId) : null, teamId: f.teamId ? Number(f.teamId) : null, type: f.type }, { enabled: suggest });
  const campaignCode = campaigns.data?.find((c) => String(c.id) === f.campaignId)?.code ?? '';
  const teamName = teams.data?.find((t) => String(t.id) === f.teamId)?.name;

  const pending = create.isPending || update.isPending;
  const lockedHint = hasEntries ? 'Locked: gauges have been logged for this event.' : undefined;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      {hasEntries && (
        <p className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-xs text-muted">
          {event!.repCount} rep{event!.repCount === 1 ? ' has' : 's have'} logged gauges for this event, so its date, team and campaign can no longer change. Everything else can.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Event name" required htmlFor={`${uid}-name`} error={errors.name} className="md:col-span-2">
          <Input id={`${uid}-name`} value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Trafford Centre weekend" invalid={!!errors.name} autoFocus />
        </Field>
        <Field label="Campaign" required htmlFor={`${uid}-campaign`} error={errors.campaignId} hint={lockedHint}>
          <Select id={`${uid}-campaign`} value={f.campaignId} onChange={(e) => set('campaignId')(e.target.value)} placeholder={campaigns.isLoading ? 'Loading…' : 'Choose a campaign'} options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: `${c.name} (${c.code})` }))} invalid={!!errors.campaignId} disabled={hasEntries} />
        </Field>
        <Field label="Team" required htmlFor={`${uid}-team`} error={errors.teamId} hint={lockedHint ?? (lockTeam ? 'Leaders schedule events for their own team.' : undefined)}>
          <Select id={`${uid}-team`} value={f.teamId} onChange={(e) => set('teamId')(e.target.value)} placeholder={teams.isLoading ? 'Loading…' : 'Choose a team'} options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} disabled={lockTeam || hasEntries} invalid={!!errors.teamId} />
        </Field>
        <Field label="Venue" required htmlFor={`${uid}-venue`} error={errors.venue}>
          <Input id={`${uid}-venue`} value={f.venue} onChange={(e) => set('venue')(e.target.value)} invalid={!!errors.venue} />
        </Field>
        <Field label="City" required htmlFor={`${uid}-city`} error={errors.city}>
          <Input id={`${uid}-city`} value={f.city} onChange={(e) => set('city')(e.target.value)} invalid={!!errors.city} />
        </Field>
        <Field label="Type" required htmlFor={`${uid}-type`}>
          <Select id={`${uid}-type`} value={f.type} onChange={(e) => set('type')(e.target.value as EventType)} options={optionsFrom(EVENT_TYPE_LABELS)} />
        </Field>
        <Field label="Date" required htmlFor={`${uid}-date`} error={errors.date} hint={lockedHint}>
          <Input id={`${uid}-date`} type="date" value={f.date} onChange={(e) => set('date')(e.target.value)} invalid={!!errors.date} disabled={hasEntries} />
        </Field>
        <Field label="Start" required htmlFor={`${uid}-start`}>
          <Input id={`${uid}-start`} type="time" value={f.startTime} onChange={(e) => set('startTime')(e.target.value)} />
        </Field>
        <Field label="End" required htmlFor={`${uid}-end`} error={errors.endTime}>
          <Input id={`${uid}-end`} type="time" value={f.endTime} onChange={(e) => set('endTime')(e.target.value)} invalid={!!errors.endTime} />
        </Field>
        <Field label="Sales target" required htmlFor={`${uid}-target`} error={errors.targetSales}>
          <Input id={`${uid}-target`} type="number" min={0} inputMode="numeric" value={f.targetSales} onChange={(e) => set('targetSales')(e.target.value)} invalid={!!errors.targetSales} />
        </Field>
        {suggest && f.campaignId && f.teamId && (
          <TargetSuggestion
            loading={forecastQ.isLoading}
            failed={forecastQ.isError}
            forecast={forecastQ.data?.forecast ?? null}
            campaignCode={campaignCode}
            teamName={teamName}
            type={f.type}
            target={f.targetSales}
            onUse={(n) => set('targetSales')(String(n))}
          />
        )}
        {event && (
          <Field label="Status" htmlFor={`${uid}-status`}>
            <Select id={`${uid}-status`} value={f.status} onChange={(e) => set('status')(e.target.value as EventStatus)} options={optionsFrom(EVENT_STATUS_LABELS)} />
          </Field>
        )}
        <Field label="Notes" htmlFor={`${uid}-notes`} className="md:col-span-2">
          <Textarea id={`${uid}-notes`} rows={2} value={f.notes} onChange={(e) => set('notes')(e.target.value)} placeholder="Parking, dress code, who to ask for on site…" />
        </Field>
      </div>
      {serverError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div><span className="font-semibold">Not saved.</span> {serverError}</div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={pending}>{event ? 'Save changes' : 'Create event'}</Button>
      </div>
    </form>
  );
}

interface TargetSuggestionProps {
  loading: boolean;
  failed: boolean;
  forecast: EventForecast | null;
  campaignCode: string;
  teamName?: string;
  type: EventType;
  /** The target as typed (a string while editing). */
  target: string;
  onUse: (target: number) => void;
}

/** "Suggested target: 14 — Use", the estimate behind it, and what the typed target needs. */
function TargetSuggestion({ loading, failed, forecast: fc, campaignCode, teamName, type, target, onUse }: TargetSuggestionProps) {
  if (loading) return <p className="self-end text-xs text-muted md:pb-2.5" aria-live="polite">Working out a suggested target…</p>;
  if (failed) return null; // the form works the same without a suggestion
  if (!fc || fc.suggestedTarget == null) {
    // No reason is given: thin history, a team that rarely works, and suggestions switched off all land here.
    return <p className="self-end text-xs text-muted md:pb-2.5" aria-live="polite">No suggested target for this team, campaign and type. Set the target as usual.</p>;
  }
  const typed = Number(target);
  const typedOk = target.trim() !== '' && Number.isInteger(typed) && typed > 0;
  const using = typedOk && typed === fc.suggestedTarget;
  const reps = typedOk ? repsNeededFor(typed, fc.perRepRate) : null;
  const flag = typedOk ? scheduledFlag(typed, fc.expectedSales) : null;
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          Suggested target: {formatNumber(fc.suggestedTarget)}
        </span>
        {using ? (
          <span className="text-xs text-muted">In use</span>
        ) : (
          <Button size="xs" variant="soft" className="min-h-10 sm:min-h-0" onClick={() => onUse(fc.suggestedTarget!)} aria-label={`Use the suggested target of ${fc.suggestedTarget}`}>
            Use
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted">
        A suggestion only. Estimate about {formatNumber(Math.round(fc.expectedSales))} sales (range {forecastRange(fc)}) with the usual {pluralise(Math.max(1, Math.round(fc.expectedReps)), 'rep')}, from {pluralise(fc.basisDays, 'similar day')} ({forecastBasisLabel(fc, campaignCode, type, teamName)}).
      </p>
      {typedOk && reps != null && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          A target of {formatNumber(typed)} needs about {pluralise(reps, 'rep')}.
          <ForecastFlag flag={flag} />
        </p>
      )}
    </div>
  );
}
