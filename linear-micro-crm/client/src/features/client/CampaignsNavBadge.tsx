// Release 1.3 slot — OWNED BY P6 client-portal (laid down by r3-foundation; renders nothing until P6 client-portal fills it).
// The sidebar Campaigns item's badge: unread client posts (api/clientPortal.ts useUnreadClientPosts), admins and
// leaders. Mounted in components/layout/Sidebar.tsx inside the Campaigns link (after the label; a dot on the icon when
// the sidebar is collapsed), in an ErrorBoundary with fallback={null}. Keep it tiny: it is in the main chunk.
export interface CampaignsNavBadgeProps {
  /** The collapsed sidebar: show a dot on the icon instead of a count. */
  compact: boolean;
}

export function CampaignsNavBadge(_props: CampaignsNavBadgeProps) {
  return null;
}
