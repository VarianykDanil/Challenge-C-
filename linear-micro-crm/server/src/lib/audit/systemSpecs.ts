/**
 * Audit specs for the recovery sheet (routes/system.ts). The trail says that a sheet was made or confirmed, and for
 * which key (its short fingerprint), never the key itself; a refused attempt (wrong code, not the owner, not a secure
 * connection) is recorded too.
 */
import type { AuditDone, AuditDraft, AuditRouteSpec } from '../auditSpecs.ts';

const fingerprintOf = (done: AuditDone): string | null => {
  const r = done.response as { sheet?: { fingerprint?: unknown }; fingerprint?: unknown } | undefined;
  const fp = r?.sheet?.fingerprint ?? r?.fingerprint;
  return typeof fp === 'string' && /^[0-9A-F-]{4,20}$/.test(fp) ? fp : null;
};

const refused = (what: string) => (_db: unknown, done: AuditDone): AuditDraft[] => {
  const error = (done.response as { error?: unknown } | undefined)?.error;
  return [
    {
      entity: 'settings',
      entityId: null,
      summary: `Tried to ${what}: ${typeof error === 'string' ? error.slice(0, 160) : `refused (${done.status})`}`,
      kind: 'change',
    },
  ];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AUDIT_SPECS: readonly AuditRouteSpec<any>[] = [
  {
    method: 'POST',
    pattern: '/system/recovery-sheet/confirm',
    after(_db, done) {
      const fp = fingerprintOf(done);
      return [
        {
          entity: 'settings',
          entityId: null,
          summary: `Confirmed the recovery sheet is printed and kept safe${fp ? ` (key ${fp})` : ''}: local backups no longer carry a copy of the key`,
          after: { recoverySheetConfirmed: true, keyFingerprint: fp },
        },
      ];
    },
    failed: refused('confirm the recovery sheet'),
  },
  {
    method: 'POST',
    pattern: '/system/recovery-sheet',
    after(_db, done) {
      const fp = fingerprintOf(done);
      return [
        {
          entity: 'settings',
          entityId: null,
          summary: `Made the recovery sheet for the app key${fp ? ` (key ${fp})` : ''}. The key itself is never recorded`,
          after: { recoverySheetMade: true, keyFingerprint: fp },
        },
      ];
    },
    failed: refused('make the recovery sheet'),
  },
];
