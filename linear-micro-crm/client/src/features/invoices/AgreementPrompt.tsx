// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// The self-billing agreement, shown once to each field person who has not accepted the current version (a modal over
// any page). Mounted once in components/layout/AppShell.tsx in the sticky banner row, after the check-in outbox, in an
// ErrorBoundary with fallback={null}. Load its modal lazily (the shell is in the main chunk).
import type { UserWithTeam } from '@lm/shared';

export interface AgreementPromptProps {
  user: UserWithTeam;
}

export function AgreementPrompt(_props: AgreementPromptProps) {
  return null;
}
