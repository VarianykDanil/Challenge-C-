// Keeps the field kit up to date (src/offline/fieldKit.ts) for people who log gauges:
// - the list of events they can log against is loaded once the app is open online, so the app can still log today's
//   event if it is next opened with no signal (the same cached list also opens Log gauges and Quick gauges faster);
// - each answer from the server (at most once a minute) starts the kit's inactivity time again, as it does for the
//   session on the server, so opening offline stops at the same time the server would sign the person out.
// Renders nothing.
import { useEffect } from 'react';
import { NETWORK_EVENT, type NetworkEventDetail } from '@/api/client';
import { useLoggableEvents } from '@/features/gauges/loggableEvents';
import { touchKitNow } from './fieldKit';

const TOUCH_EVERY_MS = 60_000;

export function FieldKitSync() {
  useLoggableEvents();
  useEffect(() => {
    let last = 0;
    const onNetwork = (e: Event) => {
      if (!(e as CustomEvent<NetworkEventDetail>).detail?.online || Date.now() - last < TOUCH_EVERY_MS) return;
      last = Date.now();
      touchKitNow();
    };
    window.addEventListener(NETWORK_EVENT, onNetwork);
    return () => window.removeEventListener(NETWORK_EVENT, onNetwork);
  }, []);
  return null;
}
