// Release 1.2 slot — OWNED BY U1 sign-in-pin (laid down by r2-foundation; renders nothing until U1 fills it).
// Team > user (admin): "Reset PIN" for someone else (POST /auth/pin/reset/:userId). Mounted in
// features/team/UserFormModal.tsx next to the two-step reset (editing another person), in an ErrorBoundary with
// fallback={null}. The component checks the caller is an admin.
import type { UserWithTeam } from '@lm/shared';

export interface PinResetSectionProps {
  user: UserWithTeam;
  className?: string;
}

export function PinResetSection(_props: PinResetSectionProps) {
  return null;
}
