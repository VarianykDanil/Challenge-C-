// Release 1.2 slot — OWNED BY U2 bulk-entry. "Bulk entry" link to /gauges/bulk.
// Mounted in pages/Gauges.tsx header actions for leaders and admins, before the tally button, in an ErrorBoundary
// with fallback={null}. Styled as the header's outline buttons (a link, so it opens in a new tab too).
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ClipboardList } from 'lucide-react';
import { useCurrentUser } from '@/auth/AuthProvider';

export interface BulkEntryLinkProps {
  className?: string;
}

export function BulkEntryLink({ className }: BulkEntryLinkProps) {
  const me = useCurrentUser();
  if (me.role !== 'leader' && me.role !== 'admin') return null;
  return (
    <Link
      to="/gauges/bulk"
      data-bulk-entry-link
      title="Log the whole team's gauges for one event, or paste them from WhatsApp"
      className={clsx(
        'focus-ring inline-flex h-10 shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg shadow-card transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-surface-2 active:bg-surface-3',
        className,
      )}
    >
      <ClipboardList className="h-4 w-4" aria-hidden />
      Bulk entry
    </Link>
  );
}
