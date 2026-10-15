// Create / edit a sales event (admin, or leader for their own team).
import { useId, useState } from 'react';
import type { EventStatus, EventType, SalesEventWithMeta } from '@lm/shared';
import { EVENT_TYPE_LABELS } from '@lm/shared';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { useCampaigns, useCreateEvent, useTeams, useUpdateEvent, type EventInput } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { EVENT_STATUS_LABELS, optionsFrom } from '@/lib/labels';

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
      const saved = event ? await update.mutateAsync({ id: event.id, ...input }) : await create.mutateAsync(input);
      toast.success(event ? 'Event updated' : 'Event created', `${saved.name} · ${saved.date}`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error('Could not save event', errorMessage(err));
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Event name" required htmlFor={`${uid}-name`} error={errors.name} className="md:col-span-2">
          <Input id={`${uid}-name`} value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Trafford Centre weekend" invalid={!!errors.name} autoFocus />
        </Field>
        <Field label="Campaign" required htmlFor={`${uid}-campaign`} error={errors.campaignId}>
          <Select id={`${uid}-campaign`} value={f.campaignId} onChange={(e) => set('campaignId')(e.target.value)} placeholder={campaigns.isLoading ? 'Loading…' : 'Choose a campaign'} options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: `${c.name} (${c.code})` }))} invalid={!!errors.campaignId} />
        </Field>
        <Field label="Team" required htmlFor={`${uid}-team`} error={errors.teamId} hint={lockTeam ? 'Leaders schedule events for their own team.' : undefined}>
          <Select id={`${uid}-team`} value={f.teamId} onChange={(e) => set('teamId')(e.target.value)} placeholder={teams.isLoading ? 'Loading…' : 'Choose a team'} options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} disabled={lockTeam} invalid={!!errors.teamId} />
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
        <Field label="Date" required htmlFor={`${uid}-date`} error={errors.date}>
          <Input id={`${uid}-date`} type="date" value={f.date} onChange={(e) => set('date')(e.target.value)} invalid={!!errors.date} />
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
        {event && (
          <Field label="Status" htmlFor={`${uid}-status`}>
            <Select id={`${uid}-status`} value={f.status} onChange={(e) => set('status')(e.target.value as EventStatus)} options={optionsFrom(EVENT_STATUS_LABELS)} />
          </Field>
        )}
        <Field label="Notes" htmlFor={`${uid}-notes`} className="md:col-span-2">
          <Textarea id={`${uid}-notes`} rows={2} value={f.notes} onChange={(e) => set('notes')(e.target.value)} placeholder="Parking, dress code, who to ask for on site…" />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={pending}>{event ? 'Save changes' : 'Create event'}</Button>
      </div>
    </form>
  );
}
