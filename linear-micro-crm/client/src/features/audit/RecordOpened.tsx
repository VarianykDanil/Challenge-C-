// Release 1.3 slot — OWNED BY P9 audit-everything (laid down by r3-foundation).
// Reports "opened a sensitive record" to the audit trail once per mount and record (api/auditEvents.ts
// reportAuditEvent, kind 'opened'). Renders nothing, ever. Mounted, each in an ErrorBoundary with fallback={null}:
// pages/CandidateDetail.tsx (entity 'candidate'), features/finance/PayslipModal.tsx (entity 'payroll_run', or P2's
// 'invoice' once the invoice view lands), pages/Audit.tsx (entity null: the audit trail itself).
// The server checks the person may open the record (403 otherwise, ignored here) and keeps one row per person and record
// in any 5 minutes, so a page re-rendering or React's development double mount adds no rows. Nothing is reported for a
// client portal account (the server would refuse it) or while signed out.
import { useEffect } from 'react';
import type { AuditEntity } from '@lm/shared';
import { reportAuditEvent } from '@/api/auditEvents';
import { useAuth } from '@/auth/AuthProvider';

export interface RecordOpenedProps {
  entity: AuditEntity | null;
  entityId: number | null;
  /** What was opened, e.g. "candidate profile", "payslip", "audit trail". */
  what: string;
}

export function RecordOpened({ entity, entityId, what }: RecordOpenedProps) {
  const { user } = useAuth();
  const role = user?.role;
  useEffect(() => {
    if (!role || role === 'client') return;
    if (entity !== null && entityId == null) return; // the record has not loaded yet
    reportAuditEvent(entity === null ? { kind: 'opened', what } : { kind: 'opened', what, entity, entityId: entityId! });
  }, [role, entity, entityId, what]);
  return null;
}
