/**
 * The database connection: the settings every connection gets (wait for a lock instead of failing, full durability)
 * and transaction() that can be nested safely (an inner block never commits or ends the outer one).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { all, get, openDb, run, transaction } from './connection.ts';

function tempDb(): { file: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-conn-'));
  return { file: path.join(dir, 'test.sqlite'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('openDb settings', () => {
  test('waits up to 5 s for a lock (busy_timeout) and uses synchronous=FULL in WAL mode', () => {
    const t = tempDb();
    const db = openDb(t.file);
    try {
      assert.equal(get<{ timeout: number }>(db, 'PRAGMA busy_timeout')?.timeout, 5000);
      // 2 = FULL: a commit is on the disk before it is acknowledged, so a power cut does not roll it back
      assert.equal(get<{ synchronous: number }>(db, 'PRAGMA synchronous')?.synchronous, 2);
      assert.equal(get<{ journal_mode: string }>(db, 'PRAGMA journal_mode')?.journal_mode, 'wal');
      assert.equal(get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys, 1);
    } finally {
      db.close();
      t.done();
    }
  });

  test('a save waits for another process that holds the write lock briefly, instead of failing with "database is locked"', async () => {
    const t = tempDb();
    const db = openDb(t.file);
    db.exec('CREATE TABLE t (v INTEGER)');
    // another process (a backup command, pin:reset) takes the write lock and lets go after 300 ms
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const d = new DatabaseSync(process.argv[1]);
         d.exec('BEGIN IMMEDIATE'); d.exec('INSERT INTO t VALUES (1)');
         process.stdout.write('locked\\n');
         setTimeout(() => { d.exec('COMMIT'); d.close(); }, 300);`,
        t.file,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (b: Buffer) => b.toString().includes('locked') && resolve());
        holder.on('exit', () => reject(new Error('the lock holder ended early')));
      });
      const started = performance.now();
      run(db, 'INSERT INTO t VALUES (2)'); // blocks until the other process commits
      assert.ok(performance.now() - started >= 100, 'it waited for the lock');
      assert.deepEqual(all<{ v: number }>(db, 'SELECT v FROM t ORDER BY v').map((r) => r.v), [1, 2]);
    } finally {
      holder.kill();
      db.close();
      t.done();
    }
  });
});

describe('transaction()', () => {
  const fresh = () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    return db;
  };
  const values = (db: DatabaseSync) => all<{ v: number }>(db, 'SELECT v FROM t ORDER BY v').map((r) => r.v);

  test('commits on success and rolls back on a throw', () => {
    const db = fresh();
    transaction(db, () => run(db, 'INSERT INTO t VALUES (1)'));
    assert.throws(() =>
      transaction(db, () => {
        run(db, 'INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    );
    assert.deepEqual(values(db), [1]);
    assert.equal(db.isTransaction, false);
  });

  test('a nested block does not commit the outer one: an outer throw after it undoes both', () => {
    const db = fresh();
    assert.throws(() =>
      transaction(db, () => {
        run(db, 'INSERT INTO t VALUES (1)');
        transaction(db, () => run(db, 'INSERT INTO t VALUES (2)'));
        // still inside the outer transaction after the inner one finished
        assert.equal(db.isTransaction, true);
        throw new Error('outer fails after the inner block');
      }),
      /outer fails after the inner block/,
    );
    assert.deepEqual(values(db), []);
    assert.equal(db.isTransaction, false);
  });

  test('a nested block that throws undoes only its own writes when the outer block catches it', () => {
    const db = fresh();
    transaction(db, () => {
      run(db, 'INSERT INTO t VALUES (1)');
      assert.throws(
        () =>
          transaction(db, () => {
            run(db, 'INSERT INTO t VALUES (2)');
            throw new Error('inner fails');
          }),
        /inner fails/,
      ); // the outer block carries on
      run(db, 'INSERT INTO t VALUES (3)');
    });
    assert.deepEqual(values(db), [1, 3]);
  });

  test('three levels deep, and a transaction someone else began with BEGIN is joined, not committed', () => {
    const db = fresh();
    transaction(db, () => {
      transaction(db, () => {
        transaction(db, () => run(db, 'INSERT INTO t VALUES (1)'));
      });
    });
    assert.deepEqual(values(db), [1]);

    db.exec('BEGIN');
    transaction(db, () => run(db, 'INSERT INTO t VALUES (2)'));
    assert.equal(db.isTransaction, true, 'the caller still owns its BEGIN');
    db.exec('ROLLBACK');
    assert.deepEqual(values(db), [1]);
  });

  test('returns the value of the block at every level', () => {
    const db = fresh();
    const out = transaction(db, () => transaction(db, () => 42));
    assert.equal(out, 42);
  });
});
