import { useId, useState } from 'react';
import type { ExpenseCategory } from '@lm/shared';
import { EXPENSE_CATEGORY_LABELS } from '@lm/shared';
import { Button, Field, Input, Modal, Select, useToast } from '@/components/ui';
import { useCampaigns, useCreateExpense } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { optionsFrom } from '@/lib/labels';

export function AddExpenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add expense" size="md">
      <ExpenseForm onClose={onClose} />
    </Modal>
  );
}

function ExpenseForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const create = useCreateExpense();
  const campaigns = useCampaigns();
  const [f, setF] = useState({ date: todayISO(), category: 'venue' as ExpenseCategory, amount: '', description: '', campaignId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const e: Record<string, string> = {};
    const amount = Number(f.amount);
    if (!f.amount || !Number.isFinite(amount) || amount <= 0) e.amount = 'Enter an amount above zero';
    if (!f.description.trim()) e.description = 'Describe the expense';
    if (!f.date) e.date = 'Pick a date';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await create.mutateAsync({ date: f.date, category: f.category, amount: Math.round(amount * 100) / 100, description: f.description.trim(), campaignId: f.campaignId ? Number(f.campaignId) : null, eventId: null });
      toast.success('Expense added');
      onClose();
    } catch (err) {
      toast.error('Could not add expense', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required htmlFor={`${uid}-date`} error={errors.date}><Input id={`${uid}-date`} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} invalid={!!errors.date} /></Field>
        <Field label="Amount (£)" required htmlFor={`${uid}-amount`} error={errors.amount}><Input id={`${uid}-amount`} type="number" min={0} step="0.01" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} invalid={!!errors.amount} autoFocus /></Field>
        <Field label="Category" required htmlFor={`${uid}-cat`}><Select id={`${uid}-cat`} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ExpenseCategory })} options={optionsFrom(EXPENSE_CATEGORY_LABELS)} /></Field>
        <Field label="Campaign" htmlFor={`${uid}-camp`}><Select id={`${uid}-camp`} value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value })} placeholder="Not campaign-specific" options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
        <Field label="Description" required htmlFor={`${uid}-desc`} error={errors.description} className="sm:col-span-2"><Input id={`${uid}-desc`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} invalid={!!errors.description} placeholder="e.g. Trafford Centre pitch fee" /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending}>Add expense</Button>
      </div>
    </form>
  );
}
