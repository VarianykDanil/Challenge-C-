// Release 1.2 slot — OWNED BY U1 sign-in-pin (laid down by r2-foundation; passes its children through until U1 fills it).
// Wraps the signed-in shell (App.tsx ShellLayout). While the signed-in user must still create a PIN
// (`user.pinSetupRequired`), U1 renders the full-screen "Create your PIN" step instead of the app. Lazy-load the step
// so the main chunk stays under 460 kB.
import type { ReactNode } from 'react';

export interface PinSetupGateProps {
  children: ReactNode;
}

export function PinSetupGate({ children }: PinSetupGateProps) {
  return <>{children}</>;
}
