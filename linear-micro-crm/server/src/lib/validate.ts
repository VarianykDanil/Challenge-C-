import type { Request } from 'express';
import { z } from 'zod';
import { EVENT_MAX_TARGET_SALES, GAUGE_MAX_PER_DAY, MONEY_MAX } from '@lm/shared';
import { badRequest } from './errors.ts';
import { diffDays, isISODate } from './dates.ts';

/**
 * A field's own message for when it is missing, as in `z.string(missing('Paste the link'))`. A value of the wrong type
 * still gets the plain default message.
 */
export function missing(message: string) {
  return { error: (issue: { input?: unknown }) => (issue.input === undefined ? message : undefined) };
}

/**
 * The fields a PATCH sends, checked by `schema` with every field optional. Only the keys the body really has come
 * back: zod fills in a field's default even when the field is optional, so `schema.partial().parse(body)` on its own
 * would turn `{ firstName }` into `{ firstName, status: 'active', teamId: null, … }` and overwrite what is saved.
 */
export function parsePatch<T extends z.ZodObject>(schema: T, body: unknown): Partial<z.output<T>> {
  const parsed = schema.partial().parse(body) as Record<string, unknown>;
  const sent = body !== null && typeof body === 'object' ? body : {};
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(sent, key))) as Partial<z.output<T>>;
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  tuple: 'a list',
  object: 'a set of fields',
  date: 'a date',
};

type Issue = {
  code?: string;
  input?: unknown;
  expected?: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  exact?: boolean;
  format?: string;
  values?: readonly unknown[];
  keys?: readonly string[];
  divisor?: number | bigint;
};

/**
 * zod's own messages in plain words, for the problems a schema gives no message of its own (createApp switches this
 * on with z.config). Anything not listed here keeps zod's wording.
 */
export function plainMessage(issue: Issue): string | undefined {
  const isText = issue.origin === 'string';
  const isList = issue.origin === 'array' || issue.origin === 'set';
  const isNumber = issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint';
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Required';
      return issue.expected && TYPE_WORDS[issue.expected] ? `Expected ${TYPE_WORDS[issue.expected]}` : undefined;
    case 'too_small': {
      const n = Number(issue.minimum);
      if (isText) return issue.exact ? `Use exactly ${n} characters` : n <= 1 ? 'Required' : `Use at least ${n} characters`;
      if (isList) return issue.exact ? `Exactly ${n}` : n <= 1 ? 'Add at least one' : `Add at least ${n}`;
      if (isNumber) return issue.inclusive === false ? `Must be more than ${n}` : `Must be ${n} or more`;
      return undefined;
    }
    case 'too_big': {
      const n = Number(issue.maximum);
      if (isText) return issue.exact ? `Use exactly ${n} characters` : `Use at most ${n} characters`;
      if (isList) return issue.exact ? `Exactly ${n}` : `At most ${n}`;
      if (isNumber) return issue.inclusive === false ? `Must be less than ${n}` : `Must be ${n} or less`;
      return undefined;
    }
    case 'invalid_format':
      return issue.format === 'email' ? 'Enter a valid email address' : 'Not in the expected format';
    case 'invalid_value': {
      const values = issue.values ?? [];
      return values.length > 0 && values.length <= 8 ? `Choose one of: ${values.map(String).join(', ')}` : 'Not one of the choices';
    }
    case 'not_multiple_of':
      return `Must be a multiple of ${issue.divisor}`;
    case 'unrecognized_keys':
      return `Not expected here: ${(issue.keys ?? []).join(', ')}`;
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
      return 'Not a valid value';
    case 'custom':
      return 'Not valid';
    default:
      return undefined;
  }
}

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
