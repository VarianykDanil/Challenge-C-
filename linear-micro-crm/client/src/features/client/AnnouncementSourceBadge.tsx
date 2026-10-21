// Release 1.3 slot — OWNED BY P6 client-portal (laid down by r3-foundation; renders nothing until P6 client-portal fills it).
// The badge "From Breast Cancer Now" on an announcement a campaign's client posted (announcement.fromClient), and the
// office's "Unpublish" for admins. Mounted in features/dashboard/Announcements.tsx in each item's title row, after the
// title, in an ErrorBoundary with fallback={null}. Inline element only.
import type { Announcement } from '@lm/shared';

export interface AnnouncementSourceBadgeProps {
  announcement: Announcement;
}

export function AnnouncementSourceBadge(_props: AnnouncementSourceBadgeProps) {
  return null;
}
