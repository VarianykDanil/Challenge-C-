/**
 * Release 1.3 — OWNED BY P6 client-portal (laid down by r3-foundation). Labels and pure rules for client posts and
 * client accounts. formatClientAccessCode is STABLE (the foundation's demo account is "CL-0001").
 */
import { CLIENT_ACCESS_CODE_PREFIX, type ClientPostKind, type ClientPostStatus } from '../types/client.ts';

export const CLIENT_POST_KIND_LABELS: Record<ClientPostKind, string> = {
  update: 'Update',
  announcement: 'Announcement',
  commission: 'Commission change',
};

/** "Waiting for Linear", "Approved", "Declined" (P6 words the dates: "Approved from 2 Nov", "Declined: reason"). */
export const CLIENT_POST_STATUS_LABELS: Record<ClientPostStatus, string> = {
  published: 'Published',
  pending: 'Waiting for Linear',
  approved: 'Approved',
  declined: 'Declined',
  unpublished: 'Unpublished',
};

/** "CL-0001" for 1. */
export function formatClientAccessCode(n: number): string {
  return `${CLIENT_ACCESS_CODE_PREFIX}${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
}
