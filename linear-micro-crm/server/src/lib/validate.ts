import type { Request } from 'express';
import { z } from 'zod';
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
