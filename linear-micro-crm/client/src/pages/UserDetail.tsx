import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Mail, MapPin, Pencil, Phone } from 'lucide-react';
import { POSITION_LABELS, ROLE_LABELS } from '@lm/shared';
import { Avatar, Badge, Button, Card, CardHeader, PageHeader, Skeleton } from '@/components/ui';
import { ApiError } from '@/api/client';
import { usePayPlans, useUser, useUserPerformance } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, RangePicker, UserStatusBadge, useRangeState } from '@/features/common';
import { PerformancePanel } from '@/features/gauges';
import { UserFormModal } from '@/features/team';
import { formatDate, formatGBP, formatNumber, fullName } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { NotFoundPage } from './NotFound';

export function UserDetailPage() {
  const { id } = useParams();
  const userId = Number(id);
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const userQ = useUser(Number.isFinite(userId) ? userId : null);
  const u = userQ.data;
  usePageTitle(u ? fullName(u) : 'Profile');
  const [range, setRange] = useRangeState('this_month');
  const perf = useUserPerformance(Number.isFinite(userId) ? userId : null, { from: range.from, to: range.to });
  const plans = usePayPlans({ enabled: isAdmin });
  const plan = plans.data?.find((p) => p.id === u?.payPlanId);
  const [editOpen, setEditOpen] = useState(false);

  if (userQ.isError && userQ.error instanceof ApiError && userQ.error.status === 404) return <NotFoundPage />;

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/team" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> Team</Link>}
        title={u ? <span className="flex items-center gap-3"><Avatar name={fullName(u)} color={u.avatarColor} size="lg" />{fullName(u)}{u.id === me.id && <Badge tone="primary">You</Badge>}</span> : <Skeleton className="h-9 w-64" />}
        description={u ? <span className="flex flex-wrap items-center gap-2">{POSITION_LABELS[u.position]} · {ROLE_LABELS[u.role]}{u.teamName && <Badge tone="neutral">{u.teamName}</Badge>}<UserStatusBadge status={u.status} />{u.employeeId && <span className="font-mono text-xs">{u.employeeId}</span>}</span> : undefined}
        actions={isAdmin && u ? <Button variant="outline" onClick={() => setEditOpen(true)} leftIcon={<Pencil className="h-4 w-4" aria-hidden />}>Edit profile</Button> : undefined}
      />

      {userQ.isError ? (
        <ErrorState error={userQ.error} onRetry={() => void userQ.refetch()} title="Could not load this profile" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
          <div className="min-w-0 space-y-6">
            <Card>
              <CardHeader title="Contact" />
              {!u ? <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton /></div> : (
                <dl className="space-y-2.5 text-sm">
                  <div className="flex items-center gap-2"><Mail className="h-4 w-4 shrink-0 text-muted" aria-hidden /><dt className="sr-only">Email</dt><dd className="truncate"><a className="text-primary hover:underline" href={`mailto:${u.email}`}>{u.email}</a></dd></div>
                  <div className="flex items-center gap-2"><Phone className="h-4 w-4 shrink-0 text-muted" aria-hidden /><dt className="sr-only">Phone</dt><dd>{u.phone ? <a className="text-primary hover:underline" href={`tel:${u.phone}`}>{u.phone}</a> : <span className="text-muted">No phone</span>}</dd></div>
                  <div className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden /><dt className="sr-only">City</dt><dd>{u.city ?? <span className="text-muted">—</span>}</dd></div>
                  <div className="flex justify-between gap-2 border-t border-border pt-2.5"><dt className="text-muted">Started</dt><dd>{formatDate(u.startDate)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Pay plan</dt><dd>{u.payPlanName}</dd></div>
                </dl>
              )}
            </Card>
            {isAdmin && (
              <Card>
                <CardHeader title="Pay plan" description="Visible to administrators" />
                {plans.isLoading ? <div className="space-y-2"><Skeleton /><Skeleton /></div> : plan ? (
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-2"><dt className="text-muted">Plan</dt><dd className="font-medium text-fg">{plan.name}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Base per day</dt><dd className="tabular-nums">{formatGBP(plan.basePerDay, { cents: true })}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Commission per sale</dt><dd className="tabular-nums">{formatGBP(plan.commissionPerSale, { cents: true })}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Weekly bonus</dt><dd className="tabular-nums">{plan.bonusThreshold > 0 ? `${formatGBP(plan.bonusAmount)} at ${formatNumber(plan.bonusThreshold)} sales` : '—'}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Override per team sale</dt><dd className="tabular-nums">{plan.overridePerTeamSale > 0 ? formatGBP(plan.overridePerTeamSale, { cents: true }) : '—'}</dd></div>
                  </dl>
                ) : <p className="text-sm text-muted">No pay plan details available.</p>}
              </Card>
            )}
          </div>
          <div className="min-w-0 space-y-5 lg:col-span-3">
            <RangePicker value={range} onChange={setRange} />
            <PerformancePanel data={perf.data} loading={perf.isLoading} error={perf.error} onRetry={() => void perf.refetch()} range={range} />
          </div>
        </div>
      )}

      {isAdmin && u && <UserFormModal open={editOpen} onClose={() => setEditOpen(false)} user={u} />}
    </>
  );
}
