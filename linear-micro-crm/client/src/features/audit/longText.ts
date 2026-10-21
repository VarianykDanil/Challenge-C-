// Release 1.2 review fix (security S6). Long text in audit snapshots: the server stores any text over 2,000 characters
// as { length, sha256, head } (server/src/lib/audit.ts compactLongText), never the whole text. These helpers let the
// diff show it, under the field's label ("Script"), as "Changed · 19,204 characters" with the first 200 characters
// of each version.
import { formatNumber } from '@/lib/format';

/** The stored shape of a long text: its length, the SHA-256 of the whole text, and its first 200 characters. */
export interface AuditLongText {
  length: number;
  sha256: string;
  head: string;
}

export function isAuditLongText(value: unknown): value is AuditLongText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.length === 'number' && typeof v.sha256 === 'string' && typeof v.head === 'string';
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/** How many characters one side of the change has (a stored long text or a plain string); null when empty. */
export function textLength(value: unknown): number | null {
  if (isAuditLongText(value)) return value.length;
  return typeof value === 'string' && value !== '' ? value.length : null;
}

/** "19,204 characters" / "1 character". */
export const charactersLabel = (n: number) => `${formatNumber(n)} ${n === 1 ? 'character' : 'characters'}`;

/**
 * The line above a long-text change, next to the field's label (so it does not repeat it): "Changed · 19,204
 * characters (was 18,950)", "Added · 2,410 characters", "Removed · was 2,410 characters".
 */
export function longTextHeadline(before: unknown, after: unknown): string {
  const was = textLength(before);
  const now = textLength(after);
  if (isEmpty(before) || was === null) return now === null ? 'Changed' : `Added · ${charactersLabel(now)}`;
  if (isEmpty(after) || now === null) return `Removed · was ${charactersLabel(was)}`;
  return `Changed · ${charactersLabel(now)}${was !== now ? ` (was ${formatNumber(was)})` : ''}`;
}
