// Release 1.3 — OWNED BY P1 pay-rule. "Add a bonus" / "Add an adjustment" (administrators): Matt's bonus for a top
// performer, or a manual line (money added or taken off), on an unpaid week. Opened from a week's breakdown (person and
// week fixed) or from Finance → Company → Bonuses and corrections (pick both). POST /pay/bonuses, POST /pay/adjustments;
// the week's run is recalculated by the server and the person sees the line, with its note, on their pay.
import { useId, useMemo, useState } from 'react';
import { payMoney, payWeekLabel } from '@lm/shared';
import { Button, Field, Input, Modal, SegmentedControl, Select, useToast } from '@/components/ui';
import { useUsers } from '@/api/hooks';
import { useAddAdjustment, useAddBonus } from '@/api/pay';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { formatRangeLabel } from '@/lib/format';

export interface AdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  kind: 'bonus' | 'manual';
  /** Fixed person (from a breakdown); omitted → a person picker. */
  userId?: number;
  userName?: string;
  /** Fixed week (Monday); omitted → a week picker. */
  weekStart?: string;
}

/** Monday of the week containing `iso` (calendar arithmetic, UTC noon so DST never shifts the day). */
export function mondayOfISO(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDaysISO = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The weeks a bonus usually goes on: last week (being paid this Friday), this week and the two around them. */
export function weekChoices(today = todayISO()): { value: string; label: string }[] {
  const thisMonday = mondayOfISO(today);
  return [-14, -7, 0, 7].map((offset) => {
    const monday = addDaysISO(thisMonday, offset);
    const tag = offset === 0 ? ' (this week)' : offset === -7 ? ' (last week)' : offset === 7 ? ' (next week)' : '';
    return { value: monday, label: `${formatRangeLabel(monday, addDaysISO(monday, 6))}${tag}` };
  });
}

export function AdjustmentModal(props: AdjustmentModalProps) {
  const title = props.kind === 'bonus' ? 'Add a bonus' : 'Add an adjustment';
  const who = props.userName && props.weekStart ? `${props.userName} · ${payWeekLabel(props.weekStart)}` : undefined;
  return (
    <Modal open={props.open} onClose={props.onClose} title={title} description={who} size="md">
      <AdjustmentForm {...props} />
    </Modal>
  );
}

function AdjustmentForm({ onClose, kind, userId, weekStart }: AdjustmentModalProps) {
  const uid = useId();
  const toast = useToast();
  const bonus = useAddBonus();
  const manual = useAddAdjustment();
  const people = useUsers({ status: 'active' }, { enabled: userId === undefined });
  const weeks = useMemo(() => weekChoices(), []);
  const [f, setF] = useState({
    userId: userId ? String(userId) : '',
    week: weekStart ?? weeks[1]!.value,
    amount: '',
    direction: 'add' as 'add' | 'take',
    source: '',
    note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const busy = bonus.isPending || manual.isPending;
  const options = (people.data ?? [])
    .filter((u) => u.role !== 'client')
    .map((u) => ({ value: String(u.id), label: `${u.firstName} ${u.lastName}${u.teamName ? ` · ${u.teamName}` : ''}` }));

  const submit = async () => {
    const e: Record<string, string> = {};
    const amount = Number(f.amount);
    if (!f.userId) e.userId = 'Choose who it is for';
    if (!f.amount || !Number.isFinite(amount) || amount <= 0) e.amount = 'Enter an amount above £0';
    if (!f.note.trim()) e.note = kind === 'bonus' ? 'Say what it is for, e.g. Top seller in October' : 'Say what it is for';
    setErrors(e);
    if (Object.keys(e).length) return;
    const value = Math.round(amount * 100) / 100;
    try {
      // a week the person did not work passes its lines on to their next unpaid week: say where it went
      const landed = (week: string) => (week === f.week ? ` on ${payWeekLabel(week)}` : ` on ${payWeekLabel(week)}: no work in ${payWeekLabel(f.week)}, so it goes on the next unpaid week`);
      if (kind === 'bonus') {
        const added = await bonus.mutateAsync({ userId: Number(f.userId), weekStart: f.week, amount: value, note: f.note.trim() });
        toast.success('Bonus added', `${payMoney(value)}${landed(added.targetWeekStart)}`);
      } else {
        const signed = f.direction === 'take' ? -value : value;
        const added = await manual.mutateAsync({ userId: Number(f.userId), targetWeekStart: f.week, sourceWeekStart: f.source || null, amount: signed, note: f.note.trim() });
        toast.success('Adjustment added', `${signed < 0 ? '−' : '+'}${payMoney(value)}${landed(added.targetWeekStart)}`);
      }
      onClose();
    } catch (err) {
      toast.error(kind === 'bonus' ? 'Could not add the bonus' : 'Could not add the adjustment', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      {userId === undefined && (
        <Field label="Person" required htmlFor={`${uid}-who`} error={errors.userId}>
          <Select id={`${uid}-who`} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} placeholder={people.isLoading ? 'Loading…' : 'Choose a person'} options={options} invalid={!!errors.userId} />
        </Field>
      )}
      {weekStart === undefined && (
        <Field label="Paid with the week" required htmlFor={`${uid}-week`} hint="It goes on that week's pay, which must not be paid yet">
          <Select id={`${uid}-week`} value={f.week} onChange={(e) => setF({ ...f, week: e.target.value })} options={weeks} />
        </Field>
      )}
      {kind === 'manual' && (
        <SegmentedControl
          aria-label="Add or take off"
          fullWidth
          value={f.direction}
          onChange={(v) => setF({ ...f, direction: v })}
          options={[{ value: 'add', label: 'Add money' }, { value: 'take', label: 'Take money off' }]}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (£)" required htmlFor={`${uid}-amount`} error={errors.amount}>
          <Input id={`${uid}-amount`} type="number" min={0} step="0.01" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} invalid={!!errors.amount} autoFocus />
        </Field>
        {kind === 'manual' && (
          <Field label="Week it corrects" optional htmlFor={`${uid}-source`}>
            <Input id={`${uid}-source`} type="date" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value ? mondayOfISO(e.target.value) : '' })} />
          </Field>
        )}
      </div>
      <Field label="What it is for" required htmlFor={`${uid}-note`} error={errors.note} hint="They see this on their pay">
        <Input id={`${uid}-note`} value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} invalid={!!errors.note} placeholder={kind === 'bonus' ? 'e.g. Top seller in October: 61 subs' : 'e.g. Lanyard not returned'} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={busy}>{kind === 'bonus' ? 'Add bonus' : 'Add adjustment'}</Button>
      </div>
    </form>
  );
}
