// "Needs attention" dashboard card — OWNED BY p5-needs-attention-feed.
// Stub from p1: renders nothing and fetches nothing. Mounted at the top of the dashboard for every role, inside an
// ErrorBoundary. p5 reads useAttention() itself (same query as the bell): up to 5 rows (severity icon, title, body,
// link) with 'Show all'; when empty a single 'All caught up' line. No outer margin needed: the dashboard's space-y-8
// column spaces the card.
export interface AttentionCardProps {
  /** Rows shown before 'Show all' (default 5). */
  max?: number;
}

export function AttentionCard(_props: AttentionCardProps) {
  return null;
}
