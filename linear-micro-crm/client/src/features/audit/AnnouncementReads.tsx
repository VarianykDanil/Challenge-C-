// Release 1.2 slot — OWNED BY U3 audit-trail.
// Per announcement on the dashboard: marks it read once it has been on screen (POST /announcements/:id/read, batched,
// once per person and device) and, for the author and admins, shows "Read by 18 of 34" with the readers' names
// (GET /announcements/reads, one shared request for every card).
// Mounted in features/dashboard/Announcements.tsx inside each item, in an ErrorBoundary with fallback={null}.
import { useEffect, useId, useRef, useState } from 'react';
import { CheckCheck, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { Announcement } from '@lm/shared';
import { useAnnouncementReads, useMarkAnnouncementSeen } from '@/api/audit';
import { useCurrentUser } from '@/auth/AuthProvider';
import { formatDateTime, formatNumber } from '@/lib/format';

export interface AnnouncementReadsProps {
  announcement: Announcement;
  className?: string;
}

/** How long the card must stay on screen before it counts as read. */
const SEEN_AFTER_MS = 1200;

/** Reports the announcement as read once at least half of it has been visible for a moment. */
function useSeen(announcement: Announcement, userId: number) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const markSeen = useMarkAnnouncementSeen(userId);
  const own = announcement.authorId === userId;
  useEffect(() => {
    const el = ref.current;
    if (own || !el) return;
    // The sentinel sits inside the card; observe the card itself so "half visible" means half the announcement.
    const target = el.closest('li') ?? el;
    if (typeof IntersectionObserver === 'undefined') {
      markSeen(announcement.id);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
        if (visible && !timer) timer = setTimeout(() => { markSeen(announcement.id); io.disconnect(); }, SEEN_AFTER_MS);
        if (!visible && timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(target);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [announcement.id, own, markSeen]);
  return ref;
}

export function AnnouncementReads({ announcement, className }: AnnouncementReadsProps) {
  const me = useCurrentUser();
  const sentinel = useSeen(announcement, me.id);
  const canSee = me.role === 'admin' || announcement.authorId === me.id;
  const reads = useAnnouncementReads({ enabled: canSee });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const stats = canSee ? reads.data?.find((s) => s.announcementId === announcement.id) : undefined;

  return (
    <>
      <span ref={sentinel} hidden />
      {stats && (
        <div className={clsx('mt-2 border-t border-border pt-2', className)}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            disabled={stats.readCount === 0 || !stats.readers}
            className="focus-ring -mx-1 flex min-h-10 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 text-left text-xs text-muted transition-colors enabled:hover:text-fg disabled:cursor-default"
          >
            <CheckCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="shrink-0 font-medium text-fg">
              Read by {formatNumber(stats.readCount)} of {formatNumber(stats.audience)}
            </span>
            <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3/80" aria-hidden>
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, (stats.readCount / Math.max(1, stats.audience)) * 100)}%` }} />
            </span>
            {stats.readCount > 0 && stats.readers && <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />}
          </button>
          {open && stats.readers && (
            <ul id={panelId} className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Who has read it">
              {stats.readers.map((r) => (
                <li key={r.userId} className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-fg ring-1 ring-inset ring-border" title={`Read ${formatDateTime(r.readAt)}`}>
                  {r.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
