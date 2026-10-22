// Release 1.3 — OWNED BY P3 statements. One commission statement (Finance → Statements → a statement):
//  - what is left to do before Apply (blockers) and what is worth a look (warnings), in plain words;
//  - "Pay": per matched person, the subs they logged in the statement's period, what the client confirmed and what was
//    cancelled, with P1's pay effect (the dry run before Apply, what Apply did after);
//  - "Rows": the statement's rows and who each one is; a row nobody matched gets "Pick the person" (or "Not one of ours");
//  - "Details": the campaign and period (fixable while not applied) and where it came from;
//  - "Columns": which column holds what — saved per client so its next statements are read (and applied) by themselves;
//  - the PDF itself (in the page from tablet width; "Open PDF" everywhere).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Columns3, ExternalLink, FileText, Info, ListChecks, Trash2, TriangleAlert, Users } from 'lucide-react';
import {
  STATEMENT_FIELDS,
  STATEMENT_FIELD_LABELS,
  STATEMENT_ROW_MATCH_LABELS,
  resolveStatementColumn,
  type StatementColumnMapping,
  type StatementDetail,
  type StatementField,
  type StatementPersonSummary,
  type StatementRow,
  type UserWithTeam,
} from '@lm/shared';
import { useCampaigns, useUsers } from '@/api/hooks';
import {
  statementFileUrl,
  useApplyStatement,
  useDeleteStatement,
  useMatchStatementRow,
  usePatchStatement,
  useSaveStatementTemplate,
  useStatement,
} from '@/api/statements';
import { Badge, Button, Card, CardHeader, DataTable, Field, Input, PageHeader, SegmentedControl, Select, Skeleton, useToast, type Column } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { ErrorState, apiMessage } from '@/features/common/QueryStates';
import { formatDate, formatDateShort, formatDateTime, formatGBP, fullName, pluralise } from '@/lib/format';
import { CampaignChip, StatementStatusBadge, periodLabel, personEffect, signedGBP, statementWeekLabel } from './statementUi';

interface Props {
  id: number;
  onBack: () => void;
  onOpen: (id: number | null) => void;
}

const weekLabel = statementWeekLabel;

export function StatementDetailView({ id, onBack, onOpen }: Props) {
  const q = useStatement(id);
  const s = q.data;
  const toast = useToast();
  const apply = useApplyStatement();
  const remove = useDeleteStatement();
  const [confirm, setConfirm] = useState<null | 'apply' | 'discard'>(null);

  const back = (
    <Link to="/finance/statements" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10 pointer-coarse:min-h-10" onClick={(e) => { e.preventDefault(); onBack(); }}>
      <ArrowLeft className="h-3 w-3" aria-hidden /> Statements
    </Link>
  );

  if (q.isLoading) {
    return (
      <>
        <PageHeader breadcrumbs={back} title={<Skeleton className="h-7 w-64" />} />
        <Skeleton className="h-40 w-full" />
      </>
    );
  }
  if (q.isError || !s) {
    return (
      <>
        <PageHeader breadcrumbs={back} title="Statement" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not open this statement" />
      </>
    );
  }

  const applied = s.status === 'applied';
  const blockers = s.blockers ?? [];
  // the period names a statement; one without (a PDF that could not be read) goes by its file name
  const named = s.periodStart && s.periodEnd ? periodLabel(s.periodStart, s.periodEnd) : (s.fileName?.replace(/\.pdf$/i, '') ?? 'Period not stated');
  const title = `${s.campaignCode ?? 'Statement'} · ${named}`;
  const people = s.people ?? [];
  const cancelled = people.reduce((n, p) => n + p.cancelled, 0);

  const doApply = () =>
    apply.mutate(id, {
      onSuccess: (d) => {
        setConfirm(null);
        const diff = d.effect?.totalDifference ?? 0;
        toast.success('Statement applied', diff ? `${signedGBP(diff)} in corrections on the next pay runs.` : 'Pay is corrected where it changed.');
      },
      onError: (e) => {
        setConfirm(null);
        toast.error('Could not apply the statement', apiMessage(e, 'Try again.'));
      },
    });
  const doDiscard = () =>
    remove.mutate(id, {
      onSuccess: () => {
        setConfirm(null);
        toast.success('Statement discarded');
        onBack();
      },
      onError: (e) => {
        setConfirm(null);
        toast.error('Could not discard the statement', apiMessage(e, 'Try again.'));
      },
    });

  return (
    <>
      <PageHeader
        breadcrumbs={back}
        title={title}
        description={
          <>
            {s.source === 'email' ? `Emailed by ${s.sender ?? 'the client'}` : 'Uploaded'} on {formatDateTime(s.receivedAt)}
            {s.subject ? ` · “${s.subject}”` : ''}
          </>
        }
        actions={
          <>
            <a
              href={statementFileUrl(id)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card hover:bg-surface-2"
            >
              <ExternalLink className="h-4 w-4" aria-hidden /> Open PDF
            </a>
            {!applied && (
              <Button variant="outline" leftIcon={<Trash2 aria-hidden />} onClick={() => setConfirm('discard')}>
                Discard
              </Button>
            )}
            {!applied && s.status !== 'failed' && (
              <Button leftIcon={<Check aria-hidden />} disabled={blockers.length > 0} onClick={() => setConfirm('apply')} data-testid="apply-statement">
                Apply
              </Button>
            )}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <StatementStatusBadge status={s.status} />
        <CampaignChip code={s.campaignCode} color={s.campaignColor} />
        {s.status !== 'failed' && <span className="text-muted">{s.matchedCount} of {pluralise(s.rowCount, 'row')} matched</span>}
        {applied && (
          <span className="text-muted">
            · Applied {formatDateTime(s.appliedAt)} by {s.appliedByName ?? 'Linear Hub (automatically)'}
          </span>
        )}
        {applied && s.replaces && (
          <span className="text-muted">
            · It replaced{' '}
            <StatementLinkButton onClick={() => onOpen(s.replaces!.id)}>the statement received {formatDateShort(s.replaces.receivedAt)}</StatementLinkButton>
          </span>
        )}
      </div>

      {s.replacedBy && (
        <Card tone="info" className="mb-4" data-testid="statement-replaced">
          <p className="text-sm text-fg">
            <Info className="mr-1.5 inline-block h-4 w-4 align-[-3px] text-info" aria-hidden />
            Replaced by{' '}
            <StatementLinkButton onClick={() => onOpen(s.replacedBy!.id)}>the statement received {formatDateShort(s.replacedBy.receivedAt)}</StatementLinkButton>
            {s.replacedBy.appliedAt ? `, applied ${formatDateTime(s.replacedBy.appliedAt)}` : ''}. Pay follows that one; this page shows what this one did.
          </p>
        </Card>
      )}

      {s.status === 'failed' ? (
        <Card tone="danger" className="mb-5" data-testid="statement-error">
          <CardHeader icon={<TriangleAlert />} title="Linear Hub could not read this PDF" description={s.error ?? undefined} />
          <p className="text-sm text-muted">
            Open the PDF to see what it is. If it is a statement, ask the client for the original PDF (not a scan) and upload it. If it is not (a
            remittance advice, a letter), discard it.
          </p>
        </Card>
      ) : (
        <>
          {!applied && blockers.length > 0 && (
            <Card tone="warning" className="mb-4" data-testid="statement-blockers">
              <CardHeader icon={<ListChecks />} title="Before you can apply it" />
              <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </Card>
          )}
          {(s.warnings ?? []).length > 0 && (
            <Card tone="info" className="mb-4" data-testid="statement-warnings">
              <ul className="space-y-1.5 text-sm text-fg">
                {s.warnings!.map((w) => (
                  <li key={w} className="flex gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {/* three columns only from 1400 px: below that the side column is too narrow for dates and buttons, and the Pay
          table (about 680 px) would scroll sideways in the main one */}
      <div className="grid grid-cols-1 gap-6 min-[1400px]:grid-cols-3">
        <div className="min-w-0 space-y-6 min-[1400px]:col-span-2">
          {s.status !== 'failed' && <PayCard s={s} />}
          {s.status !== 'failed' && <RowsCard s={s} />}
        </div>
        <div className="min-w-0 space-y-6">
          <DetailsCard s={s} />
          {s.table && !applied && <ColumnsCard s={s} />}
        </div>
      </div>

      <PdfCard id={id} title={title} fileName={s.fileName} />

      <ConfirmDialog
        open={confirm === 'apply'}
        onClose={() => setConfirm(null)}
        onConfirm={doApply}
        loading={apply.isPending}
        title="Apply this statement?"
        confirmLabel="Apply"
        description={`Pay is corrected from what ${s.campaignCode ?? 'the client'} confirmed: ${pluralise(people.length, 'person', 'people')}, ${pluralise(cancelled, 'cancelled sub')}.`}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Weeks not paid yet are recalculated with the confirmed subs.</li>
          <li>For a week already paid, the difference goes on that person’s next unpaid pay run, with a line saying why. Paid runs never change.</li>
          {s.replaces && (
            <li>
              This replaces the {s.campaignCode ?? ''} statement for {periodLabel(s.replaces.periodStart, s.replaces.periodEnd)} applied on {formatDateShort(s.replaces.appliedAt)}: pay is corrected to these
              figures instead, and a correction already waiting on an unpaid week is changed, not added to.
            </li>
          )}
          {(s.dropped ?? []).length > 0 && <li>{s.dropped!.map((d) => d.userName).join(', ')}: on the statement it replaces but not on this one, so back to the subs they logged.</li>}
          {s.table?.mappingSource === 'detected' && s.campaignCode && <li>Applying also saves these columns for {s.campaignCode}, so its next statements apply themselves.</li>}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'discard'}
        onClose={() => setConfirm(null)}
        onConfirm={doDiscard}
        loading={remove.isPending}
        tone="danger"
        title="Discard this statement?"
        confirmLabel="Discard"
        description="It is removed from Linear Hub with its rows; nobody’s pay changes. The email stays in Gmail."
      />
    </>
  );
}

/** A link-styled button that opens another statement on this page. */
function StatementLinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="focus-ring inline-flex items-center rounded font-medium text-primary underline-offset-4 hover:underline max-sm:min-h-10 pointer-coarse:min-h-10">
      {children}
    </button>
  );
}

/* ───────────────────────────── the PDF ───────────────────────────── */

/** The PDF in the page (tablet and wider), loaded only when asked for: a statement can be megabytes on a hotspot. */
function PdfCard({ id, title, fileName }: { id: number; title: string; fileName: string | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(false), [id]);
  return (
    <Card className="mt-6" data-testid="statement-pdf">
      <CardHeader
        icon={<FileText />}
        title="The PDF"
        description={fileName ?? undefined}
        actions={
          <span className="hidden md:block">
            <Button variant="outline" size="sm" className="pointer-coarse:h-10" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
              {shown ? 'Hide it' : 'Show it here'}
            </Button>
          </span>
        }
      />
      {shown && <iframe src={statementFileUrl(id)} title={`The statement PDF: ${title}`} className="hidden h-[75vh] w-full rounded-lg border border-border bg-surface-2 md:block" />}
      <p className={shown ? 'text-sm text-muted md:hidden' : 'text-sm text-muted'}>
        <span className="md:hidden">Phones show PDFs best on their own: </span>
        <span className="hidden md:inline">Show it here, or </span>
        <a href={statementFileUrl(id)} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-10 max-sm:items-center pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center">
          open the PDF
        </a>
        <span className="hidden md:inline"> in a tab of its own</span>.
      </p>
    </Card>
  );
}

/* ───────────────────────────── pay ───────────────────────────── */

function PayCard({ s }: { s: StatementDetail }) {
  const people = s.people ?? [];
  const effect = s.effect;
  const totals = people.reduce((t, p) => ({ logged: t.logged + p.logged, confirmed: t.confirmed + p.confirmed, cancelled: t.cancelled + p.cancelled }), { logged: 0, confirmed: 0, cancelled: 0 });
  const columns: Column<StatementPersonSummary>[] = [
    {
      key: 'person',
      header: 'Person',
      render: (p) => {
        // over several pay weeks, say which weeks the cancellations (or extra subs) fall in
        const notes = p.weeks.length > 1 ? p.weeks.filter((w) => w.confirmed !== w.logged) : [];
        return (
          <span className="block min-w-[7.5rem]">
            <span className="block font-medium text-fg">{p.userName}</span>
            {notes.map((w) => (
              <span key={w.weekStart} className="block text-xs text-muted">
                {weekLabel(w.weekStart)}: {w.confirmed < w.logged ? `${w.logged - w.confirmed} cancelled` : `${w.confirmed - w.logged} more confirmed`}
              </span>
            ))}
          </span>
        );
      },
      sortValue: (p) => p.userName,
    },
    { key: 'logged', header: 'Logged', align: 'right', render: (p) => <span className="tabular">{p.logged}</span>, sortValue: (p) => p.logged },
    { key: 'confirmed', header: 'Confirmed', align: 'right', render: (p) => <span className="tabular">{p.confirmed}</span>, sortValue: (p) => p.confirmed },
    {
      key: 'cancelled',
      header: 'Cancelled',
      align: 'right',
      render: (p) => <span className={p.cancelled ? 'tabular font-semibold text-warning' : 'tabular text-muted'}>{p.cancelled}</span>,
      sortValue: (p) => p.cancelled,
    },
    {
      key: 'effect',
      header: 'Pay effect',
      render: (p) => {
        const e = personEffect(effect?.people, p.userId);
        if (!effect || !effect.people.length) return <span className="text-muted">—</span>;
        if (!e) return <span className="text-muted">No change</span>;
        return (
          <span className="block min-w-[11rem]">
            <span className={e.difference < 0 ? 'tabular font-semibold text-danger' : e.difference > 0 ? 'tabular font-semibold text-success' : 'tabular text-muted'}>{signedGBP(e.difference)}</span>
            {e.sentences.map((t) => <span key={t} className="block text-xs text-muted">{t}</span>)}
          </span>
        );
      },
      sortValue: (p) => personEffect(effect?.people, p.userId)?.difference ?? 0,
    },
  ];
  // the DataTable puts `footer` in its <tfoot>: one row, one cell across the columns
  const footer = people.length ? (
    <tr>
      <td colSpan={columns.length}>
        <span className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-normal text-muted">
            <span className="whitespace-nowrap">{totals.logged} logged</span> · <span className="whitespace-nowrap">{totals.confirmed} confirmed</span> ·{' '}
            <span className={totals.cancelled ? 'whitespace-nowrap font-semibold text-warning' : 'whitespace-nowrap'}>{totals.cancelled} cancelled</span>
          </span>
          {effect && (
            <span className="text-fg">
              {s.status === 'applied' ? 'Applied' : 'If applied'}: {effect.people.length ? signedGBP(effect.totalDifference) : 'no pay change worked out'}
            </span>
          )}
        </span>
      </td>
    </tr>
  ) : null;
  return (
    <Card padded={false} data-testid="statement-pay">
      <div className="p-5 pb-3">
        <CardHeader
          className="mb-0"
          icon={<Users />}
          title="Pay"
          description={
            s.status === 'applied'
              ? 'What applying this statement did to each person’s pay.'
              : effect
                ? s.replaces
                  ? 'What applying it would change from now, after the statement it replaces. Nothing changes until you press Apply.'
                  : 'What applying it would do. Nothing changes until you press Apply.'
                : 'The pay effect shows here once nothing is left to fix above.'
          }
        />
      </div>
      <DataTable bare caption="Logged and confirmed subs per person" columns={columns} rows={people} rowKey={(p) => p.userId} footer={footer} emptyMessage="Nobody on this statement is matched to a person yet." />
      {(s.dropped ?? []).length > 0 && (
        <div className="border-t border-border px-5 py-3 text-sm" data-testid="dropped">
          <span className="font-medium text-fg">On the statement it replaces, not on this one: </span>
          <span className="text-muted">
            {s.dropped!.map((d) => `${d.userName} (${d.confirmedBefore} confirmed then, ${d.logged} logged)`).join(', ')}.{' '}
            {s.status === 'applied' ? 'Their weeks went back to the subs they logged.' : 'Their weeks go back to the subs they logged.'}
          </span>
          {s.dropped!.map((d) => {
            const e = personEffect(effect?.people, d.userId);
            return e && e.sentences.length ? (
              <span key={d.userId} className="mt-1 block text-xs text-muted">
                {d.userName}: {signedGBP(e.difference)}. {e.sentences.join(' ')}
              </span>
            ) : null;
          })}
        </div>
      )}
      {(s.notListed ?? []).length > 0 && (
        <div className="border-t border-border px-5 py-3 text-sm" data-testid="not-listed">
          <span className="font-medium text-fg">Logged sales but not on this statement: </span>
          <span className="text-muted">{s.notListed!.map((n) => `${n.userName} (${n.logged})`).join(', ')}. Their pay does not change.</span>
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────────── rows ───────────────────────────── */

const NOT_OURS = 'none';

function personOptions(users: UserWithTeam[] | undefined) {
  const staff = (users ?? []).filter((u) => u.role !== 'client');
  const active = staff.filter((u) => u.status !== 'left').sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const left = staff.filter((u) => u.status === 'left').sort((a, b) => fullName(a).localeCompare(fullName(b)));
  return {
    options: [{ value: '', label: 'Pick the person…' }, ...active.map((u) => ({ value: String(u.id), label: fullName(u) })), { value: NOT_OURS, label: 'Not one of ours' }],
    groups: left.length ? [{ label: 'No longer here', options: left.map((u) => ({ value: String(u.id), label: fullName(u) })) }] : undefined,
  };
}

function RowsCard({ s }: { s: StatementDetail }) {
  const applied = s.status === 'applied';
  const unmatched = s.rows.filter((r) => r.match === 'none').length;
  const [view, setView] = useState<'check' | 'all'>(unmatched ? 'check' : 'all');
  useEffect(() => {
    if (!unmatched) setView('all');
  }, [unmatched]);
  const [editing, setEditing] = useState<number | null>(null);
  const users = useUsers({ status: 'all' }, { enabled: !applied, staleTime: 5 * 60_000 });
  const picker = useMemo(() => personOptions(users.data), [users.data]);
  const match = useMatchStatementRow();
  const toast = useToast();
  const perSub = s.table?.layout === 'per-sub';
  const rows = view === 'check' ? s.rows.filter((r) => r.match === 'none') : s.rows;

  const pick = (row: StatementRow, value: string) => {
    if (!value) return;
    const userId = value === NOT_OURS ? null : Number(value);
    match.mutate(
      { statementId: s.id, rowId: row.id, userId },
      {
        onSuccess: (r) => {
          setEditing(null);
          const who = r.userId ? `Matched to ${r.userName ?? 'them'}` : 'Marked as not one of ours';
          const parts = [
            r.alsoMatched ? `${pluralise(r.alsoMatched, 'more row')} written “${row.name ?? row.fundraiserRef ?? 'the same way'}” too.` : '',
            r.rememberedRef ? `${r.rememberedRef} is saved as their ${s.campaignCode ?? 'client'} ID, so it matches by itself next time.` : '',
          ].filter(Boolean);
          toast.success(who, parts.join(' ') || undefined);
        },
        onError: (e) => toast.error('Could not save the match', apiMessage(e, 'Try again.')),
      },
    );
  };

  const columns: Column<StatementRow>[] = [
    {
      key: 'who',
      header: 'On the statement',
      render: (r) => (
        <span className="block min-w-[8rem]">
          <span className="block text-fg">{r.name ?? '—'}</span>
          {r.fundraiserRef && <span className="block text-xs text-muted">{r.fundraiserRef}</span>}
        </span>
      ),
      sortValue: (r) => r.name ?? r.fundraiserRef ?? '',
    },
    ...(perSub
      ? [{ key: 'date', header: 'Signed up', render: (r: StatementRow) => <span className="whitespace-nowrap">{formatDate(r.saleDate)}</span>, sortValue: (r: StatementRow) => r.saleDate ?? '' } satisfies Column<StatementRow>]
      : []),
    {
      key: 'confirmed',
      header: perSub ? 'Counts as' : 'Confirmed',
      align: 'right',
      render: (r) =>
        perSub ? (
          r.cancelled ? <Badge tone="warning" size="sm">Cancelled</Badge> : <span className="text-muted">Paid</span>
        ) : (
          <span className="tabular">{r.confirmed}</span>
        ),
      sortValue: (r) => r.confirmed,
    },
    ...(!perSub
      ? [{ key: 'cancelled', header: 'Cancelled', align: 'right', render: (r: StatementRow) => <span className="tabular">{r.cancelled ?? '—'}</span>, sortValue: (r: StatementRow) => r.cancelled ?? 0 } satisfies Column<StatementRow>]
      : []),
    ...(s.rows.some((r) => r.amount !== null)
      ? [{ key: 'amount', header: 'Amount', align: 'right', hideBelow: 'md', render: (r: StatementRow) => <span className="tabular">{r.amount === null ? '—' : formatGBP(r.amount, { cents: true })}</span>, sortValue: (r: StatementRow) => r.amount ?? 0 } satisfies Column<StatementRow>]
      : []),
    {
      key: 'person',
      header: 'Person',
      render: (r) => {
        const showPicker = !applied && (r.match === 'none' || editing === r.id);
        if (showPicker) {
          return (
            <span className="block min-w-[11rem]" data-stop-row>
              <Select
                size="sm"
                aria-label={`Who is ${r.name ?? r.fundraiserRef ?? 'this row'}?`}
                value={r.userId ? String(r.userId) : r.match === 'manual' ? NOT_OURS : ''}
                options={picker.options}
                groups={picker.groups}
                disabled={match.isPending || users.isLoading}
                onChange={(e) => pick(r, e.target.value)}
                className="max-sm:h-10 pointer-coarse:h-10"
              />
            </span>
          );
        }
        return (
          <span className="flex min-w-[9rem] flex-wrap items-center gap-2">
            <span className={r.userId ? 'text-fg' : 'italic text-muted'}>{r.userId ? r.userName : 'Not one of ours'}</span>
            <Badge tone={r.match === 'auto' ? 'success' : 'neutral'} size="sm">{STATEMENT_ROW_MATCH_LABELS[r.match]}</Badge>
            {!applied && (
              <Button variant="link" size="xs" className="pointer-coarse:min-h-10" onClick={() => setEditing(r.id)}>
                Change
              </Button>
            )}
          </span>
        );
      },
      sortValue: (r) => r.userName ?? '',
    },
  ];

  return (
    <Card padded={false} data-testid="statement-rows">
      <div className="flex flex-col gap-3 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader className="mb-0" icon={<ListChecks />} title="Rows" description={perSub ? 'One row per sign-up, as the client listed them.' : 'One row per fundraiser, as the client listed them.'} />
        {unmatched > 0 && (
          <SegmentedControl<'check' | 'all'>
            className="max-sm:h-11 pointer-coarse:h-11"
            aria-label="Rows to show"
            value={view}
            onChange={setView}
            options={[{ value: 'check', label: `To check (${unmatched})` }, { value: 'all', label: `All rows (${s.rows.length})` }]}
          />
        )}
      </div>
      <DataTable bare dense caption="The statement's rows" columns={columns} rows={rows} rowKey={(r) => r.id} maxHeight={560} emptyMessage="No rows." />
    </Card>
  );
}

/* ───────────────────────────── details ───────────────────────────── */

function DetailsCard({ s }: { s: StatementDetail }) {
  const applied = s.status === 'applied';
  const campaigns = useCampaigns();
  const patch = usePatchStatement();
  const toast = useToast();
  const [campaignId, setCampaignId] = useState(s.campaignId ? String(s.campaignId) : '');
  const [start, setStart] = useState(s.periodStart ?? '');
  const [end, setEnd] = useState(s.periodEnd ?? '');
  useEffect(() => {
    setCampaignId(s.campaignId ? String(s.campaignId) : '');
    setStart(s.periodStart ?? '');
    setEnd(s.periodEnd ?? '');
  }, [s.campaignId, s.periodStart, s.periodEnd]);
  const changed = campaignId !== (s.campaignId ? String(s.campaignId) : '') || start !== (s.periodStart ?? '') || end !== (s.periodEnd ?? '');
  const save = () =>
    patch.mutate(
      { id: s.id, campaignId: campaignId ? Number(campaignId) : null, periodStart: start || null, periodEnd: end || null },
      { onSuccess: () => toast.success('Saved'), onError: (e) => toast.error('Could not save', apiMessage(e, 'Check the dates.')) },
    );
  const rows: [string, string][] = [
    ['Received', formatDateTime(s.receivedAt)],
    ['From', s.source === 'email' ? (s.sender ?? 'Email') : 'Uploaded here'],
    ['File', s.fileName ?? '—'],
  ];
  return (
    <Card data-testid="statement-details">
      <CardHeader icon={<Info />} title="Details" />
      {!applied && s.status !== 'failed' ? (
        <div className="space-y-3">
          <Field label="Campaign">
            <Select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              placeholder="Pick the campaign…"
              options={(campaigns.data ?? []).map((c) => ({ value: String(c.id), label: `${c.name} (${c.code})` }))}
            />
          </Field>
          {/* side by side, except in the narrow side column of a 1400 px+ screen */}
          <div className="grid grid-cols-2 gap-3 min-[1400px]:grid-cols-1">
            <Field label="Period from">
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="to">
              <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Button variant="outline" fullWidth disabled={!changed} loading={patch.isPending} onClick={save}>
            Save campaign and period
          </Button>
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-muted">Campaign</dt><dd className="text-right text-fg">{s.campaignName ?? '—'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Period</dt><dd className="text-right text-fg">{periodLabel(s.periodStart, s.periodEnd)}</dd></div>
        </dl>
      )}
      <dl className="mt-4 space-y-2 border-t border-border pt-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-right text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/* ───────────────────────────── columns ───────────────────────────── */

const NOT_ON_IT = '__none__';

function ColumnsCard({ s }: { s: StatementDetail }) {
  const table = s.table!;
  const save = useSaveStatementTemplate();
  const toast = useToast();
  const initial = useMemo(() => {
    const out: Partial<Record<StatementField, string>> = {};
    for (const f of STATEMENT_FIELDS) {
      const i = resolveStatementColumn(table.headers, table.mapping[f]);
      out[f] = i === null ? NOT_ON_IT : String(i);
    }
    return out;
  }, [table]);
  const [picked, setPicked] = useState(initial);
  useEffect(() => setPicked(initial), [initial]);
  const changed = STATEMENT_FIELDS.some((f) => picked[f] !== initial[f]);
  const options = [{ value: NOT_ON_IT, label: 'Not on this statement' }, ...table.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))];
  const onSave = () => {
    if (!s.campaignId) return;
    const mapping: StatementColumnMapping = {};
    for (const f of STATEMENT_FIELDS) {
      const v = picked[f];
      if (v && v !== NOT_ON_IT) mapping[f] = table.headers[Number(v)] || Number(v);
    }
    save.mutate(
      { campaignId: s.campaignId, mapping },
      {
        onSuccess: () => toast.success(`Columns saved for ${s.campaignCode}`, 'Its statements are read with them from now on.'),
        onError: (e) => toast.error('Could not save the columns', apiMessage(e, 'Choose the name (or ID) column and the subs column.')),
      },
    );
  };
  const shownFields = STATEMENT_FIELDS.filter((f) => (table.layout === 'per-sub' ? !['gross', 'confirmed', 'cancelled'].includes(f) || picked[f] !== NOT_ON_IT : !['date', 'status'].includes(f) || picked[f] !== NOT_ON_IT));
  return (
    <Card data-testid="statement-columns">
      <CardHeader
        icon={<Columns3 />}
        title="Columns"
        description={
          table.mappingSource === 'template'
            ? `Read with ${s.campaignCode}'s saved columns.`
            : 'Linear Hub read these from the headings. Check them once: applying saves them for this client.'
        }
      />
      <div className="space-y-2.5">
        {shownFields.map((f) => (
          <Field key={f} label={STATEMENT_FIELD_LABELS[f]} className="!text-xs">
            <Select size="sm" value={picked[f] ?? NOT_ON_IT} options={options} onChange={(e) => setPicked((p) => ({ ...p, [f]: e.target.value }))} className="max-sm:h-10 pointer-coarse:h-10" />
          </Field>
        ))}
      </div>
      <Button className="mt-4" variant="outline" fullWidth disabled={!changed || !s.campaignId} loading={save.isPending} onClick={onSave}>
        {s.campaignCode ? `Save columns for ${s.campaignCode}` : 'Pick the campaign first'}
      </Button>
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer py-3 text-muted">The first rows as written</summary>
        <div className="mt-2 max-w-full overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>{table.headers.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-border px-2 py-1 font-medium text-fg">{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 3).map((r, i) => (
                <tr key={i}>{table.headers.map((_, j) => <td key={j} className="whitespace-nowrap px-2 py-1 text-muted">{r[j] ?? ''}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
