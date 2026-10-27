// Keeps the field kit's events up to date (src/offline/fieldKit.ts): for people who log gauges, the list of events
// they can log against is loaded once the app is open online, so the app can still log today's event if it is next
// opened with no signal. Renders nothing; the same cached list then also opens Log gauges and Quick gauges faster.
import { useLoggableEvents } from '@/features/gauges/loggableEvents';

export function FieldKitSync() {
  useLoggableEvents();
  return null;
}
