/**
 * Release 1.3 — OWNED BY P8 venue-insights (laid down by r3-foundation). Venues repeat across events, so every per-venue
 * figure is keyed by venueKey(venue, city) — STABLE (the URL /venues/:key and the server's grouping use it).
 * P8 adds the plan maths (the blend of own and venue ratios) here.
 */

/** "St Peter's Square" → "st-peters-square": lower case, & → and, apostrophes dropped, anything else → "-". */
export function venueSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The venue's key: the venue and the city slugs joined by "--" ("Golden Square", "Manchester" →
 * "golden-square--manchester"), so the same place is one venue however it was typed (case, spacing, punctuation).
 */
export function venueKey(venue: string, city: string): string {
  return `${venueSlug(venue)}--${venueSlug(city)}`;
}

/** True for a string venueKey could have produced. */
export function isVenueKey(key: string): boolean {
  return key.length <= 240 && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?--(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(key);
}
