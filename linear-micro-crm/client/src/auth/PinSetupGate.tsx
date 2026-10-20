// Release 1.2 slot — OWNED BY U1 sign-in-pin (laid down by r2-foundation; passes its children through until U1 fills it).
// Wraps the signed-in shell (App.tsx ShellLayout). While the signed-in user must still create a PIN
// (`user.pinSetupRequired`), U1 renders the full-screen "Create your PIN" step instead of the app. Lazy-load the step
// so the main chunk stays under 460 kB.
// An already open session learns of the requirement through `PIN_SETUP_REQUIRED_EVENT` (api/client.ts): it fires
// when any API answers 403 { pinSetupRequired: true }; listen for it here and call `useAuth().refresh()` so
// /auth/me returns `pinSetupRequired` and this gate shows the step without a reload.
import type { ReactNode } from 'react';

export interface PinSetupGateProps {
  children: ReactNode;
}

export function PinSetupGate({ children }: PinSetupGateProps) {
  return <>{children}</>;
}
