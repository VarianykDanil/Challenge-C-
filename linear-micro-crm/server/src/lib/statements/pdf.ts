/**
 * Release 1.3 — OWNED BY P3 statements. A statement PDF's positioned text, read with pdfjs-dist in a worker thread
 * (./pdfWorker.ts: legacy build, no fonts loaded, no XFA; pdfjs-dist 6 never compiles code from a PDF).
 * The worker is started on first use (pdfjs takes about a second to load, so the server starts as fast as before) and
 * kept for the next PDF; it never keeps the process alive while idle. A read that takes longer than 30 seconds
 * ends the worker outright (a hostile PDF cannot stall the server's main thread) and the next read starts a fresh one.
 * Problems come back as StatementReadError with a plain sentence the statement page shows.
 */
import { Worker } from 'node:worker_threads';
import type { PdfTextItem } from '@lm/shared';

/** The first pages are enough for any commission statement; a 500-page file is not one. */
export const STATEMENT_MAX_PAGES = 40;
const READ_TIMEOUT_MS = 30_000;
let readTimeoutMs = READ_TIMEOUT_MS;

/** Tests: a shorter read timeout (null: back to 30 s). */
export function configurePdfReadTimeout(ms: number | null): void {
  readTimeoutMs = ms ?? READ_TIMEOUT_MS;
}

export class StatementReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementReadError';
  }
}

/** True when the bytes start like a PDF ("%PDF-" in the first kilobyte, as readers allow). */
export function looksLikePdf(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

type Reply = { id: number; ok: true; items: PdfTextItem[]; pages: number } | { id: number; ok: false; name: string; message: string };

interface Job {
  resolve: (r: Reply) => void;
  reject: (err: Error) => void;
}

/** A worker thread and the reads waiting on it. */
interface PdfWorker {
  thread: Worker;
  jobs: Map<number, Job>;
}

let current: PdfWorker | null = null;
let nextId = 1;

/** A read is over: forget it; an idle worker never keeps the process alive. */
function settle(pw: PdfWorker, id: number): void {
  pw.jobs.delete(id);
  if (!pw.jobs.size) pw.thread.unref();
}

function pdfWorker(): PdfWorker {
  if (current) return current;
  const pw: PdfWorker = { thread: new Worker(new URL('./pdfWorker.ts', import.meta.url)), jobs: new Map() };
  pw.thread.on('message', (reply: Reply) => {
    const job = pw.jobs.get(reply.id);
    if (!job) return;
    settle(pw, reply.id);
    job.resolve(reply);
  });
  // a worker that fails or is ended fails only the reads waiting on it
  const fail = (err: Error) => {
    if (current === pw) current = null;
    const waiting = [...pw.jobs.values()];
    pw.jobs.clear();
    pw.thread.unref();
    for (const job of waiting) job.reject(err);
  };
  pw.thread.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
  pw.thread.on('exit', () => fail(new Error('The PDF reader stopped.')));
  current = pw;
  return pw;
}

/** Ends the PDF worker (tests finishing). The next read starts a new one. */
export async function stopPdfWorker(): Promise<void> {
  const pw = current;
  current = null;
  if (pw) await pw.thread.terminate();
}

const unreadable = (name: string): StatementReadError => {
  if (name === 'PasswordException') return new StatementReadError('This PDF is password-protected. Ask the client for a copy without a password, then upload it.');
  if (name === 'InvalidPDFException' || name === 'FormatError') return new StatementReadError('This PDF is damaged or not one Linear Hub can read. Ask the client to send it again.');
  return new StatementReadError('Linear Hub could not read this PDF. Ask the client to send it again, or upload it yourself.');
};

/** Every text item of the first STATEMENT_MAX_PAGES pages, with its position (PDF points; y grows upwards). */
export async function extractPdfItems(buf: Uint8Array): Promise<{ items: PdfTextItem[]; pages: number }> {
  if (!looksLikePdf(buf)) throw new StatementReadError('This file is not a PDF.');
  const data = new Uint8Array(buf); // a copy of its own, handed to the worker
  const id = nextId++;
  const pw = pdfWorker();
  pw.thread.ref(); // a read in progress keeps the process alive until it answers
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await new Promise<Reply>((resolve, reject) => {
      pw.jobs.set(id, { resolve, reject });
      timer = setTimeout(() => {
        settle(pw, id);
        reject(new StatementReadError('Reading this PDF took too long. Try uploading it again, or ask the client for a simpler copy.'));
        // the only way to stop a parser that is stuck: end its thread (the next read starts a fresh one)
        if (current === pw) current = null;
        void pw.thread.terminate();
      }, readTimeoutMs);
      timer.unref();
      pw.thread.postMessage({ id, data, maxPages: STATEMENT_MAX_PAGES }, [data.buffer as ArrayBuffer]);
    });
    if (!reply.ok) throw unreadable(reply.name);
    return { items: reply.items, pages: reply.pages };
  } catch (err) {
    if (err instanceof StatementReadError) throw err;
    throw unreadable('');
  } finally {
    clearTimeout(timer);
  }
}
