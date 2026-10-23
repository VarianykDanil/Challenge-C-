// Release 1.2 — OWNED BY U1 sign-in-pin. Wraps the signed-in shell (App.tsx ShellLayout).
//  - While the signed-in user must still create a PIN (`user.pinSetupRequired`), it shows the full-screen
//    "Create your PIN" step instead of the app.
//  - Then, for anyone who must use two-step verification and has not set it up (`twoFactorSetupRequired`; release 1.4:
//    every account but the demo sign-in ones, client accounts included — App.tsx wraps the client portal in this gate
//    too), the "Set up two-step verification" step. Once its setup modal opens it stays on screen until the modal
//    closes, even though /auth/me stops asking for it the moment the code is accepted: the recovery codes are shown
//    exactly once, in that modal.
// An already open session learns of a new requirement through `PIN_SETUP_REQUIRED_EVENT` (api/client.ts): it fires
// when any API answers 403 { pinSetupRequired: true } or (1.4) { twoFactorSetupRequired: true }; the gate then re-reads
// /auth/me (one request at a time) and shows the step without a reload. Both steps are lazy, so the main chunk stays
// under 460 kB.
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { PIN_SETUP_REQUIRED_EVENT } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { FullPageSpinner } from '@/features/common/FullPageSpinner';

const CreatePinStep = lazy(() => import('./PinSetupStep').then((m) => ({ default: m.CreatePinStep })));
const TwoFactorRequiredStep = lazy(() => import('./PinSetupStep').then((m) => ({ default: m.TwoFactorRequiredStep })));

export interface PinSetupGateProps {
  children: ReactNode;
}

export function PinSetupGate({ children }: PinSetupGateProps) {
  const { user, refresh } = useAuth();
  const refreshing = useRef(false);
  /** True while the two-step setup modal is open: the step stays up until it closes (see the header). */
  const [holdTwoFactor, setHoldTwoFactor] = useState(false);
  const twoFactorRequired = Boolean(user?.twoFactorSetupRequired);

  useEffect(() => {
    const onRequired = () => {
      if (refreshing.current) return; // a page of failing cards fires this many times at once
      refreshing.current = true;
      void refresh().finally(() => {
        refreshing.current = false;
      });
    };
    window.addEventListener(PIN_SETUP_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(PIN_SETUP_REQUIRED_EVENT, onRequired);
  }, [refresh]);

  if (user?.pinSetupRequired) {
    return (
      <Suspense fallback={<FullPageSpinner />}>
        <CreatePinStep />
      </Suspense>
    );
  }
  if (user && (twoFactorRequired || holdTwoFactor)) {
    return (
      <Suspense fallback={<FullPageSpinner />}>
        <TwoFactorRequiredStep
          onStart={() => setHoldTwoFactor(true)}
          onDone={() => {
            setHoldTwoFactor(false);
            void refresh();
          }}
        />
      </Suspense>
    );
  }
  return <>{children}</>;
}
