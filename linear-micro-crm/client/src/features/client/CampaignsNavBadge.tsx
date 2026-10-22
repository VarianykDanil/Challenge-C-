// Release 1.3 slot — OWNED BY P6 client-portal. The sidebar Campaigns item's badge: the client posts the signed-in admin
// or leader has not read yet (api/clientPortal.ts useUnreadClientPosts; read on the campaign page). A count pill after
// the label, a dot on the icon when the sidebar is collapsed; nothing at 0 or for other roles. Mounted in
// components/layout/Sidebar.tsx inside the Campaigns link, in an ErrorBoundary with fallback={null}. In the main chunk,
// so it asks for the count itself (the same query as api/clientPortal.ts useUnreadClientPosts — same key, so reading a
// post refreshes it) instead of pulling the whole hooks module into the shell.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';

/** = clientPortalKeys.unread (api/clientPortal.ts). */
const UNREAD_KEY = ['client-portal', 'unread'] as const;

export interface CampaignsNavBadgeProps {
  /** The collapsed sidebar: show a dot on the icon instead of a count. */
  compact: boolean;
}

export function CampaignsNavBadge({ compact }: CampaignsNavBadgeProps) {
  const { user } = useAuth();
  const office = user?.role === 'admin' || user?.role === 'leader';
  const q = useQuery({ queryKey: UNREAD_KEY, queryFn: () => api<{ count: number }>('/client-posts/unread'), enabled: office, staleTime: 60_000 });
  const count = office ? (q.data?.count ?? 0) : 0;
  if (!count) return null;
  const label = `${count} new client ${count === 1 ? 'post' : 'posts'}`;
  if (compact) {
    return (
      <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent ring-2 ring-surface" data-testid="campaigns-nav-badge">
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span
      className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold leading-none tabular-nums text-accent-fg"
      data-testid="campaigns-nav-badge"
    >
      <span aria-hidden>{count > 9 ? '9+' : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
