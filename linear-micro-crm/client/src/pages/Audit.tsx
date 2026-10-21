// Release 1.2 — /audit (admin) — OWNED BY U3 audit-trail.
// Every successful change through Linear Hub, newest first: who, when, a readable summary and (expanded) the field-level
// diff. Filters live in the URL (person, kind of record, one record, dates, words) so a view can be bookmarked and the
// payslip / gauge history can link straight to a record's full trail.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FilterX, History, Search, X } from 'lucide-react';
import { AUDIT_ENTITIES, AUDIT_ENTITY_LABELS, isAuditEntity, type AuditEntryDetail } from '@lm/shared';
import { useAuditLog } from '@/api/audit';
import { useUsers } from '@/api/hooks';
import { Button, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Switch } from '@/components/ui';
import { COPY } from '@/content/copy';
import { AuditEntryItem } from '@/features/audit/AuditEntryItem';
import { auditDayHeading } from '@/features/audit/dayHeading';
import { ErrorState } from '@/features/common';
import { toISODate } from '@/lib/dates';
import { formatNumber, fullName } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

const PAGE_SIZE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function positiveInt(v: string | null): number | null {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
}

/** Rows grouped under their (local) calendar day, newest day first; the rows keep the server's order. */
function byDay(rows: AuditEntryDetail[]): { day: string; rows: AuditEntryDetail[] }[] {
  const groups: { day: string; rows: AuditEntryDetail[] }[] = [];
  for (const r of rows) {
    const day = toISODate(new Date(r.at));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  return groups;
}

export function AuditPage() {
  usePageTitle(COPY.nav.audit.title);
  const [params, setParams] = useSearchParams();
  const userId = positiveInt(params.get('userId'));
  const entityParam = params.get('entity');
  const entity = isAuditEntity(entityParam) ? entityParam : '';
  const entityId = positiveInt(params.get('entityId'));
  const from = DATE_RE.test(params.get('from') ?? '') ? params.get('from')! : '';
  const to = DATE_RE.test(params.get('to') ?? '') ? params.get('to')! : '';
  const q = (params.get('q') ?? '').trim();
  const page = positiveInt(params.get('page')) ?? 1;
  // sign-ins and sign-outs are left out unless asked for: the page is about changes
  const signIns = params.get('signins') === '1';
  const rangeInvalid = Boolean(from && to && from > to);

  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  /** Change some filters (empty values drop out of the URL); any filter change goes back to page 1. */
  const update = (patch: Record<string, string | number | null>, keepPage = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, String(v));
        }
        if (!keepPage) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  // the search box writes to the URL after a short pause
  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== q) update({ q: search.trim() });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const users = useUsers({ status: 'all' });
  const people = useMemo(
    () => [...(users.data ?? [])].sort((a, b) => fullName(a).localeCompare(fullName(b))).map((u) => ({ value: String(u.id), label: `${fullName(u)}${u.status === 'left' ? ' (left)' : ''}` })),
    [users.data],
  );
  const log = useAuditLog(
    { userId, entity, entityId, from: from || undefined, to: to || undefined, q: q || undefined, signIns, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
    { enabled: !rangeInvalid },
  );
  const data = log.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE);
  const filtered = Boolean(userId || entity || entityId || from || to || q);
  const groups = useMemo(() => byDay(data?.rows ?? []), [data?.rows]);
  // a bookmarked page beyond the end (the log was purged, filters narrowed it) goes to the last page
  useEffect(() => {
    if (data && !log.isPlaceholderData && page > pages) update({ page: pages > 1 ? pages : null }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page, pages]);
  /** Drops every filter but keeps the sign-ins choice. */
  const clearFilters = () => {
    setSearch('');
    setParams(signIns ? new URLSearchParams({ signins: '1' }) : new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <PageHeader
        title={COPY.nav.audit.title}
        description={COPY.nav.audit.description}
        icon={<History aria-hidden />}
      />

      <Card className="mb-4" padded={false}>
        <form className="grid grid-cols-2 gap-3 p-3 sm:p-4 xl:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() }); }}>
          <Field label="Search" htmlFor="audit-q" className="col-span-2 min-w-0 xl:col-span-1">
            <Input id="audit-q" type="search" placeholder="e.g. marked paid" title="Words in the summary, e.g. marked paid or a name" value={search} onChange={(e) => setSearch(e.target.value)} leftIcon={<Search aria-hidden />} />
          </Field>
          <Field label="Person" htmlFor="audit-person" className="col-span-2 min-w-0 sm:col-span-1">
            <Select id="audit-person" value={userId ? String(userId) : ''} onChange={(e) => update({ userId: e.target.value })} placeholder="Everyone" options={people} />
          </Field>
          <Field label="Record" htmlFor="audit-entity" className="col-span-2 min-w-0 sm:col-span-1">
            <Select
              id="audit-entity"
              value={entity}
              onChange={(e) => update({ entity: e.target.value, entityId: null })}
              placeholder="Every kind"
              options={AUDIT_ENTITIES.map((k) => ({ value: k, label: AUDIT_ENTITY_LABELS[k] }))}
            />
          </Field>
          <Field label="From" htmlFor="audit-from" className="min-w-0" error={rangeInvalid ? 'Pick a start on or before the end' : undefined}>
            <Input id="audit-from" type="date" value={from} max={to || undefined} onChange={(e) => update({ from: e.target.value })} invalid={rangeInvalid} />
          </Field>
          <Field label="To" htmlFor="audit-to" className="min-w-0">
            <Input id="audit-to" type="date" value={to} min={from || undefined} onChange={(e) => update({ to: e.target.value })} invalid={rangeInvalid} />
          </Field>
        </form>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2 sm:px-4">
          <Switch size="sm" checked={signIns} onChange={(on) => update({ signins: on ? '1' : null })} label="Show sign-ins" labelPosition="end" className="min-h-10" />
          {filtered && (
            <>
            {entityId && (
              <Button variant="soft" size="sm" className="h-10 sm:h-8" rightIcon={<X aria-hidden />} onClick={() => update({ entityId: null })} aria-label={`Only ${entity ? AUDIT_ENTITY_LABELS[entity] : 'record'} #${entityId}: show every record of this kind`}>
                {entity ? AUDIT_ENTITY_LABELS[entity] : 'Record'} #{entityId}
              </Button>
            )}
            <span className="text-xs text-muted">{log.isFetching && !data ? 'Loading…' : `${formatNumber(total)} ${total === 1 ? 'change matches' : 'changes match'}`}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-10 sm:h-8" leftIcon={<FilterX aria-hidden />} onClick={clearFilters}>
              Clear filters
            </Button>
            </>
          )}
        </div>
      </Card>

      {log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : log.isLoading || (rangeInvalid && !data) ? (
        <Card padded={false} className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3"><Skeleton circle className="h-8 w-8" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/3" /></div></div>
          ))}
        </Card>
      ) : total === 0 ? (
        filtered ? (
          <EmptyState icon={<FilterX aria-hidden />} title="No changes match these filters" description="Try another person, a wider date range or fewer words." action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <EmptyState icon={<History aria-hidden />} tone="primary" title="Nothing recorded yet" description="Every change to pay, gauges, people, events and settings is listed here as it happens: who made it, when, and what changed." />
        )
      ) : (
        <div className={log.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={log.isFetching || undefined}>
          {groups.map((g) => (
            // the date itself, never "Today" / "Tomorrow": audit times are the real clock (see dayHeading.ts)
            <section key={g.day} className="mb-4" aria-label={auditDayHeading(g.day)}>
              <h2 className="eyebrow mb-2 px-1">{auditDayHeading(g.day)}</h2>
              <Card padded={false} className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {g.rows.map((r) => <AuditEntryItem key={r.id} entry={r} timeOnly />)}
                </ul>
              </Card>
            </section>
          ))}
          <nav className="mt-2 flex flex-col items-center justify-between gap-3 sm:flex-row" aria-label="Pages">
            <p className="text-sm text-muted tabular">
              Showing {formatNumber(firstShown)}–{formatNumber(lastShown)} of {formatNumber(total)}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" leftIcon={<ChevronLeft aria-hidden />} disabled={page <= 1} onClick={() => update({ page: page - 1 }, true)}>Newer</Button>
              <span className="min-w-16 text-center text-sm text-muted tabular">{page} / {pages}</span>
              <Button variant="outline" rightIcon={<ChevronRight aria-hidden />} disabled={page >= pages} onClick={() => update({ page: page + 1 }, true)}>Older</Button>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
