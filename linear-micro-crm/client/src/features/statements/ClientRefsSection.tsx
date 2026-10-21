// Release 1.3 slot — OWNED BY P3 statements (laid down by r3-foundation; renders nothing until P3 statements fills it).
// Team → person → "Client IDs" (admin): the person's fundraiser ID at each client, used to match statement rows.
// Mounted in pages/UserDetail.tsx in the left column after the invoice details, administrators only, in an
// ErrorBoundary with fallback={null}. Render a whole Card.
import type { UserWithTeam } from '@lm/shared';

export interface ClientRefsSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function ClientRefsSection(_props: ClientRefsSectionProps) {
  return null;
}
