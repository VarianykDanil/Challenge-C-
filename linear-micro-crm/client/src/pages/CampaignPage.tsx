// Release 1.3 — /campaigns/:id — OWNED BY P6 client-portal. One client's campaign: the full description and the brief
// for the field team, the client's contact, sales this month and last, this month's events, every client post (admins
// and leaders: with its status, Approve / Decline / Unpublish for admins) or, for reps and recruiters, the client's
// announcements; the rate history (admins and leaders) and the client accounts (admins). The server trims what each role
// sees (GET /campaigns/:id/page): reps and recruiters never get money or the client contact's email and phone (they are
// pointed to their leader or the office). `?post=<id>` (from Needs attention) scrolls to it.
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, ClipboardList, History, Mail, Megaphone, Pencil, Phone, TrendingUp, UserRound } from 'lucide-react';
import type { CampaignPage, CampaignRate, SalesEventWithMeta } from '@lm/shared';
import { useCampaignPage } from '@/api/clientPortal';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, CardHeader, EmptyState, KpiTile, PageHeader, Skeleton } from '@/components/ui';
import { CampaignBriefModal } from '@/features/campaigns/CampaignBriefModal';
import { ClientAccountsCard } from '@/features/campaigns/ClientAccountsCard';
import { ClientPostsCard } from '@/features/campaigns/ClientPostsCard';
import { ErrorState } from '@/features/common';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { AnnouncementItem } from '@/features/dashboard/Announcements';
import { COPY } from '@/content/copy';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatGBP, formatNumber, formatTime } from '@/lib/format';
import { CAMPAIGN_TYPE_LABELS, EVENT_STATUS_LABELS, SECTOR_LABELS } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';

const SOURCE_LABELS: Record<CampaignRate['source'], string> = { seed: 'Starting rate', admin: 'Office', client: 'Client’s change' };

export function CampaignPagePage() {
  const { id } = useParams();
  const campaignId = Number(id);
  const valid = Number.isInteger(campaignId) && campaignId > 0;
  const me = useCurrentUser();
  const [params] = useSearchParams();
  const focusId = Number(params.get('post')) || null;
  const q = useCampaignPage(valid ? campaignId : null);
  const page = q.data;
  const [editing, setEditing] = useState(false);
  usePageTitle(page?.campaign.name ?? COPY.nav.campaignPage.title);
  const office = me.role === 'admin' || me.role === 'leader';
  const back = office ? (
    <Link to="/campaigns" className="inline-flex min-h-10 items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> Campaigns</Link>
  ) : (
    <Link to="/" className="inline-flex min-h-10 items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> Dashboard</Link>
  );

  if (!valid || q.isError) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={COPY.nav.campaignPage.title} />
        <ErrorState error={q.error ?? new Error('Campaign not found')} onRetry={valid ? () => void q.refetch() : undefined} title="Could not load this campaign" />
      </>
    );
  }
  if (!page) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={<Skeleton className="h-8 w-64" />} />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">{[0, 1].map((i) => <Skeleton key={i} className="h-56" />)}</div>
          <Skeleton className="h-72" />
        </div>
      </>
    );
  }

  const c = page.campaign;
  return (
    <>
      <PageHeader
        breadcrumbs={back}
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
            <Badge tone="neutral" dot color={c.color}>{c.code}</Badge>
            <Badge tone="info">{SECTOR_LABELS[c.sector]}</Badge>
            <Badge tone="neutral">{CAMPAIGN_TYPE_LABELS[c.type]}</Badge>
            {!c.active && <Badge tone="neutral">Inactive</Badge>}
          </span>
        }
        title={c.name}
        description={c.description ?? COPY.nav.campaignPage.description}
        actions={me.role === 'admin' ? <Button variant="outline" onClick={() => setEditing(true)} leftIcon={<Pencil aria-hidden />}>Edit brief</Button> : undefined}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <SalesTiles page={page} />
          <BriefCard page={page} />
          {page.full ? (
            <ClientPostsCard posts={page.posts} announcements={page.announcements} current={{ repCommissionPerSale: c.repCommissionPerSale, payoutPerSale: c.payoutPerSale }} focusId={focusId} paidThrough={page.paidThrough ?? null} />
          ) : (
            <ClientAnnouncements page={page} />
          )}
          <EventsThisMonth events={page.eventsThisMonth} ownTeam={me.role === 'rep'} />
        </div>
        <div className="min-w-0 space-y-6">
          <ContactCard page={page} />
          {page.full && <RatesCard page={page} />}
          {page.clientAccounts && (
            <ErrorBoundary name="client-accounts" fallback={null}>
              <ClientAccountsCard campaignId={c.id} campaignName={c.name} accounts={page.clientAccounts} />
            </ErrorBoundary>
          )}
        </div>
      </div>
      {editing && <CampaignBriefModal campaignId={c.id} campaignName={c.name} brief={c} onClose={() => setEditing(false)} />}
    </>
  );
}

function SalesTiles({ page }: { page: CampaignPage }) {
  const { thisMonth, lastMonth } = page.sales;
  const delta = lastMonth > 0 ? (thisMonth - lastMonth) / lastMonth : null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      <KpiTile label="This month" value={formatNumber(thisMonth)} suffix="sales" icon={<TrendingUp aria-hidden />} tone="primary" delta={delta} deltaLabel="vs last month" size="sm" />
      <KpiTile label="Last month" value={formatNumber(lastMonth)} suffix="sales" icon={<History aria-hidden />} size="sm" />
    </div>
  );
}

/** The brief, one point per line, as a list (a single paragraph stays a paragraph). */
function BriefLines({ text }: { text: string }) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return <p className="whitespace-pre-line break-words text-sm text-fg">{text}</p>;
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm text-fg marker:text-muted">
      {lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}
    </ul>
  );
}

function BriefCard({ page }: { page: CampaignPage }) {
  const c = page.campaign;
  return (
    <Card data-testid="campaign-brief">
      <CardHeader icon={<ClipboardList />} title="About the client and the brief" />
      {!c.longDescription && !c.brief ? (
        <p className="text-sm text-muted">No brief yet.{page.clientAccounts ? ' Use Edit brief to add what the field team should know.' : ''}</p>
      ) : (
        <div className="space-y-4">
          {c.longDescription && <p className="whitespace-pre-line break-words text-sm leading-relaxed text-muted">{c.longDescription}</p>}
          {c.brief && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Brief for the field team</h4>
              <BriefLines text={c.brief} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ContactCard({ page }: { page: CampaignPage }) {
  const c = page.campaign;
  const has = c.contactName || c.contactEmail || c.contactPhone;
  return (
    <Card data-testid="campaign-contact">
      <CardHeader icon={<UserRound />} title="Client contact" />
      {!page.full ? (
        // Reps and recruiters: the server sends no contact details (they are the client's own).
        <p className="text-sm text-muted">Questions for {c.name} go through your team leader or the Linear MCR office. They speak to the client for you.</p>
      ) : !has ? (
        <p className="text-sm text-muted">No contact recorded.</p>
      ) : (
        <div className="space-y-1 text-sm">
          {c.contactName && <p className="font-medium text-fg">{c.contactName}</p>}
          {c.contactEmail && (
            <a href={`mailto:${c.contactEmail}`} title={c.contactEmail} className="focus-ring flex min-h-10 min-w-0 items-center gap-2 rounded-md text-primary hover:underline">
              <Mail className="h-4 w-4 shrink-0" aria-hidden /> <span className="min-w-0 truncate">{c.contactEmail}</span>
            </a>
          )}
          {c.contactPhone && (
            <a href={`tel:${c.contactPhone.replace(/\s+/g, '')}`} className="focus-ring flex min-h-10 items-center gap-2 rounded-md text-primary hover:underline">
              <Phone className="h-4 w-4 shrink-0" aria-hidden /> {c.contactPhone}
            </a>
          )}
        </div>
      )}
      {page.full && c.payoutPerSale !== undefined && c.repCommissionPerSale !== undefined && (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
          <div><dt className="text-xs text-muted">Payout per sub</dt><dd className="font-semibold tabular-nums text-fg">{formatGBP(c.payoutPerSale, { cents: true })}</dd></div>
          <div><dt className="text-xs text-muted">Rate to the fundraiser</dt><dd className="font-semibold tabular-nums text-fg">{formatGBP(c.repCommissionPerSale, { cents: true })}</dd></div>
        </dl>
      )}
    </Card>
  );
}

function RatesCard({ page }: { page: CampaignPage }) {
  const rates = page.rates ?? [];
  return (
    <Card data-testid="campaign-rates">
      <CardHeader icon={<History />} title="Rate history" description="Each rate applies from its date; paid weeks never change." />
      {!rates.length ? (
        <p className="text-sm text-muted">No rate changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rates.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium text-fg">From {formatDateShort(r.effectiveFrom)}</p>
                <p className="text-xs text-muted">{SOURCE_LABELS[r.source] ?? r.source}{r.approvedByName ? ` · ${r.approvedByName}` : ''}</p>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-fg">{formatGBP(r.repRate, { cents: true })} <span className="text-xs text-muted">to rep</span></p>
                <p className="text-xs text-muted">{formatGBP(r.payoutRate, { cents: true })} payout</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClientAnnouncements({ page }: { page: CampaignPage }) {
  return (
    <Card className="@container" data-testid="campaign-announcements">
      <CardHeader icon={<Megaphone />} title={`Announcements from ${page.campaign.name}`} description="What the client posted for the team." />
      {!page.announcements.length ? (
        <EmptyState icon={<Megaphone aria-hidden />} title="Nothing from the client yet" size="sm" className="border-0" />
      ) : (
        <ul className="space-y-3">
          {page.announcements.map((a) => <AnnouncementItem key={a.id} announcement={a} />)}
        </ul>
      )}
    </Card>
  );
}

/** How many events each group shows before "Show all". */
const EVENTS_SHOWN = 5;

function EventRowLink({ e }: { e: SalesEventWithMeta }) {
  return (
    <li>
      <Link to={`/events/${e.id}`} className="focus-ring -mx-2 flex min-h-12 items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{e.name}</span>
          <span className="block truncate text-xs text-muted">
            {formatDateShort(e.date)} · {formatTime(e.startTime)}–{formatTime(e.endTime)} · {e.venue}, {e.city} · {e.teamName}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold tabular-nums text-fg">{formatNumber(e.totals.sales)}<span className="text-xs font-normal text-muted"> / {formatNumber(e.targetSales)}</span></span>
          <span className="block text-[11px] text-muted">{EVENT_STATUS_LABELS[e.status]}</span>
        </span>
      </Link>
    </li>
  );
}

/** This month's events: what is coming up first (soonest first), then the earlier ones (latest first). */
function EventsThisMonth({ events, ownTeam }: { events: SalesEventWithMeta[]; ownTeam: boolean }) {
  const [all, setAll] = useState(false);
  const today = todayISO();
  const upcoming = events.filter((e) => e.date >= today);
  const earlier = events.filter((e) => e.date < today).reverse();
  const shown = (list: SalesEventWithMeta[]) => (all ? list : list.slice(0, EVENTS_SHOWN));
  const hidden = all ? 0 : Math.max(0, upcoming.length - EVENTS_SHOWN) + Math.max(0, earlier.length - EVENTS_SHOWN);
  const sales = events.reduce((n, e) => n + e.totals.sales, 0);
  return (
    <Card data-testid="campaign-events">
      <CardHeader
        icon={<CalendarDays />}
        title="Events this month"
        description={`${ownTeam ? 'Your team’s events' : 'Every team’s events'} for this campaign: ${formatNumber(events.length)} ${events.length === 1 ? 'event' : 'events'}, ${formatNumber(sales)} sales logged.`}
      />
      {!events.length ? (
        <p className="text-sm text-muted">No events this month.</p>
      ) : (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Coming up</h4>
              <ul className="divide-y divide-border">{shown(upcoming).map((e) => <EventRowLink key={e.id} e={e} />)}</ul>
            </div>
          )}
          {earlier.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Earlier this month</h4>
              <ul className="divide-y divide-border">{shown(earlier).map((e) => <EventRowLink key={e.id} e={e} />)}</ul>
            </div>
          )}
          {(hidden > 0 || all) && (
            <Button variant="ghost" onClick={() => setAll((v) => !v)} className="w-full">
              {all ? 'Show fewer events' : `Show all ${formatNumber(events.length)} events`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
