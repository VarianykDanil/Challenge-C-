// Release 1.2 slot — OWNED BY U3 audit-trail (laid down by r2-foundation; renders nothing until U3 fills it).
// Per announcement on the dashboard: marks it read once it has been seen (POST /announcements/:id/read) and, for the
// author and admins, shows "Read by 18 of 34" (GET /announcements/reads; names for admins and the author only).
// Mounted in features/dashboard/Announcements.tsx inside each item, in an ErrorBoundary with fallback={null}.
import type { Announcement } from '@lm/shared';

export interface AnnouncementReadsProps {
  announcement: Announcement;
  className?: string;
}

export function AnnouncementReads(_props: AnnouncementReadsProps) {
  return null;
}
