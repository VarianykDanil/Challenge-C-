// Release 1.2 — U2 bulk-entry hooks — OWNED BY U2 (laid down by r2-foundation). Endpoint: server/src/routes/bulkGauges.ts.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BulkGaugeInput, BulkGaugeResult } from '@lm/shared';
import { api } from './client';

/** POST /gauges/bulk — all rows or nothing; a 400 carries `details.rows` (BulkRowError[]) on the ApiError. */
export function useBulkGauges() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkGaugeInput) => api<BulkGaugeResult>('/gauges/bulk', { method: 'POST', json: input }),
    onSuccess: () => {
      // the same refresh as a single gauge write (api/hooks.ts invalidateGaugeRelated)
      for (const queryKey of [['gauges'], ['events'], ['dashboard'], ['leaderboard'], ['users', 'performance'], ['finance']]) void qc.invalidateQueries({ queryKey });
    },
  });
}
