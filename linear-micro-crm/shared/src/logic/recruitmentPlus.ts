/**
 * Release 1.3 — OWNED BY P7 recruitment-plus (laid down by r3-foundation). Pure rules for the recruitment additions:
 * a candidate's age from the date of birth, the "Under 18" warning, the timeline order. P7 fills and extends.
 */
import { CANDIDATE_ADULT_AGE } from '../types/recruitmentPlus.ts';
import { isValidISODate } from './dates.ts';

/** Whole years between `dateOfBirth` and `today` (both YYYY-MM-DD); null when either is not a valid date. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  if (!isValidISODate(dateOfBirth) || !isValidISODate(today) || dateOfBirth > today) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** True when the candidate is under 18 on `today`. */
export function isUnderAge(dateOfBirth: string, today: string): boolean {
  const age = ageOn(dateOfBirth, today);
  return age !== null && age < CANDIDATE_ADULT_AGE;
}
