// Release 1.2 slot — OWNED BY U3 audit-trail.
// "History" of one record (GET /audit/:entity/:entityId): who changed what and when, with a field-level diff. Admins see
// every record's history; leaders see their own team's gauge entries; everyone else sees nothing (and nothing is
// fetched, so no request is refused). Mounted, each in an ErrorBoundary with fallback={null}:
//  - features/finance/PayslipModal.tsx, at the end of the payslip body (entity 'payroll_run');
//  - features/gauges/LogGaugesModal.tsx, under the form when an existing entry is open (entity 'gauge_entry').
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, History } from 'lucide-react';
import clsx from 'clsx';
import type { AuditEntity } from '@lm/shared';
import { useEntityHistory } from '@/api/audit';
import { useCurrentUser } from '@/auth/AuthProvider';
import { Skeleton } from '@/components/ui';
import { AuditEntryItem } from './AuditEntryItem';

export interface EntityHistoryProps {
  entity: AuditEntity;
  entityId: number;
  className?: string;
}

/** Who may read which history (mirrors the server: admin any; leader gauge entries of their own team). */
function canSeeEntityHistory(role: string, entity: AuditEntity): boolean {
  return role === 'admin' || (role === 'leader' && entity === 'gauge_entry');
}

export function EntityHistory({ entity, entityId, className }: EntityHistoryProps) {
  const me = useCurrentUser();
  const allowed = canSeeEntityHistory(me.role, entity);
  const q = useEntityHistory(entity, entityId, { enabled: allowed });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!allowed || q.isError) return null;
  const rows = q.data ?? [];
  const count = rows.length;
  const label = q.isLoading ? 'Loading…' : count === 0 ? 'No changes recorded yet' : count === 1 ? '1 change' : `${count} changes`;
  return (
    <section className={clsx('min-w-0 rounded-xl border border-border bg-surface', className)} aria-label="Change history">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={q.isLoading}
        className="focus-ring-inset flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:cursor-default"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
          <History className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-fg">History</span>
          <span className="block text-xs text-muted">{label}</span>
        </span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border">
          {q.isLoading ? (
            <div className="space-y-2 p-3"><Skeleton /><Skeleton /></div>
          ) : count === 0 ? (
            <p className="px-3 py-3 text-xs text-muted">Changes made from release 1.2 onwards are listed here: who made them, when, and what changed.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => <AuditEntryItem key={r.id} entry={r} showEntity={false} compact />)}
            </ul>
          )}
          {me.role === 'admin' && count > 0 && (
            <div className="border-t border-border px-3 py-2 text-right">
              <Link to={`/audit?entity=${entity}&entityId=${entityId}`} className="text-xs font-medium text-primary hover:underline">Open in the audit trail</Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
