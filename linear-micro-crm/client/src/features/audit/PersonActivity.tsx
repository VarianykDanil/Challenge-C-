// Release 1.3 slot — OWNED BY P9 audit-everything (laid down by r3-foundation; renders nothing until P9 audit-everything fills it).
// Team → person → Activity (admin): that person's timeline from the audit trail (changes, sign-ins, exports, opened
// records). Mounted in pages/UserDetail.tsx in the right column under the performance panel, administrators only, in
// an ErrorBoundary with fallback={null}. Render a whole Card.
import type { UserWithTeam } from '@lm/shared';

export interface PersonActivityProps {
  user: UserWithTeam;
  className?: string;
}

export function PersonActivity(_props: PersonActivityProps) {
  return null;
}
