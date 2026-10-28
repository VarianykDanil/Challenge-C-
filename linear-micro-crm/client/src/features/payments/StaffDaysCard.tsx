// Team → person (administrators): the leaving date and, for office staff paid a day rate, the days off (MON-8). Both
// decide the paid days: days after the leaving date are never paid (the leaver's last week still is), and a day off
// takes a day off an office person's week. Weeks already paid, or in a payment on its way, cannot change (the server
// says so): add an adjustment on a later week instead.
import { useId, useState, type FormEvent } from 'react';
import { CalendarOff, Trash2 } from 'lucide-react';
import { payDayLabel, type StaffAbsenceKind } from '@lm/shared';
import { useAddAbsence, useRemoveAbsence, useSetLeavingDate, useStaffDays } from '@/api/pay';
import { Button, Card, CardHeader, Field, Input, Select, Skeleton, useToast } from '@/components/ui';
import { ErrorState, errorMessage } from '@/features/common';

const KINDS: { value: StaffAbsenceKind; label: string }[] = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick' },
  { value: 'unpaid', label: 'Unpaid leave' },
  { value: 'other', label: 'Other' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label])) as Record<StaffAbsenceKind, string>;

export function StaffDaysCard({ user }: { user: { id: number; firstName: string; role: string } }) {
  const uid = useId();
  const q = useStaffDays(user.id);
  const setLeaving = useSetLeavingDate(user.id);
  const add = useAddAbsence(user.id);
  const remove = useRemoveAbsence(user.id);
  const toast = useToast();
  const office = user.role === 'recruiter';
  const [leaving, setLeavingInput] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<StaffAbsenceKind>('holiday');
  const [note, setNote] = useState('');
  const leavingValue = leaving ?? q.data?.leavingDate ?? '';

  const saveLeaving = (value: string | null) =>
    setLeaving.mutate(value, {
      onSuccess: (v) => {
        setLeavingInput(null);
        toast.success(v.leavingDate ? `Leaving date: ${payDayLabel(v.leavingDate)}` : 'Leaving date cleared', 'The pay of the weeks it touches is worked out again.');
      },
      onError: (e) => toast.error('Could not save the leaving date', errorMessage(e)),
    });

  const addDays = (e: FormEvent) => {
    e.preventDefault();
    if (!from) return;
    add.mutate({ date: from, ...(to && to !== from ? { to } : {}), kind, ...(note.trim() ? { note: note.trim() } : {}) }, {
      onSuccess: () => {
        setFrom('');
        setTo('');
        setNote('');
        toast.success('Days off added', 'They are not paid.');
      },
      onError: (err) => toast.error('Could not add them', errorMessage(err)),
    });
  };

  return (
    <Card data-staff-days="">
      <CardHeader
        title="Days off and leaving date"
        icon={<CalendarOff aria-hidden />}
        description={office
          ? `Days ${user.firstName} was away are not paid, nor any day after the leaving date. A paid week cannot change: add an adjustment instead.`
          : `No day after the leaving date is paid. ${user.firstName}’s last week is still paid. A paid week cannot change.`}
      />
      {q.isLoading ? <Skeleton className="h-16 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} className="p-4" /> : (
        <div className="space-y-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Last working day" htmlFor={`${uid}-leaving`} hint="Empty: not leaving">
              <Input id={`${uid}-leaving`} type="date" value={leavingValue} onChange={(e) => setLeavingInput(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" className="h-10" loading={setLeaving.isPending} disabled={(leaving ?? null) === null || leavingValue === (q.data?.leavingDate ?? '')} onClick={() => saveLeaving(leavingValue || null)}>Save</Button>
              {q.data?.leavingDate && <Button size="sm" variant="ghost" className="h-10" disabled={setLeaving.isPending} onClick={() => saveLeaving(null)}>Clear</Button>}
            </div>
          </div>
          {office && (
            <>
              <form onSubmit={addDays} className="space-y-3 border-t border-border pt-4" noValidate>
                <p className="text-sm font-medium text-fg">Add days off</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From" htmlFor={`${uid}-from`}><Input id={`${uid}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
                  <Field label="To (optional)" htmlFor={`${uid}-to`} hint="Weekends are skipped"><Input id={`${uid}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
                  <Field label="Kind" htmlFor={`${uid}-kind`}>
                    <Select id={`${uid}-kind`} value={kind} onChange={(e) => setKind(e.target.value as StaffAbsenceKind)} options={KINDS} />
                  </Field>
                  <Field label="Note (optional)" htmlFor={`${uid}-note`}><Input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
                </div>
                <Button type="submit" size="sm" className="h-10" loading={add.isPending} disabled={!from}>Add days off</Button>
              </form>
              {(q.data?.absences.length ?? 0) > 0 && (
                <ul className="divide-y divide-border border-t border-border" aria-label="Days off">
                  {q.data!.absences.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium text-fg">{payDayLabel(a.date)}</span> · {KIND_LABEL[a.kind]}
                        {a.note && <span className="text-muted"> · {a.note}</span>}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-10 w-10 shrink-0 px-0"
                        aria-label={`Remove the day off on ${payDayLabel(a.date)}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(a.id, { onError: (e) => toast.error('Could not remove it', errorMessage(e)) })}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
