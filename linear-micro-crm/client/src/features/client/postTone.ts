// Release 1.3 — OWNED BY P6 client-portal. The badge tone of each client post status, shared by the portal's history
// (pages/ClientPortal.tsx) and the office's list on the campaign page (features/campaigns/ClientPostsCard.tsx).
import type { ClientPostStatus } from '@lm/shared';
import type { BadgeTone } from '@/components/ui';

export const CLIENT_POST_STATUS_TONE: Record<ClientPostStatus, BadgeTone> = {
  published: 'success',
  pending: 'warning',
  approved: 'success',
  declined: 'danger',
  unpublished: 'neutral',
};
