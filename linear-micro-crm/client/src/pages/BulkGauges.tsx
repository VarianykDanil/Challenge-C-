// Release 1.2 — /gauges/bulk (leader: own team; admin: any) — OWNED BY U2 bulk-entry.
// Choose an event (today's team event by default, or ?eventId=), type or paste the team's gauges, save once. The
// server saves every row or none (POST /gauges/bulk); a refusal comes back per row and is shown on that row. Unsaved
// numbers are kept on this phone per event (a lost signal or a reload never loses a pasted team), see bulkRows.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import type { BulkGaugeRow, BulkRowError, GaugeKey, PasteFill, SalesEventWithMeta } from '@lm/shared';
import { preselectTodayEvent } from '@lm/shared';
import { AlertTriangle, ArrowLeft, ClipboardList, History, MessageSquareText, Save, Users } from 'lucide-react';
import { Button, Card, EmptyState, Field, PageHeader, SegmentedControl, Select, Skeleton, useToast } from '@/components/ui';
import { ApiError, isNetworkError } from '@/api/client';
import { useBulkGauges } from '@/api/bulk';
import { useEvent, useUsers } from '@/api/hooks';
import { useCurrentUser } from '@/auth/AuthProvider';
import { ErrorState, errorMessage } from '@/features/common';
import { BulkGrid, type BulkRowView } from '@/features/bulk/BulkGrid';
import { PastePanel } from '@/features/bulk/PastePanel';
import {
  EMPTY_CELLS,
  baseFrom,
  cellsFrom,
  cellsToTotals,
  cleanCell,
  clearDraft,
  invalidCells,
  loadDraft,
  rowProblems,
  rowStatus,
  saveDraft,
  sumCells,
  toBulkRow,
  type BaseEntry,
  type RowEdit,
} from '@/features/bulk/bulkRows';
import { eventBlockReason } from '@/features/gauges/LogGaugesModal';
import { useLoggableEvents } from '@/features/gauges/loggableEvents';
import { COPY } from '@/content/copy';
import { todayISO } from '@/lib/dates';
import { formatDate, formatDateShort, formatTime, pluralise } from '@/lib/format';
import { idFromParam } from '@/lib/useActionParam';
import { usePageTitle } from '@/lib/usePageTitle';

/** The edits of one event: kept together so a draft is never written under the wrong event. */
interface Sheet {
  eventId: number | null;
  edits: Record<string, RowEdit>;
  /** When the edits came from a draft on this phone, the time it was saved. */
  restoredAt: string | null;
}

function sheetFor(userId: number, eventId: number | null): Sheet {
  const draft = eventId != null ? loadDraft(userId, eventId) : null;
  return { eventId, edits: draft?.edits ?? {}, restoredAt: draft?.savedAt ?? null };
}

/** Re-render every 30 s so "has the event started" and "check-in later than now" follow the clock. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function BulkGaugesPage() {
  usePageTitle(COPY.nav.bulkGauges.title);
  const me = useCurrentUser();
  const toast = useToast();
  const [params] = useSearchParams();
  const today = todayISO();
  const now = useNow();
  const nowHHMM = format(now, 'HH:mm');

  const [sheet, setSheet] = useState<Sheet>(() => sheetFor(me.id, idFromParam(params.get('eventId'))));
  const eventId = sheet.eventId;
  const dirty = useRef(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Phone-friendly: hide the people already logged and unchanged, to chase the rest.
  const [show, setShow] = useState<'all' | 'todo'>('all');

  const chooseEvent = useCallback((id: number | null) => {
    dirty.current = false;
    setSheet(sheetFor(me.id, id));
    setServerErrors({});
    setSaveError(null);
  }, [me.id]);

  // ── the event ──
  const loggable = useLoggableEvents();
  const detail = useEvent(eventId);
  const events = useMemo(() => {
    const list = loggable.events ?? [];
    const linked = detail.data;
    // a deep-linked event older than the picker's three weeks is still offered (own team for a leader)
    if (linked && !list.some((e) => e.id === linked.id) && (me.role === 'admin' || linked.teamId === me.teamId) && linked.status !== 'cancelled') return [linked as SalesEventWithMeta, ...list];
    return list;
  }, [loggable.events, detail.data, me.role, me.teamId]);
  const event = useMemo(() => events.find((e) => e.id === eventId) ?? null, [events, eventId]);
  const autoTried = useRef(eventId != null);
  const [autoEventId, setAutoEventId] = useState<number | null>(null);
  useEffect(() => {
    if (autoTried.current || !loggable.events) return;
    autoTried.current = true;
    const id = preselectTodayEvent(loggable.events, today, me.teamId);
    if (id != null) {
      chooseEvent(id);
      setAutoEventId(id);
    }
  }, [loggable.events, today, me.teamId, chooseEvent]);
  const blocked = eventBlockReason(event, today, nowHHMM);

  // ── the team and what is already logged ──
  const usersQ = useUsers({ teamId: event?.teamId }, { enabled: event != null });
  const members = useMemo(
    () => (event ? (usersQ.data ?? []).filter((u) => u.teamId === event.teamId && u.status === 'active' && u.role !== 'recruiter') : [])
      .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName)),
    [usersQ.data, event],
  );
  const bases = useMemo(() => {
    const map = new Map<number, BaseEntry>();
    if (detail.data && event && detail.data.id === event.id) for (const g of detail.data.entries) if (g.date === event.date) map.set(g.userId, baseFrom(g));
    return map;
  }, [detail.data, event]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const elsewhere = useMemo(
    () => (detail.data && event && detail.data.id === event.id ? detail.data.entries.filter((g) => g.date === event.date && !memberIds.has(g.userId)) : []),
    [detail.data, event, memberIds],
  );

  // ── the rows ──
  const rows: BulkRowView[] = useMemo(() => {
    if (!event) return [];
    return members.map((m) => {
      const base = bases.get(m.id) ?? null;
      const edit = sheet.edits[m.id];
      const status = rowStatus(base, edit);
      const cells = edit?.cells ?? (base ? cellsFrom(base.values) : EMPTY_CELLS);
      const checkIn = edit?.checkIn ?? base?.checkIn ?? '';
      const sending = status === 'new' || status === 'update';
      return {
        member: m,
        isMe: m.id === me.id,
        base,
        status,
        cells,
        checkIn,
        problems: sending && edit ? rowProblems(edit, { date: event.date, today, nowHHMM }) : [],
        serverErrors: serverErrors[m.id] ?? [],
        invalid: sending ? invalidCells(cellsToTotals(cells)) : new Set<GaugeKey>(),
        fromPaste: !!edit?.pasteKey,
        edited: !!edit,
      };
    });
  }, [event, members, bases, sheet.edits, me.id, today, nowHHMM, serverErrors]);
  const totals = useMemo(() => sumCells(rows.map((r) => r.cells)), [rows]);
  const shown = useMemo(() => (show === 'all' ? rows : rows.filter((r) => r.status !== 'logged')), [rows, show]);
  const toSend = rows.filter((r) => r.status === 'new' || r.status === 'update');
  const needFixing = toSend.filter((r) => r.problems.length > 0).length;
  const created = toSend.filter((r) => r.status === 'new').length;
  const updates = toSend.length - created;
  const loggedCount = rows.filter((r) => r.base).length;

  // ── edits ──
  const edit = (userId: number, change: (e: RowEdit) => RowEdit) => {
    dirty.current = true;
    setSheet((s) => {
      const base = bases.get(userId);
      const current = s.edits[userId] ?? { cells: base ? cellsFrom(base.values) : { ...EMPTY_CELLS }, checkIn: base?.checkIn ?? '', pasteKey: null };
      return { ...s, edits: { ...s.edits, [userId]: change(current) } };
    });
    setServerErrors((e) => (e[userId] ? { ...e, [userId]: [] } : e));
    setSaveError(null);
  };
  const onCell = (userId: number, key: GaugeKey, raw: string) => edit(userId, (e) => ({ ...e, cells: { ...e.cells, [key]: cleanCell(raw) }, pasteKey: null }));
  const onCheckIn = (userId: number, value: string) => edit(userId, (e) => ({ ...e, checkIn: value }));
  const onUndo = (userId: number) => {
    dirty.current = true;
    setSheet((s) => {
      const { [userId]: _gone, ...rest } = s.edits;
      return { ...s, edits: rest };
    });
    setServerErrors((e) => ({ ...e, [userId]: [] }));
  };
  const onFill = (fills: PasteFill[]) => {
    dirty.current = true;
    setSheet((s) => {
      const next = { ...s.edits };
      for (const f of fills) {
        if (!memberIds.has(f.userId)) continue;
        const base = bases.get(f.userId);
        const prevCheckIn = next[f.userId]?.checkIn ?? base?.checkIn ?? '';
        next[f.userId] = { cells: cellsFrom(f.values), checkIn: f.checkIn ?? prevCheckIn, pasteKey: f.key };
      }
      return { ...s, edits: next, restoredAt: null };
    });
    setServerErrors({});
    setSaveError(null);
  };
  const discardAll = () => {
    dirty.current = false;
    if (eventId != null) clearDraft(me.id, eventId);
    setSheet((s) => ({ ...s, edits: {}, restoredAt: null }));
    setServerErrors({});
    setSaveError(null);
  };

  // Unsaved numbers stay on this phone, per event, as they are typed.
  useEffect(() => {
    if (!dirty.current || sheet.eventId == null) return;
    saveDraft(me.id, sheet.eventId, sheet.edits);
  }, [sheet, me.id]);

  // ── save ──
  const bulk = useBulkGauges();
  const saving = bulk.isPending || refreshing;
  const canSave = !!event && !blocked && toSend.length > 0 && needFixing === 0 && !saving;
  const save = async () => {
    if (!event || !canSave) return;
    const sent: BulkGaugeRow[] = [];
    for (const r of toSend) {
      const row = toBulkRow(r.member.id, r.base, sheet.edits[r.member.id], event.date);
      if (row) sent.push(row);
    }
    if (!sent.length) return;
    setSaveError(null);
    setServerErrors({});
    try {
      const result = await bulk.mutateAsync({ eventId: event.id, date: event.date, rows: sent });
      // wait for the event's entries so the rows show what was saved, then let the edits go
      setRefreshing(true);
      await detail.refetch().catch(() => undefined);
      setRefreshing(false);
      dirty.current = false;
      clearDraft(me.id, event.id);
      setSheet((s) => (s.eventId === event.id ? { ...s, edits: {}, restoredAt: null } : s));
      setPasteOpen(false); // the paste is used up: a fresh box next time
      const parts = [result.created ? `${result.created} logged` : '', result.updated ? `${result.updated} updated` : ''].filter(Boolean).join(' · ');
      toast.success(`Saved ${pluralise(result.created + result.updated, 'person', 'people')}`, `${parts} · ${event.name}`);
    } catch (e) {
      setRefreshing(false);
      if (isNetworkError(e)) {
        toast.error('No signal — nothing was saved', 'Your numbers are kept on this phone. Save again when you are back online.');
        return;
      }
      const rowsBack = e instanceof ApiError && e.status === 400 ? (e.details as { rows?: BulkRowError[] } | undefined)?.rows : undefined;
      if (Array.isArray(rowsBack)) {
        const byUser: Record<string, string[]> = {};
        for (const r of rowsBack) {
          const userId = sent[r.index]?.userId ?? r.userId;
          if (userId != null) byUser[userId] = [...(byUser[userId] ?? []), ...r.errors];
        }
        setServerErrors(byUser);
        setSaveError(`${e instanceof Error ? e.message : 'Not saved'}. The rows to fix are marked below.`);
      } else {
        setSaveError(errorMessage(e, 'Could not save the gauges'));
      }
    }
  };

  // ── render ──
  const eventPlaceholder = loggable.isLoading ? 'Loading events…' : events.length ? 'Choose an event' : loggable.offline ? 'No signal — no events loaded yet' : 'No events in the last three weeks';
  const eventHint = event
    ? autoEventId === event.id
      ? `Today's event selected · starts ${formatTime(event.startTime)} · ${event.venue}`
      : `${formatDate(event.date)} · starts ${formatTime(event.startTime)} · ${event.venue}`
    : me.role === 'admin'
      ? 'Any team’s event from the last three weeks'
      : 'Your team’s events from the last three weeks';

  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/gauges" className="inline-flex min-h-6 items-center gap-1 hover:underline"><ArrowLeft className="h-3 w-3" aria-hidden /> {COPY.nav.gauges.title}</Link>}
        title={COPY.nav.bulkGauges.title}
        description={COPY.nav.bulkGauges.description}
        actions={
          !pasteOpen && (
            <Button variant="outline" onClick={() => setPasteOpen(true)} disabled={!event} leftIcon={<MessageSquareText className="h-4 w-4" aria-hidden />} data-bulk-open-paste>
              Paste from WhatsApp
            </Button>
          )
        }
      />

      <Card className="mb-4">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Field label="Event" htmlFor="bulk-event" className="min-w-0" hint={eventHint} error={blocked ?? undefined}>
            <Select
              id="bulk-event"
              value={eventId != null && event ? String(eventId) : ''}
              onChange={(e) => {
                chooseEvent(e.target.value ? Number(e.target.value) : null);
                setAutoEventId(null);
              }}
              placeholder={eventPlaceholder}
              options={events.map((e) => ({ value: String(e.id), label: `${formatDateShort(e.date)} · ${e.name} (${e.campaignCode})${me.role === 'admin' ? ` · ${e.teamName}` : ''}` }))}
              invalid={!!blocked}
            />
          </Field>
          {event && members.length > 0 && (
            <dl className="flex gap-6 text-sm md:pb-6" aria-label="This event so far">
              <div>
                <dt className="text-xs text-muted">Logged</dt>
                <dd className="font-semibold tabular-nums text-fg">{loggedCount} of {members.length}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Sales on the sheet</dt>
                <dd className="font-semibold tabular-nums text-fg">{totals.sales}</dd>
              </div>
            </dl>
          )}
        </div>
      </Card>

      {sheet.restoredAt && Object.keys(sheet.edits).length > 0 && (
        <div role="status" className="mb-4 flex flex-col gap-2 rounded-xl border border-info/30 bg-info-soft p-3 text-sm text-fg sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
            Unsaved numbers from {format(new Date(sheet.restoredAt), 'HH:mm')} were kept on this phone and are back on the sheet.
          </span>
          <Button size="sm" variant="outline" onClick={discardAll}>Discard them</Button>
        </div>
      )}

      {pasteOpen && event && (
        <PastePanel className="mb-4" members={members} onFill={onFill} onClose={() => setPasteOpen(false)} disabled={saving} />
      )}

      {!event ? (
        <EmptyState
          icon={<ClipboardList aria-hidden />}
          title={eventId != null && detail.isError ? 'That event could not be opened' : 'Choose an event'}
          description="Pick the event above. Everyone on its team gets a row: type their six numbers or paste them from WhatsApp, then save them all at once."
        />
      ) : usersQ.isError ? (
        <ErrorState error={usersQ.error} onRetry={() => void usersQ.refetch()} title="Could not load the team" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title="Could not load what is already logged" />
      ) : usersQ.isLoading || detail.isLoading ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : members.length === 0 ? (
        <EmptyState icon={<Users aria-hidden />} title="No one on this team yet" description="Add people to the team first; then everyone gets a row here." />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl<'all' | 'todo'>
              aria-label="Show"
              size="md"
              value={show}
              onChange={setShow}
              options={[
                { value: 'all', label: `Everyone (${rows.length})` },
                { value: 'todo', label: `Not saved yet (${rows.filter((r) => r.status !== 'logged').length})` },
              ]}
            />
            <p className="text-xs text-muted">Blank counts as 0<span className="hidden md:inline"> · Enter jumps to the next person</span></p>
          </div>
          {shown.length ? (
            <BulkGrid rows={shown} totals={totals} onCell={onCell} onCheckIn={onCheckIn} onUndo={onUndo} disabled={saving} />
          ) : (
            <EmptyState size="sm" icon={<Users aria-hidden />} title="Everyone is logged" description="Every person on the team has saved gauges for this event. Switch to Everyone to change someone's day." />
          )}
          {elsewhere.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Also logged at this event: {elsewhere.map((g) => g.userName).join(', ')} (not on the team list) — edit them from the event page.
            </p>
          )}
        </>
      )}

      {event && members.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-bg/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" data-bulk-savebar>
          {saveError && (
            <p role="alert" className="mb-2 flex items-start gap-2 text-sm font-medium text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span><span className="font-semibold">Not saved.</span> {saveError}</span>
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted" role="status" aria-live="polite">
              {needFixing > 0 ? (
                <span className="font-medium text-danger">{pluralise(needFixing, 'row')} to fix before saving</span>
              ) : toSend.length ? (
                <>
                  <span className="font-semibold text-fg">{[created ? `${created} new` : '', updates ? `${pluralise(updates, 'update')}` : ''].filter(Boolean).join(' · ')}</span>
                  {' '}ready to save in one go
                </>
              ) : (
                'Nothing new to save yet'
              )}
            </p>
            <div className="flex gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
              {Object.keys(sheet.edits).length > 0 && <Button variant="ghost" onClick={discardAll} disabled={saving}>Discard changes</Button>}
              <Button onClick={() => void save()} disabled={!canSave} loading={saving} leftIcon={<Save className="h-4 w-4" aria-hidden />} data-bulk-save>
                {toSend.length ? `Save ${pluralise(toSend.length, 'person', 'people')}` : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
