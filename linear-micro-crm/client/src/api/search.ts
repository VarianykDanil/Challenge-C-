// Release 1.2 — U5 office-tools hooks — OWNED BY U5 (laid down by r2-foundation). Endpoints: server/src/routes/search.ts
// and server/src/routes/payExport.ts.
import { useQuery } from '@tanstack/react-query';
import { SEARCH_MIN_LENGTH, normaliseSearchQuery, type PayExportFormat, type SearchResponse } from '@lm/shared';
import { api, qs } from './client';

export const searchKeys = {
  all: ['search'] as const,
  query: (q: string) => ['search', q] as const,
};

/** GET /search?q= — runs only from SEARCH_MIN_LENGTH characters (debounce the input before passing it in). */
export function useSearch(q: string, { enabled = true }: { enabled?: boolean } = {}) {
  const query = normaliseSearchQuery(q);
  return useQuery({
    queryKey: searchKeys.query(query),
    queryFn: () => api<SearchResponse>(`/search${qs({ q: query })}`),
    enabled: enabled && query.length >= SEARCH_MIN_LENGTH,
    staleTime: 20_000,
  });
}

/** The download URL of GET /finance/payroll/export (admin): use as an <a href download> or window.location. */
export function payExportUrl(weekStart: string, format: PayExportFormat): string {
  return `/api/finance/payroll/export${qs({ weekStart, format })}`;
}
