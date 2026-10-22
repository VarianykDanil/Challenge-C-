// Release 1.3 — OWNED BY P3 statements. Small pieces the statements page and settings share: the status badge, the
// campaign chip, the period label and the words for a pay effect.
import { CheckCircle2, CircleAlert, CircleDashed, FileWarning } from 'lucide-react';
import { STATEMENT_STATUS_LABELS, formatStatementPeriod, type ApplyPersonResult, type StatementStatus } from '@lm/shared';
import { Badge, type BadgeTone } from '@/components/ui';
import { todayISO } from '@/lib/dates';
import { formatDateShort, formatGBP } from '@/lib/format';

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

/** "w/c 28 Sep" — with the year when it is not this year's ("w/c 11 Oct 2027"), so a far date shows as one. */
export function statementWeekLabel(monday: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(monday);
  if (!d) return `w/c ${monday}`;
  const short = formatDateShort(monday);
  return d[1] === todayISO().slice(0, 4) ? `w/c ${short}` : `w/c ${short} ${d[1]}`;
}

/**
 * One person's lines of P1's pay effect, summed: the difference and the sentences. Over several pay weeks each
 * sentence says which week it is about (re-review fix: "w/c 28 Sep: 1 cancelled by CHN, but the base still applied: no
 * change.").
 */
export function personEffect(people: readonly ApplyPersonResult[] | undefined, userId: number): { difference: number; sentences: string[] } | null {
  const mine = (people ?? []).filter((p) => p.userId === userId).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  if (!mine.length) return null;
  const weeks = new Set(mine.map((p) => p.weekStart)).size;
  const sentences = mine.filter((p) => p.sentence).map((p) => (weeks > 1 ? `${statementWeekLabel(p.weekStart)}: ${p.sentence}` : p.sentence));
  return { difference: Math.round(mine.reduce((s, p) => s + p.difference, 0) * 100) / 100, sentences };
}
