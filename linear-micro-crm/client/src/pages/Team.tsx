import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutGrid, List, Search, UserPlus, Users } from 'lucide-react';
import type { Position, UserStatus, UserWithTeam } from '@lm/shared';
import { POSITIONS, POSITION_LABELS, canAddPeople } from '@lm/shared';
import { Avatar, Badge, Button, Card, DataTable, EmptyState, Input, PageHeader, Select, Skeleton, type Column } from '@/components/ui';
import { useTeams, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, ExportButton, UserStatusBadge, ViewToggle } from '@/features/common';
import { AddPersonModal, UserFormModal, userCsvColumns } from '@/features/team';
import { csvFilename, sortRows } from '@/lib/csv';
import { formatDate, formatNumber, formatRelative, fullName } from '@/lib/format';
import { USER_STATUS_LABELS, optionsFrom } from '@/lib/labels';
import { usePageTitle } from '@/lib/usePageTitle';
import { COPY } from '@/content/copy';

type View = 'grid' | 'table';

export function TeamPage() {
  usePageTitle(COPY.nav.team.title);
  const me = useCurrentUser();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('grid');
  const [search, setSearch] = useState('');
  const [teamId, setTeamId] = useState('');
  const [position, setPosition] = useState<Position | ''>('');
  const [status, setStatus] = useState<UserStatus | 'all'>('active');
  const [addOpen, setAddOpen] = useState(false);
  const teams = useTeams();
  const q = useUsers({ q: search.trim() || undefined, teamId: teamId ? Number(teamId) : undefined, status });
  const teamColor = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t.color])), [teams.data]);
  const list = (q.data ?? []).filter((u) => (position ? u.position === position : true));
  // Release 1.3.1: administrators, recruiters and leaders add people (a leader to their own team, so only with one).
  const canAdd = canAddPeople(me.role) && (me.role !== 'leader' || me.teamId !== null);

  const columns: Column<UserWithTeam>[] = [
    { key: 'name', header: 'Name', render: (u) => <span className="flex items-center gap-3"><Avatar name={fullName(u)} color={u.avatarColor} size="sm" /><span><span className="block font-medium text-fg">{fullName(u)}{u.id === me.id && <span className="ml-1 text-xs text-primary">(you)</span>}</span><span className="block text-xs text-muted">{u.email}</span></span></span>, sortValue: (u) => fullName(u) },
    { key: 'position', header: 'Position', render: (u) => POSITION_LABELS[u.position], sortValue: (u) => POSITIONS.indexOf(u.position) },
    { key: 'team', header: 'Team', render: (u) => (u.teamName ? <Badge tone="neutral" dot color={u.teamId ? teamColor.get(u.teamId) : undefined}>{u.teamName}</Badge> : <span className="text-muted">—</span>), sortValue: (u) => u.teamName ?? '' },
    // Employee IDs double as sign-in codes, so the API only returns them to admins (and for yourself).
    ...(list.some((u) => u.employeeId) ? [{ key: 'employeeId', header: 'Employee ID', render: (u: UserWithTeam) => (u.employeeId ? <span className="font-mono text-xs">{u.employeeId}</span> : <span className="text-muted">—</span>), sortValue: (u: UserWithTeam) => u.employeeId }] : []),
    { key: 'start', header: 'Started', render: (u) => <span className="whitespace-nowrap">{formatDate(u.startDate)}</span>, sortValue: (u) => u.startDate },
    { key: 'status', header: 'Status', render: (u) => <UserStatusBadge status={u.status} />, sortValue: (u) => u.status },
  ];

  return (
    <>
      <PageHeader
        title={COPY.nav.team.title}
        description={teams.data ? `${COPY.nav.team.description} ${formatNumber(teams.data.length)} teams · ${formatNumber(q.data?.length ?? 0)} people.` : COPY.nav.team.description}
        actions={canAdd ? <Button onClick={() => setAddOpen(true)} leftIcon={<UserPlus className="h-4 w-4" aria-hidden />}>Add person</Button> : undefined}
      />

      {teams.data && teams.data.length > 0 && (
        <ul className="mb-5 flex flex-wrap gap-2" aria-label="Teams">
          {teams.data.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setTeamId(teamId === String(t.id) ? '' : String(t.id))} aria-pressed={teamId === String(t.id)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${teamId === String(t.id) ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-fg hover:bg-surface-2'}`}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
                {t.name}
                <span className="text-muted">{t.memberCount ?? ''}{t.leaderName ? ` · ${t.leaderName}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-4">
          <Input aria-label="Search people" placeholder="Search name, email or ID…" value={search} onChange={(e) => setSearch(e.target.value)} leftIcon={<Search className="h-4 w-4" aria-hidden />} size="sm" />
          <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="All teams" options={(teams.data ?? []).map((t) => ({ value: String(t.id), label: t.name }))} size="sm" />
          <Select aria-label="Position" value={position} onChange={(e) => setPosition(e.target.value as Position | '')} placeholder="All positions" options={optionsFrom(POSITION_LABELS, POSITIONS)} size="sm" />
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus | 'all')} options={[...optionsFrom(USER_STATUS_LABELS), { value: 'all', label: 'Everyone' }]} size="sm" />
        </div>
        <div className="flex items-center justify-end gap-2">
          <ExportButton filename={csvFilename(`team-directory-${status}`)} rows={sortRows(list, (u) => fullName(u))} columns={userCsvColumns(list.some((u) => !!u.employeeId))} disabled={q.isLoading} />
          <ViewToggle value={view} onChange={setView} options={[{ value: 'grid', label: 'Card view', icon: <LayoutGrid className="h-4 w-4" aria-hidden /> }, { value: 'table', label: 'Table view', icon: <List className="h-4 w-4" aria-hidden /> }]} />
        </div>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : view === 'table' ? (
        <DataTable columns={columns} rows={list} rowKey={(u) => u.id} loading={q.isLoading} onRowClick={(u) => navigate(`/team/${u.id}`)} emptyMessage="Nobody matches these filters" initialSort={{ key: 'name', dir: 'asc' }} />
      ) : q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={<Users className="h-8 w-8" aria-hidden />} title="Nobody matches these filters" description="Try clearing the search or choosing a different team." />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((u) => (
            <li key={u.id}>
              <Link to={`/team/${u.id}`} className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className="h-full transition hover:bg-surface-2">
                  <div className="flex items-start gap-3">
                    <Avatar name={fullName(u)} color={u.avatarColor} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-fg">{fullName(u)}{u.id === me.id && <span className="ml-1 text-xs font-normal text-primary">(you)</span>}</div>
                      <div className="text-xs text-muted">{POSITION_LABELS[u.position]}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {u.teamName && <Badge tone="neutral" dot color={u.teamId ? teamColor.get(u.teamId) : undefined}>{u.teamName}</Badge>}
                        {u.status !== 'active' && <UserStatusBadge status={u.status} />}
                      </div>
                    </div>
                  </div>
                  <dl className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
                    {u.employeeId ? <div><dt className="sr-only">Employee ID</dt><dd className="font-mono">{u.employeeId}</dd></div> : <div><dt className="sr-only">Role</dt><dd>{u.teamName ?? POSITION_LABELS[u.position]}</dd></div>}
                    <div className="text-right"><dt className="sr-only">Start date</dt><dd title={formatDate(u.startDate)}>Joined {formatRelative(u.startDate)}</dd></div>
                  </dl>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {me.role === 'admin' && <UserFormModal open={addOpen} onClose={() => setAddOpen(false)} onSaved={(u) => navigate(`/team/${u.id}`)} />}
      {me.role !== 'admin' && canAdd && <AddPersonModal open={addOpen} onClose={() => setAddOpen(false)} />}
    </>
  );
}
