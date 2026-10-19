// Smart release 1.1 (p6, lead's addition): one-tap directions to an event's venue. Client-only: a Google Maps search
// URL built from "venue, city" — no API key, no server call. Opens in a new tab (the Maps app on a phone).
import clsx from 'clsx';
import { Navigation } from 'lucide-react';

/** https://www.google.com/maps/search/?api=1&query=<"venue, city"> */
export function mapsUrl(venue: string, city: string): string {
  const query = [venue, city].map((s) => s.trim()).filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export interface DirectionsLinkProps {
  venue: string;
  city: string;
  /** `icon`: a 40 px square icon button (rows); `text`: icon + "Directions" (headers). */
  variant?: 'icon' | 'text';
  /** Icon variant only: fill the parent's height (a full-height rail at the end of a row) instead of a 40 px square. */
  stretch?: boolean;
  className?: string;
}

export function DirectionsLink({ venue, city, variant = 'icon', stretch, className }: DirectionsLinkProps) {
  const label = `Directions to ${venue}, ${city} (opens Google Maps in a new tab)`;
  if (variant === 'text') {
    return (
      <a
        href={mapsUrl(venue, city)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={`Directions to ${venue}, ${city}`}
        className={clsx(
          'inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8',
          className,
        )}
      >
        <Navigation className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Directions
      </a>
    );
  }
  return (
    <a
      href={mapsUrl(venue, city)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={`Directions to ${venue}, ${city}`}
      className={clsx(
        'inline-flex w-10 shrink-0 items-center justify-center text-muted transition',
        stretch ? 'min-h-10 self-stretch' : 'h-10 rounded-lg',
        'hover:bg-surface-2 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    >
      <Navigation className="h-4 w-4" aria-hidden />
    </a>
  );
}
