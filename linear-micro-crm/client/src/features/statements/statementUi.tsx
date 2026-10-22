// Release 1.3 — OWNED BY P3 statements. Small pieces the statements page and settings share: the status badge, the
// campaign chip, the period label and the words for a pay effect.
import { CheckCircle2, CircleAlert, CircleDashed, FileWarning } from 'lucide-react';
import { STATEMENT_STATUS_LABELS, formatStatementPeriod, type ApplyPersonResult, type StatementStatus } from '@lm/shared';
import { Badge, type BadgeTone } from '@/components/ui';
import { formatGBP } from '@/lib/format';

const TONE: Record<StatementStatus, BadgeTone> = { parsed: 'info', needs_review: 'warning', applied: 'success', failed: 'danger' };
const ICON = { parsed: CircleDashed, needs_review: CircleAlert, applied: CheckCircle2, failed: FileWarning } as const;

export function StatementStatusBadge({ status, size }: { status: StatementStatus; size?: 'sm' | 'md' }) {
  const Icon = ICON[status];
  return (
    <Badge tone={TONE[status]} size={size} data-testid="statement-status">
      <Icon className="h-3 w-3" aria-hidden />
      {STATEMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function CampaignChip({ code, color }: { code: string | null; color?: string | null }) {
  if (!code) return <Badge tone="neutral">No campaign</Badge>;
  return (
    <Badge tone="neutral" dot color={color ?? undefined}>
      {code}
    </Badge>
  );
}

export const periodLabel = (start: string | null | undefined, end: string | null | undefined) => formatStatementPeriod(start, end);

/** "−£20.00" / "+£15.00" / "£0.00" with the sign spelled out. */
export function signedGBP(n: number): string {
  if (!n) return formatGBP(0, { cents: true });
  return `${n < 0 ? '−' : '+'}${formatGBP(Math.abs(n), { cents: true })}`;
}

/** One person's lines of P1's pay effect, summed: the difference and the sentences. */
export function personEffect(people: readonly ApplyPersonResult[] | undefined, userId: number): { difference: number; sentences: string[] } | null {
  const mine = (people ?? []).filter((p) => p.userId === userId);
  if (!mine.length) return null;
  return { difference: Math.round(mine.reduce((s, p) => s + p.difference, 0) * 100) / 100, sentences: mine.map((p) => p.sentence).filter(Boolean) };
}
