import { Megaphone, Pin } from 'lucide-react';
import type { Announcement } from '@lm/shared';
import { EmptyState } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { COPY } from '@/content/copy';

export function Announcements({ items }: { items: Announcement[] }) {
  if (!items.length) return <EmptyState icon={<Megaphone className="h-6 w-6" aria-hidden />} title={COPY.empty.announcements.title} description={COPY.empty.announcements.description} size="sm" className="border-0" />;
  return (
    <ul className="space-y-3">
      {items.map((a) => (
        <li key={a.id} className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-sm font-semibold text-fg">{a.title}</h4>
            {a.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-accent" aria-label="Pinned" />}
          </div>
          <p className="mt-1 whitespace-pre-line text-sm text-muted">{a.body}</p>
          <div className="mt-2 text-xs text-muted">{a.authorName ?? 'Office'} · {formatRelative(a.createdAt)}</div>
        </li>
      ))}
    </ul>
  );
}
