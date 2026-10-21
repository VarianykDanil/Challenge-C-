// The dashboard's Announcements card (release 1.2 UI fixes, group UC): the heading in full at every width, "New
// announcement" for admins and leaders, the latest five, and "Older announcements" (up to 20 earlier ones, with the
// same read receipts; reading them there marks them read like the dashboard does).
import { useId, useState } from 'react';
import { ChevronDown, Megaphone } from 'lucide-react';
import clsx from 'clsx';
import type { Dashboard } from '@lm/shared';
import { useOlderAnnouncements } from '@/api/hooks';
import { Button, Card, Skeleton } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { AnnouncementItem, Announcements } from './Announcements';

export interface AnnouncementsCardProps {
  dashboard: Dashboard | undefined;
  /** Admins and leaders: show "New announcement". */
  canAnnounce: boolean;
  onNew: () => void;
}

/** Capped so the row's other cards are not stretched by a long notice board. */
const LIST_BOX = 'max-h-[32rem] overflow-y-auto scrollbar-thin';

export function AnnouncementsCard({ dashboard: d, canAnnounce, onNew }: AnnouncementsCardProps) {
  const older = d?.olderAnnouncements ?? 0;
  return (
    // a size container: the button's label follows the card's width (a third of the row from 1024 px), not the screen's
    <Card className="@container min-w-0">
      {/* top-aligned like CardHeader from 640 px, so the heading lines up with the cards beside it; centred on the
          40 px phone button below that, where the cards stack */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:items-start">
        <h3 className="min-w-0 font-sans text-sm font-semibold tracking-normal text-fg">Announcements</h3>
        {canAnnounce && (
          <Button size="sm" variant="outline" className="max-sm:h-10" onClick={onNew} title="New announcement" leftIcon={<Megaphone className="h-3.5 w-3.5" aria-hidden />}>
            {/* "New announcement" when the card has room, "New" when it does not, the icon alone in the narrowest card */}
            <span className="@max-[13rem]:sr-only">New<span className="@max-xs:sr-only"> announcement</span></span>
          </Button>
        )}
      </div>
      <div className={LIST_BOX}>{!d ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : <Announcements items={d.announcements} />}</div>
      {older > 0 && <OlderAnnouncements count={older} />}
    </Card>
  );
}

/** "Older announcements · 12": a disclosure under the latest five; the list is fetched when it is first opened. */
function OlderAnnouncements({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const q = useOlderAnnouncements({ enabled: open });
  const items = q.data ?? [];
  return (
    <div className="mt-4 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-ring -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">Older announcements</span>
        <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted ring-1 ring-inset ring-border">{formatNumber(count)}</span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <section id={panelId} aria-label="Older announcements" className={clsx('mt-2', LIST_BOX)}>
          {q.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
          ) : q.isError ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm text-muted">
              Could not load the older announcements.
              <Button size="sm" variant="outline" className="max-sm:h-10" onClick={() => void q.refetch()}>Try again</Button>
            </p>
          ) : items.length === 0 ? (
            <p className="py-2 text-sm text-muted">There are no older announcements.</p>
          ) : (
            <>
              <ul className="space-y-3">
                {items.map((a) => <AnnouncementItem key={a.id} announcement={a} />)}
              </ul>
              {count > items.length && (
                <p className="mt-3 text-xs text-muted">
                  The {formatNumber(items.length)} most recent of {formatNumber(count)} older announcements.
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

