// Release 1.2 slot — OWNED BY L1 learning-pack (laid down by r2-foundation; renders nothing until L1 fills it).
// The dashboard strip "Your next level: 12 of 14 sales this week; 9 of 21 lessons learned" (GET
// /learning/progression/:me), linking to /learning/progress. Mounted in pages/Dashboard.tsx for reps and leaders, under
// the KPI tiles and the week's pay estimate, in an ErrorBoundary with fallback={null}; `className` carries the
// spacing above it (mt-3) so nothing moves while it renders null.
export interface ProgressCardProps {
  className?: string;
}

export function ProgressCard(_props: ProgressCardProps) {
  return null;
}
