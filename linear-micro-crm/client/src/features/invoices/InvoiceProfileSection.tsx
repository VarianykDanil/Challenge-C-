// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// Team → person (admin): the person's supplier details for invoices, and whether they accepted the self-billing
// agreement. Mounted in pages/UserDetail.tsx in the left column after the Pay plan card, administrators only, in an
// ErrorBoundary with fallback={null}. Render a whole Card.
import type { UserWithTeam } from '@lm/shared';

export interface InvoiceProfileSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function InvoiceProfileSection(_props: InvoiceProfileSectionProps) {
  return null;
}
