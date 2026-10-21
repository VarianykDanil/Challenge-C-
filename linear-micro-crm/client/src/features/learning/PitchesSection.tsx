// Release 1.2 slot — OWNED BY L2 learning-pitch.
// The "Pitches" cards on the Learning hub (/learning), one per campaign, above the COD pack lessons. A campaign with a
// pitch opens it; one without shows "Write the pitch" to admins and leaders (and "Not written yet" to everyone else).
// Inactive campaigns appear only when they have a pitch. Mounted by pages/Learning.tsx (L1's page) in an
// ErrorBoundary with fallback={null}.
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ChevronRight, Mic, PenLine } from 'lucide-react';
import type { PitchListItem } from '@lm/shared';
import { usePitches } from '@/api/pitches';
import { useAuth } from '@/auth/AuthProvider';
import { Badge, Skeleton } from '@/components/ui';
import { formatDateShort } from '@/lib/format';

export interface PitchesSectionProps {
  className?: string;
}

export function PitchesSection({ className }: PitchesSectionProps) {
  const { user } = useAuth();
  const { data, isLoading, isError } = usePitches();
  const canWrite = user?.role === 'admin' || user?.role === 'leader';
  const items = (data ?? []).filter((p) => p.campaignActive || p.hasPitch);
  if (isError) return null;
  const written = items.filter((p) => p.hasPitch).length;

  return (
    <section aria-labelledby="pitches-heading" className={clsx('min-w-0', className)} data-pitches-section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id="pitches-heading" className="flex items-center gap-2 text-lg font-semibold text-fg">
            <Mic className="h-5 w-5 text-primary" aria-hidden />
            Pitches
          </h2>
          <p className="mt-0.5 text-sm text-muted">Each campaign's script, set for reading aloud, with a teleprompter, flashcards and a step timer.</p>
        </div>
        {!isLoading && items.length > 0 && (
          <p className="text-xs text-muted tabular">
            {written} of {items.length} written
          </p>
        )}
      </div>
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong/70 p-4 text-sm text-muted">No campaigns yet: pitches appear here once the office adds a campaign.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => (
            <li key={p.campaignId} className="min-w-0">
              <PitchCard item={p} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One campaign's card. The campaign's name has the card's width to itself (it wraps to a second line rather than
 * being cut), and "Write the pitch" sits under it instead of beside it.
 */
function PitchCard({ item, canWrite }: { item: PitchListItem; canWrite: boolean }) {
  const href = `/learning/pitch/${encodeURIComponent(item.campaignCode)}`;
  const inner = (
    <>
      <span className="absolute inset-y-3 left-0 w-1 rounded-r-full" style={{ backgroundColor: item.campaignColor }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold text-fg" data-pitch-name>
            {item.campaignName}
          </span>
          <Badge size="sm" tone="neutral" className="shrink-0 font-mono">{item.campaignCode}</Badge>
          {!item.campaignActive && <Badge size="sm" tone="neutral" className="shrink-0">Inactive</Badge>}
        </span>
        {item.hasPitch ? (
          <>
            <span className="mt-1 line-clamp-2 break-words text-sm text-fg">{item.title}</span>
            {item.updatedAt && <span className="mt-0.5 block text-xs text-muted">Updated {formatDateShort(item.updatedAt)}</span>}
          </>
        ) : (
          <>
            <span className="mt-1 block text-sm text-muted">{canWrite ? 'No pitch yet' : 'Not written yet'}</span>
            {canWrite && (
              <span className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:underline">
                <PenLine className="h-4 w-4" aria-hidden />
                Write the pitch
              </span>
            )}
          </>
        )}
      </span>
      {item.hasPitch && <ChevronRight className="h-5 w-5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />}
    </>
  );
  // h-full: the cards in a row of the grid share its height when one has a second line.
  const cls =
    'group relative flex h-full min-h-24 w-full items-center gap-3 overflow-hidden rounded-xl border border-border bg-surface py-4 pl-5 pr-4 text-left shadow-card';
  if (item.hasPitch) {
    return (
      <Link to={href} className={clsx(cls, 'card-hover focus-ring')} aria-label={`${item.campaignName}: ${item.title}`}>
        {inner}
      </Link>
    );
  }
  if (canWrite) {
    return (
      <Link to={`${href}?edit=1`} className={clsx(cls, 'card-hover focus-ring border-dashed shadow-none')} aria-label={`Write the ${item.campaignName} pitch`}>
        {inner}
      </Link>
    );
  }
  return <div className={clsx(cls, 'border-dashed shadow-none')}>{inner}</div>;
}
