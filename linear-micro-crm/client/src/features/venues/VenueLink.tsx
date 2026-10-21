// Release 1.3 slot — OWNED BY P8 venue-insights (laid down by r3-foundation; renders nothing until P8 venue-insights fills it).
// A link from an event's venue to its profile (/venues/:key, shared venueKey(venue, city)). Mounted in
// pages/EventDetail.tsx in the header's venue line, after the directions link, in an ErrorBoundary with
// fallback={null}. Inline element only, a 40 px target on phones.
export interface VenueLinkProps {
  venue: string;
  city: string;
  className?: string;
}

export function VenueLink(_props: VenueLinkProps) {
  return null;
}
