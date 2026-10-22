// Release 1.3 — OWNED BY P6 client-portal. The campaign page's "Client posts" for admins and leaders: every update,
// announcement and commission change the client posted, newest first, with its status and "New" until read (posts
// shown here are marked read, all in one request). Admins decide: **Approve** a commission change (confirm the date it
// starts; P1's rate history recalculates unpaid weeks from it, and the dialog warns when the date reaches back into weeks
// already paid, which keep the old rate), **Decline** it (the reason is shown to the client), **Unpublish** an update or
// announcement (it comes off Announcements). A note on an approval or an unpublish stays in the office (never sent to
// the client). Leaders read only. A published post shows who has read it.
import { useEffect, useId, useRef, useState } from 'react';
import { Check, EyeOff, MessageSquareText, TriangleAlert, X } from 'lucide-react';
import {
  CLIENT_POST_KIND_LABELS,
  clientCommissionSummary,
  clientPostDayLabel,
  clientPostOfficeStatusText,
  type Announcement,
  type ClientPost,
} from '@lm/shared';
import { useDecideClientPost, useMarkClientPostsRead } from '@/api/clientPortal';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, Textarea, useToast } from '@/components/ui';
import { AnnouncementReads } from '@/features/audit/AnnouncementReads';
import { CLIENT_POST_STATUS_TONE } from '@/features/client/postTone';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { errorMessage } from '@/features/common/QueryStates';
import { formatGBP, formatRelative } from '@/lib/format';

export interface ClientPostsCardProps {
  posts: ClientPost[];
  announcements: Announcement[];
  /** The campaign's current rates, shown next to a proposed change. */
  current: { repCommissionPerSale?: number; payoutPerSale?: number };
  /** `?post=<id>` from a Needs-attention item: scrolled to and outlined. */
  focusId?: number | null;
  /** Admins: the last day of the latest paid pay week (CampaignPage.paidThrough), for the Approve dialog's warning. */
  paidThrough?: string | null;
  className?: string;
}

type Decision = { post: ClientPost; action: 'approve' | 'decline' | 'unpublish' };

/** "Now £20.00 to the fundraiser": today's rate for each rate the change touches ('' when none is known). */
function nowText(p: ClientPost, current: ClientPostsCardProps['current']): string {
  const parts = [
    p.rateRep != null && current.repCommissionPerSale !== undefined ? `${formatGBP(current.repCommissionPerSale, { cents: true })} to the fundraiser` : null,
    p.ratePayout != null && current.payoutPerSale !== undefined ? `${formatGBP(current.payoutPerSale, { cents: true })} to Linear` : null,
  ].filter(Boolean);
  return parts.length ? `Now ${parts.join(' and ')}` : '';
}

export function ClientPostsCard({ posts, announcements, current, focusId, paidThrough = null, className }: ClientPostsCardProps) {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const markRead = useMarkClientPostsRead();
  const marked = useRef(new Set<number>());
  const [decision, setDecision] = useState<Decision | null>(null);
  const byId = new Map(announcements.map((a) => [a.id, a]));

  // Reading the page reads its posts: every unread one, once, in ONE request (the badge and the top box follow).
  useEffect(() => {
    const ids = posts.filter((p) => p.unread && !marked.current.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    for (const id of ids) marked.current.add(id);
    markRead.mutate(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts]);

  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`client-post-${focusId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusId, posts.length]);

  const pending = posts.filter((p) => p.status === 'pending').length;
  return (
    <Card className={className} data-testid="client-posts-card">
      <CardHeader
        icon={<MessageSquareText />}
        title="Client posts"
        description={pending ? `${pending} commission ${pending === 1 ? 'change waits' : 'changes wait'} for ${isAdmin ? 'your' : 'an administrator’s'} decision.` : 'Updates, announcements and commission changes from the client portal.'}
      />
      {!posts.length ? (
        <EmptyState icon={<MessageSquareText aria-hidden />} title="Nothing from the client yet" description="When the client posts from their portal, it shows here and in Announcements." size="sm" className="border-0" />
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => {
            const summary = p.kind === 'commission' ? clientCommissionSummary(p) : '';
            const ann = p.announcementId ? byId.get(p.announcementId) : undefined;
            return (
              <li
                key={p.id}
                id={`client-post-${p.id}`}
                data-testid="office-client-post"
                className={`scroll-mt-24 rounded-lg border bg-surface-2 p-3 ${focusId === p.id ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge size="sm" tone={p.kind === 'commission' ? 'info' : 'primary'}>{CLIENT_POST_KIND_LABELS[p.kind]}</Badge>
                  <Badge size="sm" tone={CLIENT_POST_STATUS_TONE[p.status]} dot className="max-w-full">
                    <span className="truncate">{p.status === 'declined' ? 'Declined' : clientPostOfficeStatusText(p)}</span>
                  </Badge>
                  {p.unread && <Badge size="sm" tone="accent">New</Badge>}
                </div>
                <h4 className="mt-2 break-words text-sm font-semibold text-fg">{p.title}</h4>
                {summary && (
                  <p className="mt-1 text-sm font-medium text-fg">
                    {summary}
                    {p.status === 'pending' && nowText(p, current) && <span className="block text-xs font-normal text-muted">{nowText(p, current)}</span>}
                  </p>
                )}
                {p.body && <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">{p.body}</p>}
                {p.decisionNote && p.status !== 'pending' && (
                  <p className="mt-2 rounded-md bg-surface px-2.5 py-1.5 text-xs text-muted">
                    <span className="font-medium text-fg">{p.status === 'declined' ? 'Reason given' : 'Office note'}:</span> {p.decisionNote}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted">
                  {p.authorName} · {formatRelative(p.createdAt, undefined, { past: true })}
                  {p.decidedByName && p.decidedAt && p.status !== 'published' ? ` · ${p.status === 'approved' ? 'Approved' : p.status === 'declined' ? 'Declined' : 'Unpublished'} by ${p.decidedByName}` : ''}
                  {p.status === 'approved' && p.requestedFrom && p.requestedFrom !== p.effectiveFrom ? ` · asked for ${clientPostDayLabel(p.requestedFrom)}` : ''}
                </p>
                {ann && (
                  <ErrorBoundary name="client-post-reads" fallback={null}>
                    <AnnouncementReads announcement={ann} />
                  </ErrorBoundary>
                )}
                {isAdmin && (p.status === 'pending' || p.status === 'published') && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {p.status === 'pending' ? (
                      <>
                        <Button size="md" onClick={() => setDecision({ post: p, action: 'approve' })} leftIcon={<Check aria-hidden />}>Approve</Button>
                        <Button size="md" variant="outline" onClick={() => setDecision({ post: p, action: 'decline' })} leftIcon={<X aria-hidden />}>Decline</Button>
                      </>
                    ) : (
                      <Button size="md" variant="outline" onClick={() => setDecision({ post: p, action: 'unpublish' })} leftIcon={<EyeOff aria-hidden />}>Unpublish</Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {decision && <DecisionModal decision={decision} paidThrough={paidThrough} onClose={() => setDecision(null)} />}
    </Card>
  );
}

const TITLES: Record<Decision['action'], string> = {
  approve: 'Approve this commission change',
  decline: 'Decline this commission change',
  unpublish: 'Unpublish this post',
};

function DecisionModal({ decision: { post, action }, paidThrough, onClose }: { decision: Decision; paidThrough: string | null; onClose: () => void }) {
  const uid = useId();
  const toast = useToast();
  const decide = useDecideClientPost();
  const [effectiveFrom, setEffectiveFrom] = useState(post.effectiveFrom ?? '');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const noteError = submitted && action === 'decline' && !note.trim() ? 'Say why, in a sentence. The client sees it.' : undefined;
  const dateError = submitted && action === 'approve' && !effectiveFrom ? 'Pick the date the new rate starts.' : undefined;
  // P1 recalculates unpaid weeks only: a date on or before the last paid week leaves those weeks at the old rate. Only a
  // new rate to the fundraiser changes anyone's pay; a payout-only change (what the client pays Linear) needs no
  // pay correction, so it gets no warning.
  const reachesPaid = action === 'approve' && post.rateRep != null && !!paidThrough && !!effectiveFrom && effectiveFrom <= paidThrough;

  async function submit() {
    setSubmitted(true);
    if ((action === 'decline' && !note.trim()) || (action === 'approve' && !effectiveFrom)) return;
    try {
      await decide.mutateAsync({
        id: post.id,
        action,
        ...(action === 'approve' ? { effectiveFrom } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      const done = action === 'approve' ? ['Approved', `The new rate applies from ${clientPostDayLabel(effectiveFrom)}.`] : action === 'decline' ? ['Declined', 'The client sees your reason in their portal.'] : ['Unpublished', 'It is no longer in Announcements.'];
      toast.success(done[0]!, done[1]);
      onClose();
    } catch (err) {
      toast.error('Could not save that', errorMessage(err));
    }
  }

  const summary = clientCommissionSummary({ ...post, effectiveFrom: null });
  const formId = `${uid}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title={TITLES[action]}
      description={action === 'unpublish' ? `“${post.title}” comes off Announcements for everyone. The client sees it as Unpublished.` : `${post.campaignName}: ${summary}.`}
      size="sm"
      tone={action === 'approve' ? 'default' : 'danger'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={decide.isPending}>Cancel</Button>
          <Button type="submit" form={formId} variant={action === 'approve' ? 'primary' : 'danger'} loading={decide.isPending}>
            {action === 'approve' ? 'Approve' : action === 'decline' ? 'Decline' : 'Unpublish'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="space-y-4">
        {action === 'approve' && (
          <Field
            label="New rate applies from"
            required
            htmlFor={`${uid}-from`}
            error={dateError}
            hint={post.requestedFrom ? `The client asked for ${clientPostDayLabel(post.requestedFrom)}. Unpaid weeks from this date are recalculated; paid weeks never change.` : 'Unpaid weeks from this date are recalculated; paid weeks never change.'}
          >
            <Input id={`${uid}-from`} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} invalid={!!dateError} />
          </Field>
        )}
        {reachesPaid && (
          <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-fg" role="status" data-testid="approve-paid-warning">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>
              Weeks up to {clientPostDayLabel(paidThrough)} are already paid. They keep the old rate: nothing is corrected
              automatically. To pay someone the difference, use Add an adjustment in Finance → Company.
            </span>
          </p>
        )}
        <Field
          label={action === 'decline' ? 'Reason for the client' : 'Note for the office'}
          required={action === 'decline'}
          optional={action !== 'decline'}
          htmlFor={`${uid}-note`}
          error={noteError}
          hint={action === 'decline' ? 'Kind and specific, e.g. “We agreed £120 per sub until March.”' : 'Only the office sees it, here and in the audit trail. The client does not.'}
        >
          <Textarea id={`${uid}-note`} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!noteError} />
        </Field>
      </form>
    </Modal>
  );
}
