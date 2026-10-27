// Release 1.3 — /finance/statements (admin) — OWNED BY P3 statements.
// The clients' commission statements: every PDF that came by email (Settings → Integrations) or was uploaded here, with
// its campaign, period, how many rows matched a person and its status. ?statement=<id> opens one (the top box and the
// bell link there): its rows, logged vs confirmed per person, the pay effect, and Apply.
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileSpreadsheet, Mail, RefreshCw, Settings as SettingsIcon, Upload } from 'lucide-react';
import { STATEMENT_MAX_BYTES, STATEMENT_STATUS_LABELS, type StatementStatus, type StatementSummary } from '@lm/shared';
import { ApiError } from '@/api/client';
import { useCheckStatementsNow, useMailSettings, useStatements, useUploadStatement } from '@/api/statements';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, SegmentedControl, useToast, type Column } from '@/components/ui';
import { COPY } from '@/content/copy';
import { ErrorState, apiMessage } from '@/features/common';
import { StatementDetailView } from '@/features/statements/StatementDetailView';
import { CampaignChip, StatementStatusBadge, periodLabel } from '@/features/statements/statementUi';
import { formatDateTime, formatRelative, pluralise } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

type Filter = 'all' | StatementStatus;
const FILTERS: Filter[] = ['all', 'needs_review', 'parsed', 'applied', 'failed'];

function positiveInt(v: string | null): number | null {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
}

export function StatementsPage() {
  usePageTitle(COPY.nav.statements.title);
  const [params, setParams] = useSearchParams();
  const selected = positiveInt(params.get('statement'));
  const open = (id: number | null) => setParams(id ? { statement: String(id) } : {});
  return selected ? <StatementDetailView id={selected} onBack={() => open(null)} onOpen={open} /> : <StatementsList onOpen={open} />;
}

const backToFinance = (
  <Link to="/finance" className="inline-flex items-center gap-1 hover:underline max-sm:min-h-10 pointer-coarse:min-h-10">
    <ArrowLeft className="h-3 w-3" aria-hidden /> Finance
  </Link>
);

function StatementsList({ onOpen }: { onOpen: (id: number) => void }) {
  const list = useStatements();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = list.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, parsed: 0, needs_review: 0, applied: 0, failed: 0 };
    for (const s of rows) c[s.status]++;
    return c;
  }, [rows]);
  const shown = filter === 'all' ? rows : rows.filter((s) => s.status === filter);

  const columns: Column<StatementSummary>[] = [
    {
      key: 'campaign',
      header: 'Campaign',
      render: (s) => (
        <span className="flex flex-col items-start gap-1.5">
          <CampaignChip code={s.campaignCode} color={s.campaignColor} />
          {/* on phones the status sits here (its own column would be off-screen) */}
          <span className="md:hidden">
            <ListStatus s={s} />
          </span>
        </span>
      ),
      sortValue: (s) => s.campaignCode ?? '',
    },
    {
      key: 'period',
      header: 'Period',
      render: (s) => (
        <span className="block min-w-[9rem]">
          <span className="block font-medium text-fg">{periodLabel(s.periodStart, s.periodEnd)}</span>
          <span className="block truncate text-xs text-muted">{s.fileName ?? 'No file name'}</span>
        </span>
      ),
      sortValue: (s) => s.periodStart ?? '',
    },
    {
      key: 'received',
      header: 'Received',
      render: (s) => (
        <span className="block whitespace-nowrap">
          <span className="block text-fg">{formatDateTime(s.receivedAt)}</span>
          <span className="block text-xs text-muted">{s.source === 'email' ? 'By email' : 'Uploaded'}</span>
        </span>
      ),
      sortValue: (s) => s.receivedAt,
      hideBelow: 'md',
    },
    {
      key: 'rows',
      header: 'Matched',
      align: 'right',
      render: (s) =>
        s.status === 'failed' ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="tabular whitespace-nowrap">
            {s.matchedCount} of {s.rowCount}
            {s.unmatchedCount ? <span className="block text-xs text-warning">{s.unmatchedCount} to pick</span> : null}
          </span>
        ),
      sortValue: (s) => s.unmatchedCount ?? 0,
    },
    // on a phone the campaign cell already shows the status (md:hidden), so the card leaves this column out
    { key: 'status', header: 'Status', card: 'hidden', render: (s) => <ListStatus s={s} />, sortValue: (s) => s.status, hideBelow: 'md' },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={backToFinance}
        title={COPY.nav.statements.title}
        description={COPY.nav.statements.description}
        actions={
          <>
            <CheckNowButton />
            <UploadButton onUploaded={onOpen} />
          </>
        }
      />
      <MailStrip />
      <div className="mb-4 max-w-full overflow-x-auto">
        <SegmentedControl<Filter>
          aria-label="Show statements"
          className="max-sm:h-11 pointer-coarse:h-11"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f, label: `${f === 'all' ? 'All' : STATEMENT_STATUS_LABELS[f]} (${counts[f]})` }))}
        />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Could not load the statements" />
      ) : (
        <Card padded={false}>
          <DataTable
            bare
            caption="Commission statements"
            columns={columns}
            rows={shown}
            rowKey={(s) => s.id}
            onRowClick={(s) => onOpen(s.id)}
            loading={list.isLoading}
            initialSort={{ key: 'received', dir: 'desc' }}
            empty={
              <EmptyState
                icon={<FileSpreadsheet aria-hidden />}
                title={filter === 'all' ? 'No statements yet' : `Nothing “${STATEMENT_STATUS_LABELS[filter as StatementStatus]}”`}
                description={
                  filter === 'all'
                    ? 'Statements the clients email you appear here once Gmail is connected in Settings → Integrations. You can also upload a PDF.'
                    : 'Try another filter.'
                }
              />
            }
          />
        </Card>
      )}
    </>
  );
}

/** The status, and "Replaced" for an applied statement a later one for the same period replaced. */
function ListStatus({ s }: { s: StatementSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatementStatusBadge status={s.status} />
      {s.supersededBy ? (
        <Badge tone="neutral" size="sm" title="A later statement for the same period replaced this one">
          Replaced
        </Badge>
      ) : null}
    </span>
  );
}

/** Gmail's state in one line: checked every 15 minutes, the last check, or what to fix. */
function MailStrip() {
  const mail = useMailSettings();
  const m = mail.data;
  if (!m) return null;
  const configured = Boolean(m.address && m.hasPassword);
  return (
    <Card flat tone={m.lastError && m.enabled ? 'danger' : 'default'} className="mb-4 flex flex-col gap-2 !p-3 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid="mail-strip">
      <span className="flex min-w-0 items-start gap-2">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0">
          {!configured ? (
            <span className="text-muted">Gmail is not connected yet, so statements only arrive by upload.</span>
          ) : m.enabled ? (
            <span className="text-fg">
              Gmail ({m.address}) is checked every {m.checkEveryMinutes ?? 15} minutes
              {m.lastCheckAt ? <span className="text-muted"> · last checked {formatRelative(m.lastCheckAt)}</span> : null}
            </span>
          ) : (
            <span className="text-muted">The automatic Gmail check is off. Check Gmail now checks once.</span>
          )}
          {m.lastError && <span className="mt-0.5 block font-medium text-danger">{m.lastError}</span>}
        </span>
      </span>
      <Link to="/settings#integrations" className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline max-sm:min-h-10 pointer-coarse:min-h-10">
        <SettingsIcon className="h-3.5 w-3.5" aria-hidden /> Settings → Integrations
      </Link>
    </Card>
  );
}

function CheckNowButton() {
  const mail = useMailSettings();
  const check = useCheckStatementsNow();
  const toast = useToast();
  if (!mail.data?.address || !mail.data.hasPassword) return null;
  return (
    <Button
      variant="outline"
      leftIcon={<RefreshCw aria-hidden />}
      loading={check.isPending}
      onClick={() =>
        check.mutate(undefined, {
          onSuccess: (r) => {
            if (r.errors.length && !r.fetched) toast.error('Could not check Gmail', r.errors[0]);
            else if (!r.fetched) toast.info('Nothing new in Gmail', r.errors[0]);
            else toast.success(`${pluralise(r.fetched, 'new statement')}`, r.applied ? `${r.applied} applied automatically.` : 'Open each one to check it, then Apply.');
          },
          onError: (e) => toast.error('Could not check Gmail', apiMessage(e, 'Try again in a minute.')),
        })
      }
    >
      Check Gmail now
    </Button>
  );
}

function UploadButton({ onUploaded }: { onUploaded: (id: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const uploadStatement = useUploadStatement();
  const toast = useToast();
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > STATEMENT_MAX_BYTES) {
      toast.error('That PDF is over 20 MB', 'Ask the client for a smaller copy.');
      return;
    }
    uploadStatement.mutate(
      { file, fileName: file.name },
      {
        onSuccess: (s) => {
          if (s.status === 'failed') toast.warning('Uploaded, but it could not be read', s.error ?? undefined);
          else toast.success('Statement uploaded', `${s.campaignCode ?? 'No campaign yet'} · ${periodLabel(s.periodStart, s.periodEnd)}: ${s.matchedCount} of ${pluralise(s.rowCount, 'row')} matched.`);
          onUploaded(s.id);
        },
        onError: (err) => {
          const existing = err instanceof ApiError && err.status === 409 ? (err.details as { statementId?: number } | undefined)?.statementId : undefined;
          if (existing) toast.toast({ tone: 'info', title: 'Already uploaded', description: apiMessage(err, 'This PDF is already here.'), action: { label: 'Open it', onClick: () => onUploaded(existing) } });
          else toast.error('Could not upload the statement', apiMessage(err, 'Try again.'));
        },
      },
    );
  };
  return (
    <>
      <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" tabIndex={-1} aria-hidden onChange={onPick} data-testid="statement-file" />
      <Button leftIcon={<Upload aria-hidden />} loading={uploadStatement.isPending} onClick={() => input.current?.click()}>
        Upload statement
      </Button>
    </>
  );
}
