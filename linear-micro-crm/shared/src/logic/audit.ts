/**
 * Release 1.2 — OWNED BY U3 audit-trail (laid down by r2-foundation; the diff is a stub).
 * Pure: the field-level diff the /audit page and the entity history show, and the keys that are never stored.
 */
import type { AuditFieldChange } from '../types/audit.ts';

/** Keys (any depth, case-insensitive) replaced by "[redacted]" before a snapshot is stored. U3 owns the list. */
export const AUDIT_REDACTED_KEYS: readonly string[] = [
  'pin', 'currentPin', 'pinHash', 'pin_hash', 'password', 'token', 'sessionToken', 'challengeToken', 'secret',
  'totp_secret_enc', 'totp_pending_enc', 'code', 'recoveryCode', 'recoveryCodes', 'code_hash',
];

/** STUB (U3): the changed fields between two snapshots (flat objects; nested values compared as JSON). */
export function auditDiff(before: unknown, after: unknown): AuditFieldChange[] {
  void before;
  void after;
  return [];
}
