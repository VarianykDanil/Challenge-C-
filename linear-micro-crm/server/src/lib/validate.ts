import type { Request } from 'express';
import { z } from 'zod';
import { EVENT_MAX_TARGET_SALES, GAUGE_MAX_PER_DAY, MONEY_MAX } from '@lm/shared';
import { badRequest } from './errors.ts';
import { diffDays, isISODate } from './dates.ts';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date formatted YYYY-MM-DD')
  .refine(isISODate, 'Invalid calendar date');

export const timeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time formatted HH:MM');

export const isoTimestamp = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Expected an ISO 8601 timestamp');

export const positiveInt = z.coerce.number().int().positive();
export const nonNegativeInt = z.coerce.number().int().min(0);
/**
 * Strict (no coercion: `true`, `''`, `null` are rejected, not turned into 1 / 0) finite whole numbers with
 * plausibility ceilings — one rep cannot stop more than `GAUGE_MAX_PER_DAY` people in a day, an event target tops
 * out at `EVENT_MAX_TARGET_SALES`, and a money amount at `MONEY_MAX` — so a typo with extra zeros (or `1e308`) can
 * never turn every aggregate, the leaderboard and payroll into nonsense.
 */
export const gaugeCount = z.number().finite().int().min(0).max(GAUGE_MAX_PER_DAY);
export const targetSalesCount = z.number().finite().int().min(0).max(EVENT_MAX_TARGET_SALES);
/** A positive money amount in pounds (an expense, a per-sale payout). */
export const moneyAmount = z.number().finite().positive().max(MONEY_MAX);
/** A money rate that may be zero (a commission that is not paid on some campaign). */
export const moneyRate = z.number().finite().min(0).max(MONEY_MAX);
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like #4F46E5');

/** No range may start before this date … */
export const MIN_RANGE_DATE = '2020-01-01';
/** … or span more than this many days (daily trends allocate one point per day, weekly summaries run 3 queries per week). */
export const MAX_RANGE_DAYS = 400;
/** Hard ceiling for `limit` query params. */
export const MAX_LIMIT = 500;

/** Numeric `:id` route param. */
export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`Invalid ${name}`);
  return id;
}

const rangeSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/** `from`/`to` query params with defaults; validates order, the 2020-01-01 floor and the 400-day span cap. */
export function parseRange(query: unknown, defaults: { from: string; to: string }): { from: string; to: string } {
  const q = rangeSchema.parse(query);
  const from = q.from ?? defaults.from;
  const to = q.to ?? defaults.to;
  if (from > to) throw badRequest('`from` must be on or before `to`');
  if (from < MIN_RANGE_DATE) throw badRequest(`Dates before ${MIN_RANGE_DATE} are not supported`);
  if (diffDays(from, to) > MAX_RANGE_DAYS) throw badRequest(`Date range too large (max ${MAX_RANGE_DAYS} days)`);
  return { from, to };
}

/** Optional `limit` query param: `fallback` when missing or not a positive number, never more than MAX_LIMIT. */
export function limitQuery(value: unknown, fallback = MAX_LIMIT): number {
  const n = value === undefined || value === null || value === '' ? NaN : Math.floor(Number(value));
  const chosen = Number.isFinite(n) && n >= 1 ? n : fallback;
  return Math.min(chosen, MAX_LIMIT);
}

/**
 * Optional `offset` query param for paging: a non-negative integer, 0 when missing; `400` otherwise. A safe integer
 * only: `99999999999999999999` would reach SQLite as a REAL and fail `OFFSET ?` with "datatype mismatch" (a 500).
 */
export function offsetQuery(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest('Invalid offset');
  return n;
}

/** Optional positive-integer query param (ignores empty strings). */
export function optionalIdQuery(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${name}`);
  return n;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}
