import { Megaphone, Pin } from 'lucide-react';
import type { Announcement } from '@lm/shared';
import { EmptyState } from '@/components/ui';
import { AnnouncementReads } from '@/features/audit/AnnouncementReads';
import { ErrorBoundary } from '@/features/common/ErrorBoundary';
import { formatRelative } from '@/lib/format';
import { COPY } from '@/content/copy';

/** One announcement card: title, message, who posted it and when, and (for the author and admins) who has read it. */
export function AnnouncementItem({ announcement: a }: { announcement: Announcement }) {
  return (
    <li className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-semibold text-fg">{a.title}</h4>
        {a.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-accent" aria-label="Pinned" />}
      </div>
      <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">{a.body}</p>
      <div className="mt-2 text-xs text-muted">{a.authorName ?? 'Office'} · {formatRelative(a.createdAt, undefined, { past: true })}</div>
      {/* Release 1.2 slot (U3): marks it read when seen; "Read by 18 of 34" for the author and admins. */}
      <ErrorBoundary name="announcement-reads" fallback={null}>
        <AnnouncementReads announcement={a} />
      </ErrorBoundary>
    </li>
  );
}

export function Announcements({ items }: { items: Announcement[] }) {
  if (!items.length) return <EmptyState icon={<Megaphone className="h-6 w-6" aria-hidden />} title={COPY.empty.announcements.title} description={COPY.empty.announcements.description} size="sm" className="border-0" />;
  return (
    <ul className="space-y-3">
      {items.map((a) => <AnnouncementItem key={a.id} announcement={a} />)}
    </ul>
  );
}
