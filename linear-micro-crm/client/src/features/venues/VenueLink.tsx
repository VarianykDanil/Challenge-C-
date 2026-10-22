// Release 1.3 slot — OWNED BY P8 venue-insights. A link from an event's venue to its profile (/venues/:key, shared
// venueKey(venue, city)). Mounted in pages/EventDetail.tsx in the header's venue line, after the directions link, in an
// ErrorBoundary with fallback={null}. Inline element only, a 40 px target on phones (32 px from `sm`, like Directions);
// "Venue numbers" never breaks over two lines (the header lets the address wrap on its own instead).
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { BarChart3 } from 'lucide-react';
import { isVenueKey, venueKey } from '@lm/shared';

export interface VenueLinkProps {
  venue: string;
  city: string;
  className?: string;
}

/** /venues/golden-square--warrington, or null when the venue has no usable name. */
export function venuePath(venue: string, city: string): string | null {
  const key = venueKey(venue, city);
  return isVenueKey(key) && key !== '--' ? `/venues/${key}` : null;
}

export function VenueLink({ venue, city, className }: VenueLinkProps) {
  const to = venuePath(venue, city);
  if (!to) return null;
  return (
    <Link
      to={to}
      aria-label={`Venue numbers for ${venue}, ${city}`}
      title={`Every shift at ${venue}: the numbers that make a good day there`}
      className={clsx(
        'inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-sm font-medium text-primary hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8',
        className,
      )}
    >
      <BarChart3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Venue numbers
    </Link>
  );
}
