// Release 1.3 — /client: the client portal's Updates page — OWNED BY P6 client-portal. Phone first: the client's campaign,
// a quick "Post an update" form (Update / Announcement / Commission change) and their campaign's history with each
// post's status ("Published", "Waiting for Linear", "Approved from Mon 2 Nov", "Declined: reason", "Unpublished").
// Nothing else: no finance, nothing about the office.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { BadgePoundSterling, CheckCircle2, Megaphone, Newspaper, PoundSterling, Send } from 'lucide-react';
import {
  CLIENT_POST_BODY_MAX,
  CLIENT_POST_KIND_HINTS,
  CLIENT_POST_KIND_LABELS,
  CLIENT_POST_TITLE_MAX,
  clientCommissionSummary,
  clientPostDayLabel,
  clientPostProblems,
  clientPostStatusText,
  type ClientPost,
  type ClientPostField,
  type ClientPostKind,
} from '@lm/shared';
import { ApiError } from '@/api/client';
import { useClientPortal, useCreateClientPost } from '@/api/clientPortal';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Skeleton, Textarea, useToast } from '@/components/ui';
import { CLIENT_POST_STATUS_TONE } from '@/features/client/postTone';
import { ErrorState } from '@/features/common';
import { apiMessage } from '@/features/common/QueryStates';
import { COPY } from '@/content/copy';
import { todayISO } from '@/lib/dates';
import { formatRelative } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';

const KIND_OPTIONS: { value: ClientPostKind; label: string; icon: typeof Megaphone }[] = [
  { value: 'update', label: 'Update', icon: Newspaper },
  { value: 'announcement', label: 'Announcement', icon: Megaphone },
  { value: 'commission', label: 'Commission change', icon: BadgePoundSterling },
];

/** Three big choices (a radio group): fits a 375 px phone without scrolling sideways, 56 px tall. */
function KindPicker({ value, onChange }: { value: ClientPostKind; onChange: (v: ClientPostKind) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = KIND_OPTIONS.findIndex((o) => o.value === value);
    const next = (i + step + KIND_OPTIONS.length) % KIND_OPTIONS.length;
    onChange(KIND_OPTIONS[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="What are you posting?" className="grid grid-cols-3 gap-2" onKeyDown={onKeyDown}>
      {KIND_OPTIONS.map((o, i) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={clsx(
              'focus-ring flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center text-xs font-medium leading-tight transition-colors sm:text-sm',
              on ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const SUBMIT_LABEL: Record<ClientPostKind, string> = {
  update: 'Publish update',
  announcement: 'Publish announcement',
  commission: 'Send to Linear for approval',
};

/** The form's fields top to bottom: a failed send focuses the first one with a problem. */
const FIELD_ORDER: readonly ClientPostField[] = ['rateRep', 'ratePayout', 'effectiveFrom', 'title', 'body'];

const SENT_TOAST: Record<ClientPostKind, [string, string]> = {
  update: ['Update published', 'It is in the Linear MCR team’s Announcements now.'],
  announcement: ['Announcement published', 'Every fundraiser sees it in Announcements now.'],
  commission: ['Sent to Linear', 'Your commission change waits for Linear MCR to approve it.'],
};

/** "12.50" → 12.5; '' → null; anything else → NaN (the shared rules then say what is wrong). */
function parseRate(s: string): number | null {
  const t = s.trim().replace(/^£/, '');
  if (!t) return null;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

export function ClientPortalPage() {
  usePageTitle(COPY.nav.clientPortal.title);
  const q = useClientPortal();
  const campaign = q.data?.campaign;
  return (
    <>
      <PageHeader title={COPY.nav.clientPortal.title} description={COPY.nav.clientPortal.description} />
      <div className="space-y-6">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load your campaign" />
        ) : (
          <Card padded={false} className="overflow-hidden" data-testid="client-campaign">
            <div className="h-1.5" style={{ backgroundColor: campaign?.color ?? 'var(--color-border)' }} aria-hidden />
            <div className="p-4 sm:p-5">
              {!campaign ? (
                <Skeleton className="h-6 w-64" />
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                    You are signed in for <Badge tone="neutral" dot color={campaign.color}>{campaign.name}</Badge>
                  </p>
                  <p className="mt-1.5 break-words text-xs text-muted">{q.data?.me.name} · {q.data?.me.email}</p>
                </>
              )}
            </div>
          </Card>
        )}
        <PostForm disabled={!campaign} />
        <PostHistory posts={q.data?.posts} loading={q.isLoading} />
      </div>
    </>
  );
}

function PostForm({ disabled }: { disabled: boolean }) {
  const uid = useId();
  const toast = useToast();
  const create = useCreateClientPost();
  const [kind, setKind] = useState<ClientPostKind>('update');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [rateRep, setRateRep] = useState('');
  const [ratePayout, setRatePayout] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<ClientPostField, string>>>({});
  /** Bumped on each failed send, so the first field with a problem is focused after the errors render. */
  const [failedSend, setFailedSend] = useState(0);
  const commission = kind === 'commission';
  const fieldId: Record<ClientPostField, string> = {
    kind: `${uid}-title`,
    title: `${uid}-title`,
    body: `${uid}-body`,
    rateRep: `${uid}-rep`,
    ratePayout: `${uid}-payout`,
    effectiveFrom: `${uid}-from`,
  };

  const input = {
    kind,
    title: title.trim(),
    body: body.trim(),
    rateRep: commission ? parseRate(rateRep) : null,
    ratePayout: commission ? parseRate(ratePayout) : null,
    effectiveFrom: commission ? effectiveFrom || null : null,
  };
  const problems = clientPostProblems(input, todayISO());
  const errorFor = (f: ClientPostField) => serverErrors[f] ?? (submitted ? problems.find((p) => p.field === f)?.message : undefined);

  // On a phone the errors can be above the fold: bring the first one into view and put the cursor in it, so tapping
  // the button never looks like nothing happened.
  useEffect(() => {
    if (!failedSend) return;
    const first = FIELD_ORDER.find((f) => errorFor(f));
    const el = first ? document.getElementById(fieldId[first]) : null;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedSend]);

  function reset() {
    setTitle('');
    setBody('');
    setRateRep('');
    setRatePayout('');
    setEffectiveFrom('');
    setSubmitted(false);
    setServerErrors({});
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerErrors({});
    if (create.isPending) return;
    if (problems.length) {
      setFailedSend((n) => n + 1);
      return;
    }
    try {
      await create.mutateAsync(input);
      const [head, text] = SENT_TOAST[kind];
      toast.success(head, text);
      reset();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const next: Partial<Record<ClientPostField, string>> = {};
        for (const d of err.details as { path?: string; message?: string }[]) if (d.path && d.message) next[d.path as ClientPostField] ??= d.message;
        setServerErrors(next);
        setFailedSend((n) => n + 1);
      }
      toast.error('Could not send it', apiMessage(err, 'Check your connection and try again.'));
    }
  }

  return (
    <Card data-testid="client-post-form">
      <h2 className="text-base font-semibold text-fg">Post an update</h2>
      <p className="mt-1 text-sm text-muted">Everything you post goes to the Linear MCR team. Updates and announcements appear in their Announcements straight away.</p>
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="mt-4 space-y-4">
        <div>
          <KindPicker
            value={kind}
            onChange={(v) => {
              setKind(v);
              setServerErrors({});
            }}
          />
          <p className="mt-2 text-xs text-muted" data-testid="client-post-kind-hint">{CLIENT_POST_KIND_HINTS[kind]}</p>
        </div>

        {commission && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New rate per sub to the fundraiser (£)" htmlFor={`${uid}-rep`} error={errorFor('rateRep')} hint="Leave empty if it stays the same.">
              <Input id={`${uid}-rep`} inputMode="decimal" placeholder="e.g. 12.50" value={rateRep} onChange={(e) => setRateRep(e.target.value)} invalid={!!errorFor('rateRep')} leftIcon={<PoundSterling />} disabled={disabled} />
            </Field>
            <Field label="New payout per sub to Linear (£)" htmlFor={`${uid}-payout`} error={errorFor('ratePayout')} hint="Leave empty if it stays the same.">
              <Input id={`${uid}-payout`} inputMode="decimal" placeholder="e.g. 120" value={ratePayout} onChange={(e) => setRatePayout(e.target.value)} invalid={!!errorFor('ratePayout')} leftIcon={<PoundSterling />} disabled={disabled} />
            </Field>
            <Field label="Starts on" required htmlFor={`${uid}-from`} error={errorFor('effectiveFrom')} hint="Linear MCR confirms the date when they approve it." className="sm:col-span-2">
              <Input id={`${uid}-from`} type="date" min={todayISO()} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} invalid={!!errorFor('effectiveFrom')} disabled={disabled} />
            </Field>
          </div>
        )}

        <Field label="Title" required={!commission} optional={commission} htmlFor={`${uid}-title`} error={errorFor('title')}>
          <Input
            id={`${uid}-title`}
            value={title}
            maxLength={CLIENT_POST_TITLE_MAX}
            placeholder={commission ? 'e.g. Higher rate for the winter appeal' : 'e.g. New leaflets from Monday'}
            onChange={(e) => setTitle(e.target.value)}
            invalid={!!errorFor('title')}
            disabled={disabled}
          />
        </Field>
        <Field
          label="Message"
          required={!commission}
          optional={commission}
          htmlFor={`${uid}-body`}
          error={errorFor('body')}
          hint={`${body.trim().length.toLocaleString('en-GB')} of ${CLIENT_POST_BODY_MAX.toLocaleString('en-GB')} characters`}
        >
          <Textarea id={`${uid}-body`} rows={4} value={body} maxLength={CLIENT_POST_BODY_MAX} onChange={(e) => setBody(e.target.value)} invalid={!!errorFor('body')} disabled={disabled} />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={create.isPending} disabled={disabled} leftIcon={<Send aria-hidden />}>
          {SUBMIT_LABEL[kind]}
        </Button>
      </form>
    </Card>
  );
}

function PostHistory({ posts, loading }: { posts: ClientPost[] | undefined; loading: boolean }) {
  return (
    <section aria-labelledby="client-history-title" data-testid="client-post-history">
      <h2 id="client-history-title" className="mb-3 text-base font-semibold text-fg">Your posts</h2>
      {loading ? (
        <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : !posts?.length ? (
        <EmptyState icon={<Megaphone aria-hidden />} title="Nothing posted yet" description="Your updates, announcements and commission changes will be listed here with what happened to each." size="sm" />
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => <ClientPostItem key={p.id} post={p} />)}
        </ul>
      )}
    </section>
  );
}

/** One post as the client sees it: kind, status in words, the text, the rates for a commission change. */
function ClientPostItem({ post: p }: { post: ClientPost }) {
  const summary = p.kind === 'commission' ? clientCommissionSummary(p) : '';
  const requested = p.kind === 'commission' && p.status === 'approved' && p.requestedFrom && p.requestedFrom !== p.effectiveFrom;
  return (
    <li className="rounded-xl border border-border bg-surface p-4 shadow-card" data-testid="client-post">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" tone={p.kind === 'commission' ? 'info' : 'primary'}>{CLIENT_POST_KIND_LABELS[p.kind]}</Badge>
        <Badge size="sm" tone={CLIENT_POST_STATUS_TONE[p.status]} dot className="max-w-full">
          <span className="truncate">{p.status === 'declined' ? 'Declined' : clientPostStatusText(p)}</span>
        </Badge>
      </div>
      <h3 className="mt-2 break-words text-sm font-semibold text-fg">{p.title}</h3>
      {summary && (
        <p className="mt-1 text-sm font-medium text-fg">{summary}</p>
      )}
      {requested && <p className="mt-1 text-xs text-muted">You asked for {clientPostDayLabel(p.requestedFrom)}; Linear MCR confirmed {clientPostDayLabel(p.effectiveFrom)}.</p>}
      {p.body && <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">{p.body}</p>}
      {p.status === 'declined' && p.decisionNote && (
        <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-fg">
          <span className="font-medium">Linear MCR:</span> {p.decisionNote}
        </p>
      )}
      {p.status === 'approved' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {clientPostStatusText(p)}
        </p>
      )}
      <p className="mt-2 text-xs text-muted">{p.authorName} · {formatRelative(p.createdAt, undefined, { past: true })}</p>
    </li>
  );
}
