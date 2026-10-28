/**
 * Schema upgrades are all-or-nothing: createSchema runs the core schema and every extension's upgrade in one
 * transaction, so an upgrade that fails half-way leaves the database exactly as it was (and the next start tries
 * again from the same place), instead of a database with some of the new tables and columns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, openDb } from '../db/connection.ts';
import { createSchema } from '../db/schema.ts';

const tableCount = (db: ReturnType<typeof openDb>) =>
  Number(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`)?.n ?? 0);

test('an upgrade that fails part-way changes nothing (no half-upgraded database)', () => {
  const db = openDb(':memory:');
  // A view in the way of the LAST extension (payments) makes its CREATE INDEX fail after every other table exists.
  db.exec('CREATE VIEW payment_items AS SELECT 1 AS x');
  assert.throws(() => createSchema(db), /views may not be indexed/);
  assert.equal(db.isTransaction, false, 'the transaction was closed');
  assert.equal(tableCount(db), 0, 'none of the tables created before the failure were kept');

  // once the obstacle is gone the same call upgrades fully
  db.exec('DROP VIEW payment_items');
  createSchema(db);
  assert.ok(tableCount(db) > 40);
  assert.deepEqual(createSchema(db), [], 'a second run changes nothing');
});

test('createSchema still works inside a caller’s own transaction (it nests instead of failing)', () => {
  const db = openDb(':memory:');
  db.exec('BEGIN');
  createSchema(db);
  db.exec('COMMIT');
  assert.ok(tableCount(db) > 40);
});
