/**
 * Release 1.3.1: database helpers for people that more than one place needs (POST /users, a hire from recruitment, the
 * demo teams), kept free of route code so a database extension can use them.
 */
import { get, type Db } from '../db/connection.ts';

/** The highest number of an `LM-0042` style employee ID in use (0 when there is none). */
export function maxEmployeeNumber(db: Db): number {
  const row = get<{ n: number | null }>(db, `SELECT MAX(CAST(substr(employee_id, 4) AS INTEGER)) AS n FROM users WHERE employee_id LIKE 'LM-%'`);
  return Number(row?.n ?? 0);
}

/** "LM-0042" from 42. */
export function formatEmployeeId(n: number): string {
  return `LM-${String(n).padStart(4, '0')}`;
}

/** The next employee ID after the highest in use ("LM-0035" after LM-0034). */
export function nextEmployeeId(db: Db): string {
  return formatEmployeeId(maxEmployeeNumber(db) + 1);
}

/**
 * ORDER BY for a list of people on a users alias: surname, then first name; someone without a surname sorts by their
 * first name in its place (the shared personSortKey rule), case-insensitively, then by id so the order is stable.
 */
export function personOrderSql(alias = 'u'): string {
  return `COALESCE(NULLIF(TRIM(${alias}.last_name), ''), ${alias}.first_name) COLLATE NOCASE, ${alias}.first_name COLLATE NOCASE, ${alias}.id`;
}
