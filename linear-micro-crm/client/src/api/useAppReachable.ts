// Whether the last request reached Linear Hub, as React state (api/client.ts appReachable, updated by every answer and
// every "can't reach Linear Hub"). Pages use it to fall back to what the phone has without waiting for a time-out.
import { useSyncExternalStore } from 'react';
import { NETWORK_EVENT, appReachable } from './client';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(NETWORK_EVENT, onChange);
  return () => window.removeEventListener(NETWORK_EVENT, onChange);
}

export function useAppReachable(): boolean {
  return useSyncExternalStore(subscribe, appReachable, () => true);
}
