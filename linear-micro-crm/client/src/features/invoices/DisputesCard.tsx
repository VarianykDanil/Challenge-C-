// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// Finance → Company → Disputes (admin): every disputed invoice with the reason, the lines, the person's numbers vs ours,
// links to the gauges and statement rows; "Fix and reissue" / "Keep as it is". Mounted in pages/Finance.tsx (P1's) at the
// top of the Company tab, in an ErrorBoundary with fallback={null}. Render a whole Card, or nothing when there are none.
export interface DisputesCardProps {
  className?: string;
}

export function DisputesCard(_props: DisputesCardProps) {
  return null;
}
