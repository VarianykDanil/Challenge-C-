// Release 1.2 (UI fix group UC): day headings for the audit trail. Always the date itself, never "Today", "Yesterday"
// or "Tomorrow": audit times are the real clock while the rest of the app may run on a pinned demo clock, and a date
// read on its own is the plain record. The year is added for a day outside the current year.
import { format, isValid, parseISO } from 'date-fns';

/** "2026-10-21" → "Wednesday 21 October" ("Tuesday 21 October 2025" for another year). */
export function auditDayHeading(day: string, now: Date = new Date()): string {
  const d = parseISO(day);
  if (!isValid(d)) return day;
  return format(d, d.getFullYear() === now.getFullYear() ? 'EEEE d MMMM' : 'EEEE d MMMM yyyy');
}
