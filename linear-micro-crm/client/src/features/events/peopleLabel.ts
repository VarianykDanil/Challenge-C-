// Release 1.3.1 UI review (UI-13): who the event header counts. `repCount` is the people who logged gauges, so before
// the day the people booked tell more ("7 booked") and on the day both ("3 logged · 7 booked": not "3 of 7", since the
// Events list's "3 / 6 logged" counts the team's members and walk-ups log too). Pure, tested under Node
// (server/src/test/ui-labels.test.ts), so relative imports only.
import type { SalesEventWithMeta } from '@lm/shared';
import { formatNumber } from '../../lib/format.ts';

export function eventPeopleLabel(ev: Pick<SalesEventWithMeta, 'status' | 'repCount' | 'bookings'>): string {
  const booked = ev.bookings?.booked ?? 0;
  if (booked > 0 && ev.status === 'scheduled') return `${formatNumber(booked)} booked`;
  if (booked > 0 && ev.status === 'live') return `${formatNumber(ev.repCount)} logged · ${formatNumber(booked)} booked`;
  return `${formatNumber(ev.repCount)} rep${ev.repCount === 1 ? '' : 's'}`;
}
