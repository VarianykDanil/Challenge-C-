/**
 * Release 1.3 — OWNED BY P3 statements. Where statement PDFs live on disk.
 *
 * The folder is `statements/` next to the database (server/data/statements/ by default, git-ignored), the same way the
 * app secret and the backups sit next to it; LM_STATEMENTS_DIR moves it. An in-memory database (tests) uses a temp
 * folder unless a test points it elsewhere with configureStatementsDir. Files are named by their SHA-256, so the same PDF
 * stored twice is one file, and a stored path is relative to the folder (moving the data folder keeps it working).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, type Db } from '../../db/connection.ts';

let configured: string | null = null;
let tempDir: string | null = null;

/** Tests: store statement files in `dir` (null: back to the default). */
export function configureStatementsDir(dir: string | null): void {
  configured = dir ? path.resolve(dir) : null;
}

/** The database file, or null for an in-memory database. */
function databaseFile(db: Db): string | null {
  const row = get<{ file: string }>(db, `SELECT file FROM pragma_database_list WHERE name = 'main'`);
  return row?.file ? row.file : null;
}

/** The folder statement PDFs are kept in (not created until a file is written). */
export function statementsDir(db: Db): string {
  if (configured) return configured;
  const env = process.env.LM_STATEMENTS_DIR?.trim();
  if (env) return path.resolve(env);
  const file = databaseFile(db);
  if (file) return path.join(path.dirname(file), 'statements');
  tempDir ??= mkdtempSync(path.join(os.tmpdir(), 'linear-statements-'));
  return tempDir;
}

export const sha256Of = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

/** Writes the PDF (once per content) and returns its path relative to the folder and its SHA-256. */
export function saveStatementFile(db: Db, buf: Uint8Array): { relPath: string; sha256: string } {
  const sha256 = sha256Of(buf);
  const relPath = `${sha256}.pdf`;
  const dir = statementsDir(db);
  const full = path.join(dir, relPath);
  if (!existsSync(full)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, full);
  }
  return { relPath, sha256 };
}

/** The absolute path of a stored file, or null when the path would leave the folder (never trusted blindly). */
export function statementFilePath(db: Db, relPath: string | null): string | null {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return null;
  const dir = statementsDir(db);
  const full = path.resolve(dir, relPath);
  return full.startsWith(dir + path.sep) ? full : null;
}

export function readStatementFile(db: Db, relPath: string | null): Buffer | null {
  const full = statementFilePath(db, relPath);
  if (!full || !existsSync(full)) return null;
  return readFileSync(full);
}

/** Removes a stored file unless another statement still points at it. */
export function removeStatementFileIfUnused(db: Db, relPath: string | null): void {
  if (!relPath) return;
  const used = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM statements WHERE file_path = ?`, [relPath])?.n ?? 0;
  if (used > 0) return;
  const full = statementFilePath(db, relPath);
  if (full) rmSync(full, { force: true });
}
