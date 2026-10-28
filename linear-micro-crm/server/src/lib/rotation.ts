/**
 * The keep-30-days-then-8-weeks rule shared by the local backups (lib/backup.ts) and the off-site copies
 * (lib/offsite.ts), and the Europe/London wall-clock time their names use.
 */
import { addDays, mondayOf } from './dates.ts';

export const ROTATION = {
  /** Keep the newest file of each of this many days, today included… */
  dailyDays: 30,
  /** …plus the newest file of each of this many ISO weeks before those days. */
  weeklyWeeks: 8,
} as const;

/** `linear-2026-10-19-0200.sqlite`: date and HHmm in Europe/London wall-clock time. */
export const BACKUP_FILE_RE = /^linear-(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))-([01]\d|2[0-3])([0-5]\d)\.sqlite$/;

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Europe/London wall-clock parts of an instant (independent of the process TZ). */
export function londonParts(at: Date): { date: string; hour: number; minute: number; second: number } {
  const p: Record<string, string> = {};
  for (const part of LONDON.formatToParts(at)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

export interface RotationPlan {
  keep: string[];
  remove: string[];
}

/**
 * Which files to keep on `today` (London date): the newest file of each of the last 30 days, plus the newest file of
 * each of the 8 ISO weeks before those days. The newest file overall is always kept, and names that do not match
 * `pattern` (whose first group is the date) are left out of both lists (never removed).
 */
export function planRotation(names: readonly string[], today: string, pattern: RegExp = BACKUP_FILE_RE): RotationPlan {
  const windowStart = addDays(today, -(ROTATION.dailyDays - 1));
  const lastWeek = mondayOf(addDays(windowStart, -1));
  const firstWeek = addDays(lastWeek, -7 * (ROTATION.weeklyWeeks - 1));
  const files = names.filter((n) => pattern.test(n)).sort().reverse();
  const seen = new Set<string>();
  const keep: string[] = [];
  const remove: string[] = [];
  files.forEach((name, i) => {
    const date = pattern.exec(name)![1]!;
    let bucket: string | null;
    if (date >= windowStart) bucket = `day:${date}`;
    else {
      const monday = mondayOf(date);
      bucket = monday >= firstWeek ? `week:${monday}` : null;
    }
    if (i === 0 || (bucket !== null && !seen.has(bucket))) {
      if (bucket) seen.add(bucket);
      keep.push(name);
    } else {
      remove.push(name);
    }
  });
  return { keep, remove };
}
