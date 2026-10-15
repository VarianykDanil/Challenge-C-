import { useMemo, useState } from 'react';
import { Megaphone, Pencil, Plus } from 'lucide-react';
import type { Campaign } from '@lm/shared';
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, Tabs } from '@/components/ui';
import { useCampaigns, useGaugeSummary } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, ExportButton } from '@/features/common';
import { CampaignFormModal } from '@/features/campaigns';
import { csvDate, csvFilename, csvLabel, csvMoney, csvPct, csvYesNo, type CsvColumn } from '@/lib/csv';
import { presetRange } from '@/lib/dates';
import { formatDate, formatGBP, formatNumber, formatPct } from '@/lib/format';
import { CAMPAIGN_TYPE_LABELS, SECTOR_LABELS } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

type Filter = 'all' | 'active' | 'inactive';

export function CampaignsPage() {
  usePageTitle(COPY.nav.campaigns.title);
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const [filter, setFilter] = useState<Filter>('active');
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const q = useCampaigns();
  const month = useMemo(() => presetRange('this_month'), []);
  const sales = useGaugeSummary({ groupBy: 'campaign', from: month.from, to: month.to });
  const salesByCampaign = useMemo(() => new Map((sales.data ?? []).map((r) => [r.key, r])), [sales.data]);

  const list = (q.data ?? []).filter((c) => (filter === 'all' ? true : filter === 'active' ? c.active : !c.active));

  const csvColumns = useMemo<CsvColumn<Campaign>[]>(() => {
    const pct = csvPct(1);
    return [
      { key: 'name', header: 'Campaign' },
      { key: 'code', header: 'Code' },
      { key: 'sector', header: 'Sector', format: csvLabel(SECTOR_LABELS) },
      { key: 'type', header: 'Type', format: csvLabel(CAMPAIGN_TYPE_LABELS) },
      { key: 'payoutPerSale', header: 'Payout per sale', format: csvMoney },
      { key: 'repCommissionPerSale', header: 'Rep commission per sale', format: csvMoney },
      { key: 'margin', header: 'Margin %', format: (_, c) => (c.payoutPerSale > 0 ? pct((c.payoutPerSale - c.repCommissionPerSale) / c.payoutPerSale) : '') },
      { key: 'active', header: 'Active', format: csvYesNo },
      { key: 'salesThisMonth', header: 'Sales this month', format: (_, c) => String(salesByCampaign.get(String(c.id))?.sales ?? 0) },
      { key: 'conversionThisMonth', header: 'Conversion this month', format: (_, c) => { const r = salesByCampaign.get(String(c.id)); return r && r.days > 0 ? pct(r.ratios.overallConversion) : ''; } },
      { key: 'startDate', header: 'Start date', format: csvDate },
    ];
  }, [salesByCampaign]);

  return (
    <>
      <PageHeader
        title={COPY.nav.campaigns.title}
        description={COPY.nav.campaigns.description}
        actions={
          <>
            <ExportButton size="md" filename={csvFilename(`campaigns-${filter}`)} rows={list} columns={csvColumns} disabled={q.isLoading || sales.isLoading} />
            {isAdmin && <Button onClick={() => setCreateOpen(true)} leftIcon={<Plus className="h-4 w-4" aria-hidden />}>New campaign</Button>}
          </>
        }
      />
      <Tabs variant="pills" className="mb-5" value={filter} onChange={(v) => setFilter(v as Filter)} items={[{ value: 'active', label: 'Active', count: q.data?.filter((c) => c.active).length }, { value: 'inactive', label: 'Inactive', count: q.data?.filter((c) => !c.active).length }, { value: 'all', label: 'All' }]} />

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={<Megaphone className="h-8 w-8" aria-hidden />} title={filter === 'inactive' ? 'No inactive campaigns' : 'No campaigns yet'} description={isAdmin ? 'Create the first campaign to start scheduling events.' : undefined} action={isAdmin ? <Button onClick={() => setCreateOpen(true)}>New campaign</Button> : undefined} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => {
            const row = salesByCampaign.get(String(c.id));
            const margin = c.payoutPerSale > 0 ? (c.payoutPerSale - c.repCommissionPerSale) / c.payoutPerSale : 0;
            return (
              <li key={c.id}>
                <Card padded={false} className={`overflow-hidden ${c.active ? '' : 'opacity-75'}`}>
                  <div className="h-2" style={{ backgroundColor: c.color }} aria-hidden />
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-base font-semibold text-fg">{c.name}</h3>
                          <Badge tone="neutral" dot color={c.color}>{c.code}</Badge>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Badge tone="info">{SECTOR_LABELS[c.sector]}</Badge>
                          <Badge tone="neutral">{CAMPAIGN_TYPE_LABELS[c.type]}</Badge>
                          <Badge tone={c.active ? 'success' : 'neutral'} dot>{c.active ? 'Active' : 'Inactive'}</Badge>
                        </div>
                      </div>
                      {isAdmin && <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="h-4 w-4" aria-hidden /></Button>}
                    </div>
                    {c.description && <p className="mt-3 line-clamp-2 text-sm text-muted">{c.description}</p>}
                    <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                      <div><dt className="text-xs text-muted">Payout / sale</dt><dd className="font-semibold tabular-nums text-fg">{formatGBP(c.payoutPerSale)}</dd></div>
                      <div><dt className="text-xs text-muted">Commission</dt><dd className="font-semibold tabular-nums text-fg">{formatGBP(c.repCommissionPerSale)}</dd></div>
                      <div><dt className="text-xs text-muted">Margin</dt><dd className="font-semibold tabular-nums text-fg">{formatPct(margin)}</dd></div>
                    </dl>
                    <div className="mt-4 flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                      <span className="text-muted">Sales this month</span>
                      <span className="font-semibold tabular-nums text-fg">{sales.isLoading ? '…' : formatNumber(row?.sales ?? 0)}{row && row.days > 0 && <span className="ml-1 text-xs font-normal text-muted">· {formatPct(row.ratios.overallConversion, 1)} conv.</span>}</span>
                    </div>
                    <p className="mt-3 text-xs text-muted">Since {formatDate(c.startDate)}</p>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {isAdmin && <CampaignFormModal open={createOpen} onClose={() => setCreateOpen(false)} />}
      {isAdmin && <CampaignFormModal key={editing?.id ?? 'none'} open={!!editing} onClose={() => setEditing(null)} campaign={editing} />}
    </>
  );
}
