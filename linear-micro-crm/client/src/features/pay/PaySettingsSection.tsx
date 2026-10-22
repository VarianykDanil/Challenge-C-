// Release 1.3 slot — OWNED BY P1 pay-rule. Settings → Pay (administrators): the day rate (£63.50) and the Monday the
// base-or-commission rule applies from (PAY_RULE_FROM), and each campaign's rate per sub with its history and "Add a
// rate". Mounted in pages/Settings.tsx in the left column after the backups card, in an ErrorBoundary with
// fallback={null}. GET/PUT /pay/settings, GET/POST /pay/rates.
import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Plus, Wallet } from 'lucide-react';
import clsx from 'clsx';
import type { CampaignRate } from '@lm/shared';
import { payDayLabel, payMoney } from '@lm/shared';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Select, Skeleton, useToast } from '@/components/ui';
import { useCampaigns } from '@/api/hooks';
import { useAddCampaignRate, useCampaignRates, usePaySettings, useUpdatePaySettings } from '@/api/pay';
import { ColourChip, ErrorState, errorMessage } from '@/features/common';
import { todayISO } from '@/lib/dates';
import { mondayOfISO } from './AdjustmentModal';

/** "Thu 10 Sep" this year, "Mon 2 Sep 2024" any other (a campaign's starting rate can be years old). */
const dayLabel = (iso: string) => (iso.slice(0, 4) === todayISO().slice(0, 4) ? payDayLabel(iso) : `${payDayLabel(iso)} ${iso.slice(0, 4)}`);

export interface PaySettingsSectionProps {
  className?: string;
}

const SOURCE_LABEL = { seed: 'starting rate', admin: 'set by the office', client: "client's change, approved" } as const;

export function PaySettingsSection({ className }: PaySettingsSectionProps) {
  const uid = useId();
  const toast = useToast();
  const settings = usePaySettings();
  const save = useUpdatePaySettings();
  const rates = useCampaignRates();
  const campaigns = useCampaigns();
  const [form, setForm] = useState<{ dayRate: string; ruleFrom: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (settings.data && !form) setForm({ dayRate: settings.data.dayRate.toFixed(2), ruleFrom: settings.data.ruleFrom });
  }, [settings.data, form]);

  const today = todayISO();
  const byCampaign = useMemo(() => {
    const m = new Map<number, CampaignRate[]>();
    for (const r of rates.data ?? []) {
      const list = m.get(r.campaignId) ?? [];
      list.push(r);
      m.set(r.campaignId, list);
    }
    return m;
  }, [rates.data]);

  const dirty = !!form && !!settings.data && (Number(form.dayRate) !== settings.data.dayRate || form.ruleFrom !== settings.data.ruleFrom);
  const submit = async () => {
    if (!form || !settings.data) return;
    const e: Record<string, string> = {};
    const rate = Number(form.dayRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 500) e.dayRate = 'Enter a day rate between £0.01 and £500';
    if (!form.ruleFrom) e.ruleFrom = 'Pick a Monday';
    else if (mondayOfISO(form.ruleFrom) !== form.ruleFrom) e.ruleFrom = 'Pick a Monday: pay weeks run Monday to Sunday';
    else if (form.ruleFrom > mondayOfISO(today)) e.ruleFrom = 'It cannot be after this week';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      const next = await save.mutateAsync({
        ...(rate !== settings.data.dayRate ? { dayRate: Math.round(rate * 100) / 100 } : {}),
        ...(form.ruleFrom !== settings.data.ruleFrom ? { ruleFrom: form.ruleFrom } : {}),
      });
      setForm({ dayRate: next.dayRate.toFixed(2), ruleFrom: next.ruleFrom });
      toast.success('Pay settings saved', 'Unpaid weeks were recalculated; paid weeks never change.');
    } catch (err) {
      toast.error('Could not save the pay settings', errorMessage(err));
    }
  };

  return (
    <Card className={className} data-pay-settings="">
      <CardHeader title="Pay" description="The base-or-commission rule and each campaign's rate per sub" icon={<Wallet aria-hidden />} />
      {settings.isLoading || !form ? (
        settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} className="p-3" /> : (
          <div className="space-y-2" aria-busy><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-10 w-full" /></div>
        )
      ) : (
        <>
          <p className="text-sm text-muted">
            Each week pays the <span className="font-medium text-fg">base</span> — the day rate × the days worked — or the{' '}
            <span className="font-medium text-fg">commission</span> — the paid subs × each campaign&apos;s rate — whichever is higher (a tie pays the
            commission). Bonuses you add and corrections from clients&apos; statements come on top. There is no automatic bonus or leader override.
          </p>
          <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Day rate (£)" htmlFor={`${uid}-rate`} error={errors.dayRate} hint="The same for everyone">
                <Input id={`${uid}-rate`} type="number" min={0} max={500} step="0.01" inputMode="decimal" value={form.dayRate} onChange={(e) => setForm({ ...form, dayRate: e.target.value })} invalid={!!errors.dayRate} />
              </Field>
              <Field label="The rule applies from" htmlFor={`${uid}-from`} error={errors.ruleFrom} hint={`A Monday. Weeks before it keep the old pay plans${settings.data ? ` (now ${dayLabel(settings.data.ruleFrom)})` : ''}`}>
                <Input id={`${uid}-from`} type="date" value={form.ruleFrom} max={mondayOfISO(today)} onChange={(e) => setForm({ ...form, ruleFrom: e.target.value })} invalid={!!errors.ruleFrom} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="text-xs text-muted">Saving recalculates the unpaid weeks; paid weeks never change.</span>
              <Button type="submit" disabled={!dirty} loading={save.isPending}>Save pay settings</Button>
            </div>
          </form>

          <div className="mt-6 flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Rate per sub, by campaign</h4>
            <Button size="sm" variant="outline" className="h-10 sm:h-8" leftIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>Add a rate</Button>
          </div>
          {rates.isError ? <ErrorState error={rates.error} onRetry={() => void rates.refetch()} className="mt-2 p-3" /> : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border" aria-label="Campaign rates">
              {(campaigns.data ?? []).map((c) => {
                const history = byCampaign.get(c.id) ?? [];
                const current = history.find((r) => r.effectiveFrom <= today) ?? history[history.length - 1];
                const upcoming = history.filter((r) => r.effectiveFrom > today);
                const expanded = open === c.id;
                return (
                  <li key={c.id} className="px-3 py-2.5">
                    <button
                      type="button"
                      className="focus-ring flex min-h-10 w-full items-center justify-between gap-3 rounded-md text-left"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : c.id)}
                    >
                      <span className="min-w-0">
                        <ColourChip color={c.color} label={c.name} className="font-medium text-fg" />
                        <span className="mt-0.5 block text-xs text-muted">
                          {current ? `${payMoney(current.repRate)} a sub to the rep · ${payMoney(current.payoutRate)} payout · since ${dayLabel(current.effectiveFrom)}` : `${payMoney(c.repCommissionPerSale)} a sub to the rep`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {upcoming.length > 0 && <Badge tone="info" size="sm">Change from {dayLabel(upcoming[upcoming.length - 1]!.effectiveFrom)}</Badge>}
                        <ChevronDown className={clsx('h-4 w-4 text-muted transition-transform', expanded && 'rotate-180')} aria-hidden />
                      </span>
                    </button>
                    {expanded && (
                      <ol className="mt-2 space-y-1 border-l-2 border-border pl-3 text-xs" aria-label={`${c.name} rate history`}>
                        {history.map((r) => (
                          <li key={r.id} className={clsx(r === current ? 'text-fg' : 'text-muted')}>
                            From {dayLabel(r.effectiveFrom)}: {payMoney(r.repRate)} a sub, {payMoney(r.payoutRate)} payout · {SOURCE_LABEL[r.source]}{r.approvedByName ? ` by ${r.approvedByName}` : ''}
                          </li>
                        ))}
                        {!history.length && <li className="text-muted">No history yet: the campaign&apos;s own rate applies.</li>}
                      </ol>
                    )}
                  </li>
                );
              })}
              {rates.isLoading && <li className="p-3"><Skeleton className="h-4 w-1/2" /></li>}
            </ul>
          )}
        </>
      )}
      {adding && <RateModal onClose={() => setAdding(false)} />}
    </Card>
  );
}

/** "Add a rate": a campaign's new rate per sub (and payout) from a date; unpaid weeks from then are recalculated. */
function RateModal({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const campaigns = useCampaigns();
  const add = useAddCampaignRate();
  const [f, setF] = useState({ campaignId: '', repRate: '', payoutRate: '', effectiveFrom: todayISO() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const chosen = campaigns.data?.find((c) => String(c.id) === f.campaignId);
  const submit = async () => {
    const e: Record<string, string> = {};
    const rep = Number(f.repRate);
    const payout = Number(f.payoutRate);
    if (!f.campaignId) e.campaignId = 'Choose a campaign';
    if (f.repRate === '' || !Number.isFinite(rep) || rep < 0) e.repRate = 'Enter £0 or more';
    if (!f.payoutRate || !Number.isFinite(payout) || payout <= 0) e.payoutRate = 'Enter an amount above £0';
    if (!f.effectiveFrom) e.effectiveFrom = 'Pick a date';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await add.mutateAsync({ campaignId: Number(f.campaignId), repRate: Math.round(rep * 100) / 100, payoutRate: Math.round(payout * 100) / 100, effectiveFrom: f.effectiveFrom });
      toast.success('Rate added', `${chosen?.code ?? 'Campaign'}: ${payMoney(rep)} a sub from ${dayLabel(f.effectiveFrom)}`);
      onClose();
    } catch (err) {
      toast.error('Could not add the rate', errorMessage(err));
    }
  };
  return (
    <Modal open onClose={onClose} title="Add a rate" description="Unpaid weeks from that date are recalculated; paid weeks never change." size="md">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Campaign" required htmlFor={`${uid}-c`} error={errors.campaignId}>
          <Select
            id={`${uid}-c`}
            value={f.campaignId}
            onChange={(e) => {
              const c = campaigns.data?.find((x) => String(x.id) === e.target.value);
              setF({ ...f, campaignId: e.target.value, repRate: c ? String(c.repCommissionPerSale) : f.repRate, payoutRate: c ? String(c.payoutPerSale) : f.payoutRate });
            }}
            placeholder="Choose a campaign"
            options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            invalid={!!errors.campaignId}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="To the rep, per sub (£)" required htmlFor={`${uid}-r`} error={errors.repRate}>
            <Input id={`${uid}-r`} type="number" min={0} step="0.01" inputMode="decimal" value={f.repRate} onChange={(e) => setF({ ...f, repRate: e.target.value })} invalid={!!errors.repRate} />
          </Field>
          <Field label="Client pays, per sub (£)" required htmlFor={`${uid}-p`} error={errors.payoutRate}>
            <Input id={`${uid}-p`} type="number" min={0} step="0.01" inputMode="decimal" value={f.payoutRate} onChange={(e) => setF({ ...f, payoutRate: e.target.value })} invalid={!!errors.payoutRate} />
          </Field>
        </div>
        <Field label="From" required htmlFor={`${uid}-d`} error={errors.effectiveFrom} hint="Sales on and after this day use the new rate">
          <Input id={`${uid}-d`} type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} invalid={!!errors.effectiveFrom} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={add.isPending}>Add rate</Button>
        </div>
      </form>
    </Modal>
  );
}
