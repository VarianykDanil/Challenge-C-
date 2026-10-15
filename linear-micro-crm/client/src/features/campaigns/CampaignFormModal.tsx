import { useId, useState } from 'react';
import type { Campaign, CampaignSector, CampaignType } from '@lm/shared';
import { Button, Field, Input, Modal, Select, Switch, Textarea, useToast } from '@/components/ui';
import { useCreateCampaign, useUpdateCampaign } from '@/api/hooks';
import { errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { CAMPAIGN_TYPE_LABELS, SECTOR_LABELS, optionsFrom } from '@/lib/labels';

export function CampaignFormModal({ open, onClose, campaign }: { open: boolean; onClose: () => void; campaign?: Campaign | null }) {
  return (
    <Modal open={open} onClose={onClose} title={campaign ? 'Edit campaign' : 'New campaign'} size="lg">
      <CampaignForm onClose={onClose} campaign={campaign} />
    </Modal>
  );
}

function CampaignForm({ onClose, campaign }: { onClose: () => void; campaign?: Campaign | null }) {
  const toast = useToast();
  const uid = useId();
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const [f, setF] = useState({
    name: campaign?.name ?? '',
    code: campaign?.code ?? '',
    sector: campaign?.sector ?? ('charity' as CampaignSector),
    type: campaign?.type ?? ('fundraising' as CampaignType),
    payoutPerSale: String(campaign?.payoutPerSale ?? ''),
    repCommissionPerSale: String(campaign?.repCommissionPerSale ?? ''),
    color: campaign?.color ?? '#2563EB',
    active: campaign?.active ?? true,
    startDate: campaign?.startDate ?? todayISO(),
    description: campaign?.description ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Required';
    if (!/^[A-Z0-9]{2,6}$/.test(f.code.trim().toUpperCase())) e.code = '2–6 letters or digits';
    if (!(Number(f.payoutPerSale) >= 0) || f.payoutPerSale === '') e.payoutPerSale = 'Enter a payout';
    if (!(Number(f.repCommissionPerSale) >= 0) || f.repCommissionPerSale === '') e.repCommissionPerSale = 'Enter a commission';
    if (Number(f.repCommissionPerSale) > Number(f.payoutPerSale)) e.repCommissionPerSale = 'Commission cannot exceed payout';
    setErrors(e);
    if (Object.keys(e).length) return;
    const input = {
      name: f.name.trim(),
      code: f.code.trim().toUpperCase(),
      sector: f.sector,
      type: f.type,
      payoutPerSale: Number(f.payoutPerSale),
      repCommissionPerSale: Number(f.repCommissionPerSale),
      color: f.color,
      active: f.active,
      startDate: f.startDate,
      description: f.description.trim() || null,
    };
    try {
      if (campaign) await update.mutateAsync({ id: campaign.id, ...input });
      else await create.mutateAsync(input);
      toast.success(campaign ? 'Campaign updated' : 'Campaign created', input.name);
      onClose();
    } catch (err) {
      toast.error('Could not save campaign', errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" required htmlFor={`${uid}-name`} error={errors.name}><Input id={`${uid}-name`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} invalid={!!errors.name} autoFocus /></Field>
        <Field label="Code" required htmlFor={`${uid}-code`} error={errors.code} hint="Short badge, e.g. BCN"><Input id={`${uid}-code`} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={6} invalid={!!errors.code} /></Field>
        <Field label="Sector" htmlFor={`${uid}-sector`}><Select id={`${uid}-sector`} value={f.sector} onChange={(e) => setF({ ...f, sector: e.target.value as CampaignSector })} options={optionsFrom(SECTOR_LABELS)} /></Field>
        <Field label="Type" htmlFor={`${uid}-type`}><Select id={`${uid}-type`} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as CampaignType })} options={optionsFrom(CAMPAIGN_TYPE_LABELS)} /></Field>
        <Field label="Client payout per sale (£)" required htmlFor={`${uid}-payout`} error={errors.payoutPerSale}><Input id={`${uid}-payout`} type="number" min={0} step="0.01" inputMode="decimal" value={f.payoutPerSale} onChange={(e) => setF({ ...f, payoutPerSale: e.target.value })} invalid={!!errors.payoutPerSale} /></Field>
        <Field label="Rep commission per sale (£)" required htmlFor={`${uid}-comm`} error={errors.repCommissionPerSale}><Input id={`${uid}-comm`} type="number" min={0} step="0.01" inputMode="decimal" value={f.repCommissionPerSale} onChange={(e) => setF({ ...f, repCommissionPerSale: e.target.value })} invalid={!!errors.repCommissionPerSale} /></Field>
        <Field label="Start date" htmlFor={`${uid}-start`}><Input id={`${uid}-start`} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field as="div" label="Colour" hint="Used for chips and charts">
          <span className="flex items-center gap-2">
            <input id={`${uid}-color`} aria-label="Colour picker" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-10 w-14 cursor-pointer rounded-lg border border-border bg-surface p-1" />
            <Input aria-label="Colour hex" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} pattern="^#[0-9A-Fa-f]{6}$" className="font-mono uppercase" />
          </span>
        </Field>
        <Field label="Description" htmlFor={`${uid}-desc`} className="md:col-span-2"><Textarea id={`${uid}-desc`} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Switch className="md:col-span-2" checked={f.active} onChange={(active) => setF({ ...f, active })} label="Active" description="Reps can be scheduled on this campaign" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={create.isPending || update.isPending}>{campaign ? 'Save changes' : 'Create campaign'}</Button>
      </div>
    </form>
  );
}
