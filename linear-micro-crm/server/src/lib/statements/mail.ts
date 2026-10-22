/**
 * Release 1.3 — OWNED BY P3 statements. Matt's Gmail, read with an app password over IMAP (imapflow), READ-ONLY:
 *
 *  - Settings live in meta `ext:statements:mail` (JSON): the address, the app password ENCRYPTED with the app-secret key
 *    (lib/crypto.ts encrypt / decrypt), whether the 15-minute check is on, the last check, the last error in plain
 *    words, when a statement was last fetched, and where the check got to (the mailbox, its UIDVALIDITY, the last UID).
 *    readMailSettings() is what the API returns: never the password, only whether one is saved.
 *  - The mail source opens "All Mail" (Gmail's \All folder, so archived or labelled mail is found too; INBOX when there
 *    is none) with EXAMINE — read-only: nothing is flagged, moved, marked read or deleted — searches for messages FROM
 *    the statement senders with a UID above the last one seen (on the first check: the last STATEMENT_FIRST_CHECK_DAYS
 *    days), downloads each, and logs out. Tests replace the source with setMailSource (no real Gmail in tests).
 *  - checkMail(db): every PDF attachment of those messages goes through ingestStatement (the same path as an upload),
 *    keyed "<Message-ID>#<n>" so an attachment is stored once. A message is read only when its From address is a listed
 *    sender (no From: skipped). A statement applies itself only when it is ready AND Gmail confirmed the sender: the
 *    topmost Authentication-Results header (Gmail's own, mx.google.com) says dkim=pass or dmarc=pass for the From
 *    address's domain (senderAuthenticated). Anything else waits for the office with a warning, because a From address
 *    can be faked. An email that fails to process is tried again on the next checks (the UID cursor stops before it),
 *    MAIL_RETRIES times, then skipped with a message. Audited as "Linear Hub" (statements.fetch, statements.mail_error).
 *  - testMailConnection(db): one test at a time (a test already running is shared) and at most one every
 *    MAIL_TEST_EVERY_MS: a quicker press answers the last result, so pressing Test connection repeatedly never makes
 *    Google throttle the account.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { STATEMENT_CHECK_EVERY_MINUTES, STATEMENT_FIRST_CHECK_DAYS, STATEMENT_MAX_BYTES, formatStatementPeriod, type CheckNowResult, type MailSettings, type MailTestResult } from '@lm/shared';
import { all, get, run, type Db } from '../../db/connection.ts';
import { bumpDataVersion } from '../cache.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { HttpError } from '../errors.ts';
import { recordSystemEvent } from '../audit/events.ts';
import { looksLikePdf } from './pdf.ts';
import { ingestStatement } from './store.ts';

export const MAIL_META_KEY = 'ext:statements:mail';
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
/** At most this many new messages are downloaded per check (the rest wait for the next check). */
export const MAIL_MAX_MESSAGES_PER_CHECK = 40;
/** An email that fails to process is tried on this many checks, then skipped. */
export const MAIL_RETRIES = 3;
/** Test connection at most this often (a quicker press answers the last result). */
export const MAIL_TEST_EVERY_MS = 10_000;

interface MailState {
  address: string | null;
  /** v1:… payload from lib/crypto.ts encrypt(), never the password itself. */
  passwordEnc: string | null;
  enabled: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  lastFetchAt: string | null;
  mailbox: string | null;
  uidValidity: string | null;
  lastUid: number | null;
  /** The email that failed to process on the last check (it is tried again), and on how many checks it failed. */
  failedUid?: number | null;
  failedTries?: number;
}

const EMPTY: MailState = { address: null, passwordEnc: null, enabled: false, lastCheckAt: null, lastError: null, lastFetchAt: null, mailbox: null, uidValidity: null, lastUid: null, failedUid: null, failedTries: 0 };

export function readMailState(db: Db): MailState {
  const row = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, [MAIL_META_KEY]);
  if (!row) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<MailState>) };
  } catch {
    return { ...EMPTY };
  }
}

function writeMailState(db: Db, state: MailState): void {
  run(db, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [MAIL_META_KEY, JSON.stringify(state)]);
}

/** What GET /statements/mail answers: never the app password. */
export function mailSettingsOf(state: MailState): MailSettings {
  return {
    address: state.address,
    hasPassword: Boolean(state.passwordEnc),
    enabled: state.enabled,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    lastFetchAt: state.lastFetchAt,
    checkEveryMinutes: STATEMENT_CHECK_EVERY_MINUTES,
  };
}

export const readMailSettings = (db: Db) => mailSettingsOf(readMailState(db));

/** Google shows an app password as four groups of four letters; spaces are fine. */
export function normaliseAppPassword(raw: string): string | null {
  const s = raw.replace(/\s+/g, '');
  return /^[a-zA-Z]{16}$/.test(s) ? s.toLowerCase() : null;
}

export interface MailSettingsChange {
  address?: string | null;
  appPassword?: string;
  enabled?: boolean;
}

/** PUT /statements/mail: a new address forgets where the last check got to; '' removes the app password. */
export function saveMailSettings(db: Db, input: MailSettingsChange): MailSettings {
  const state = readMailState(db);
  const next: MailState = { ...state };
  if (input.address !== undefined) {
    const address = input.address?.trim().toLowerCase() || null;
    if (address !== state.address) {
      next.address = address;
      next.mailbox = null;
      next.uidValidity = null;
      next.lastUid = null;
      next.failedUid = null;
      next.failedTries = 0;
      next.lastError = null;
    }
  }
  if (input.appPassword !== undefined) {
    if (input.appPassword === '') next.passwordEnc = null;
    else {
      const pass = normaliseAppPassword(input.appPassword);
      if (!pass) throw new HttpError(400, 'An app password is 16 letters. Google shows it as four groups of four; spaces are fine.');
      next.passwordEnc = encrypt(pass);
      next.lastError = null;
    }
  }
  if (input.enabled !== undefined) {
    if (input.enabled && (!next.address || !next.passwordEnc)) {
      throw new HttpError(400, 'Add the Gmail address and the app password before turning on the automatic check.');
    }
    next.enabled = input.enabled;
  }
  // removing the address or the app password turns the automatic check off
  if (!next.address || !next.passwordEnc) next.enabled = false;
  if (next.address !== state.address || next.passwordEnc !== state.passwordEnc) lastTest = null; // a new password is tested afresh
  writeMailState(db, next);
  return mailSettingsOf(next);
}

// ───────────────────────────── the mail source ─────────────────────────────

export interface MailCredentials {
  address: string;
  password: string;
}

export interface RawMessage {
  uid: number;
  /** The whole RFC 822 message. */
  source: Buffer;
}

export interface FetchRequest extends MailCredentials {
  senders: string[];
  /** Where the last check got to; a different UIDVALIDITY means start again from `since`. */
  mailbox: string | null;
  uidValidity: string | null;
  lastUid: number | null;
  since: Date;
  max: number;
}

export interface FetchResult {
  mailbox: string;
  uidValidity: string;
  /** Messages from the senders found (some may wait for the next check when over `max`). */
  found: number;
  /** The highest UID looked at (the next check starts after it). */
  lastUid: number | null;
  messages: RawMessage[];
}

export interface MailSource {
  fetchNew(req: FetchRequest): Promise<FetchResult>;
  /** Connects, opens the mailbox read-only and counts recent messages from the senders. */
  test(req: MailCredentials & { senders: string[]; since: Date }): Promise<{ mailbox: string; recent: number }>;
}

/** The query for messages FROM any of the senders. */
function fromQuery(senders: readonly string[]): { from?: string; or?: { from: string }[] } {
  return senders.length === 1 ? { from: senders[0]! } : { or: senders.map((s) => ({ from: s })) };
}

/** Gmail's "All Mail" (special use \All), else INBOX. */
async function allMailPath(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
}

function imapClient(creds: MailCredentials): ImapFlow {
  return new ImapFlow({
    host: GMAIL_IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.password },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

/** The real source: imapflow against imap.gmail.com, every mailbox opened read-only (EXAMINE). */
export const imapMailSource: MailSource = {
  async fetchNew(req) {
    const client = imapClient(req);
    client.on('error', () => {}); // a dropped socket after logout must not crash the server
    await client.connect();
    try {
      const path = await allMailPath(client);
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const box = client.mailbox;
        const uidValidity = box ? String(box.uidValidity) : '';
        const resume = req.mailbox === path && req.uidValidity === uidValidity && req.lastUid !== null;
        const query = { ...fromQuery(req.senders), ...(resume ? { uid: `${req.lastUid! + 1}:*` } : { since: req.since }) };
        const found = ((await client.search(query, { uid: true })) || []).filter((u) => !resume || u > req.lastUid!).sort((a, b) => a - b);
        const take = found.slice(0, req.max);
        const messages: RawMessage[] = [];
        for (const uid of take) {
          const msg = await client.fetchOne(String(uid), { uid: true, size: true, source: true }, { uid: true });
          if (msg && msg.source && (msg.size ?? msg.source.length) <= 2 * STATEMENT_MAX_BYTES) messages.push({ uid, source: msg.source });
        }
        const lastUid = take.length ? take[take.length - 1]! : resume ? req.lastUid : null;
        return { mailbox: path, uidValidity, found: found.length, lastUid, messages };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  },
  async test(req) {
    const client = imapClient(req);
    client.on('error', () => {});
    await client.connect();
    try {
      const path = await allMailPath(client);
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const recent = req.senders.length ? ((await client.search({ ...fromQuery(req.senders), since: req.since }, { uid: true })) || []).length : 0;
        return { mailbox: path, recent };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  },
};

let source: MailSource = imapMailSource;

/** Tests: a fake mail source (null: back to Gmail). A new source forgets the last connection test. */
export function setMailSource(next: MailSource | null): void {
  source = next ?? imapMailSource;
  lastTest = null;
}

// ───────────────────────────── errors in plain words ─────────────────────────────

/** An IMAP or network failure as a sentence Matt can act on. */
export function mailErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: string; authenticationFailed?: boolean; responseText?: string; serverResponseCode?: string; message?: string };
  const text = `${e.responseText ?? ''} ${e.serverResponseCode ?? ''} ${e.message ?? ''}`.toLowerCase();
  if (/application-specific password required|app password required/.test(text)) {
    return 'Gmail wants an app password, not your normal Google password. Make one at myaccount.google.com/apppasswords and paste it here.';
  }
  if (/not enabled for imap|imap access is disabled|imap is disabled|enable imap/.test(text)) {
    return 'IMAP is off in Gmail. In Gmail open Settings → See all settings → Forwarding and POP/IMAP, turn on IMAP, save, then try again.';
  }
  if (/web ?login required|log ?in via your web browser|please log in via/.test(text)) {
    return 'Google stopped the sign-in. Sign in to Gmail in a browser once (Google may ask you to confirm it is you), then try again.';
  }
  if (e.authenticationFailed || /authenticationfailed|invalid credentials|authentication failed|\bauth\b.*fail|login failed/.test(text)) {
    return 'Wrong app password: Gmail did not accept the address and app password. Check the address, then make a new app password at myaccount.google.com/apppasswords and paste it here. If Google says app passwords are not available, turn on 2-Step Verification first; on a work account the administrator may have to allow them.';
  }
  const code = e.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT'].includes(code) || /timed? ?out|socket|network/.test(text)) {
    return `Could not reach Gmail (${GMAIL_IMAP_HOST}). Check this computer's internet connection; Linear Hub tries again every ${STATEMENT_CHECK_EVERY_MINUTES} minutes.`;
  }
  if (/too many|rate limit|throttl|overquota|bandwidth/.test(text)) {
    return `Gmail asked Linear Hub to slow down. It tries again in ${STATEMENT_CHECK_EVERY_MINUTES} minutes.`;
  }
  const short = (e.message ?? String(err)).replace(/\s+/g, ' ').trim().slice(0, 160);
  return `Could not check Gmail: ${short || 'unknown problem'}.`;
}

// ───────────────────────────── checking ─────────────────────────────

/** Every statement sender's address (lower case, once each). */
export function senderAddresses(db: Db): string[] {
  return [...new Set(all<{ address: string }>(db, `SELECT address FROM campaign_statement_senders ORDER BY address`).map((r) => r.address.trim().toLowerCase()))];
}

function credentialsOf(state: MailState): MailCredentials {
  if (!state.address || !state.passwordEnc) throw new HttpError(409, 'Add the Gmail address and the app password in Settings → Integrations first.');
  let password: string;
  try {
    password = decrypt(state.passwordEnc);
  } catch {
    throw new HttpError(409, 'The saved app password cannot be read any more (the app secret changed). Enter it again in Settings → Integrations.');
  }
  return { address: state.address, password };
}

/** True when a check can run (an address and an app password are saved). */
export function mailConfigured(db: Db): boolean {
  const s = readMailState(db);
  return Boolean(s.address && s.passwordEnc);
}

let testing: Promise<MailTestResult> | null = null;
let lastTest: { at: number; result: MailTestResult } | null = null;

/**
 * POST /statements/mail/test: connect, open the mailbox read-only, count recent statement emails. A test already
 * running is shared; within MAIL_TEST_EVERY_MS of the last one, its result is answered again without connecting.
 */
export function testMailConnection(db: Db): Promise<MailTestResult> {
  const creds = credentialsOf(readMailState(db)); // 409 straight away when nothing is set up
  if (testing) return testing;
  if (lastTest && Date.now() - lastTest.at < MAIL_TEST_EVERY_MS) return Promise.resolve(lastTest.result);
  testing = runTest(db, creds)
    .then((result) => {
      lastTest = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      testing = null;
    });
  return testing;
}

async function runTest(db: Db, creds: MailCredentials): Promise<MailTestResult> {
  const senders = senderAddresses(db);
  try {
    const r = await source.test({ ...creds, senders, since: new Date(Date.now() - STATEMENT_FIRST_CHECK_DAYS * 86_400_000) });
    writeMailState(db, { ...readMailState(db), lastError: null });
    const what = senders.length
      ? `${r.recent === 0 ? 'No emails' : r.recent === 1 ? '1 email' : `${r.recent} emails`} from your statement senders in the last ${STATEMENT_FIRST_CHECK_DAYS} days.`
      : 'Add the address each client sends statements from, and Linear Hub will look for them.';
    return { ok: true, message: `Connected to Gmail as ${creds.address} (read-only). ${what}` };
  } catch (err) {
    const message = mailErrorMessage(err);
    writeMailState(db, { ...readMailState(db), lastError: message });
    return { ok: false, message };
  }
}

/** The From address of a parsed message. */
const fromAddress = (parsed: Awaited<ReturnType<typeof simpleParser>>): string | null => parsed.from?.value?.[0]?.address?.trim().toLowerCase() || null;

/** The registrable part we compare: "mail.bcn.org.uk" and "bcn.org.uk" are aligned; a bare "uk" or "com" never is. */
function domainsAligned(a: string, b: string): boolean {
  const x = a.trim().toLowerCase().replace(/\.$/, '');
  const y = b.trim().toLowerCase().replace(/\.$/, '');
  if (!x.includes('.') || !y.includes('.')) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Did Gmail confirm that the message came from the From address's domain? Only the topmost Authentication-Results
 * header counts — the one Gmail's own servers (authserv-id mx.google.com) add on arrival; any lower one could have been
 * written by the sender. True when it says dmarc=pass with header.from aligned to the sender's domain, or dkim=pass
 * signed (header.d / header.i) by an aligned domain.
 */
export function senderAuthenticated(headerLines: readonly { key: string; line: string }[], sender: string | null): boolean {
  const domain = sender?.split('@')[1];
  if (!domain) return false;
  const top = headerLines.find((h) => h.key.toLowerCase() === 'authentication-results');
  if (!top) return false;
  const value = top.line.replace(/^[^:]*:/, '').replace(/\r?\n[ \t]+/g, ' ').trim();
  const [authserv, ...results] = value.split(';');
  if (!/^mx\.google\.com(\s|$)/i.test((authserv ?? '').trim())) return false;
  for (const part of results) {
    const r = part.trim().toLowerCase();
    const m = /^(dkim|dmarc)\s*=\s*([a-z]+)/.exec(r);
    if (!m || m[2] !== 'pass') continue;
    if (m[1] === 'dmarc') {
      const from = /header\.from=([^\s;()]+)/.exec(r)?.[1];
      if (from && domainsAligned(from, domain)) return true;
    } else {
      const signer = /header\.d=([^\s;()]+)/.exec(r)?.[1] ?? /header\.i=[^@\s;()]*@([^\s;()]+)/.exec(r)?.[1];
      if (signer && domainsAligned(signer, domain)) return true;
    }
  }
  return false;
}

let running: Promise<CheckNowResult> | null = null;

/** True while a check is under way (a Check now press then shares it: routes/statements.ts does not count it). */
export function isCheckRunning(): boolean {
  return running !== null;
}

/**
 * One check of the mailbox (POST /statements/check-now and the 15-minute job). A check already running is shared, not
 * started twice. Never throws for a mail problem: the result's `errors` (and Settings → Integrations) say what went wrong.
 */
export function checkMail(db: Db): Promise<CheckNowResult> {
  if (running) return running;
  const creds = credentialsOf(readMailState(db)); // 409 straight away when nothing is set up
  running = runCheck(db, creds).finally(() => {
    running = null;
  });
  return running;
}

async function runCheck(db: Db, creds: MailCredentials): Promise<CheckNowResult> {
  const result: CheckNowResult = { checked: 0, fetched: 0, parsed: 0, applied: 0, errors: [] };
  const state = readMailState(db);
  const senders = senderAddresses(db);
  const checkedAt = new Date().toISOString();
  if (!senders.length) {
    result.errors.push('No statement senders yet: add the address each client sends statements from (Settings → Integrations).');
    writeMailState(db, { ...readMailState(db), lastCheckAt: checkedAt, lastError: null });
    return result;
  }
  let fetched: FetchResult;
  try {
    fetched = await source.fetchNew({
      ...creds,
      senders,
      mailbox: state.mailbox,
      uidValidity: state.uidValidity,
      lastUid: state.lastUid,
      since: new Date(Date.now() - STATEMENT_FIRST_CHECK_DAYS * 86_400_000),
      max: MAIL_MAX_MESSAGES_PER_CHECK,
    });
  } catch (err) {
    const message = mailErrorMessage(err);
    result.errors.push(message);
    const before = readMailState(db);
    writeMailState(db, { ...before, lastCheckAt: checkedAt, lastError: message });
    if (before.lastError !== message) recordSystemEvent(db, { name: 'statements.mail_error', summary: `Checking Gmail for statements failed: ${message}`, entity: 'statement' });
    return result;
  }
  result.checked = fetched.messages.length;
  const stored: string[] = [];
  // the first email that failed this time: the cursor stops just before it, so the next check tries it again
  let failedUid: number | null = null;
  for (const msg of fetched.messages) {
    try {
      const parsed = await simpleParser(msg.source, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true });
      const sender = fromAddress(parsed);
      // the search also matches display names and forwards; no From at all is not a listed sender either
      if (!sender || !senders.includes(sender)) continue;
      const senderVerified = senderAuthenticated(parsed.headerLines ?? [], sender);
      const baseId = parsed.messageId || `<uid-${fetched.uidValidity}-${msg.uid}@${GMAIL_IMAP_HOST}>`;
      const receivedAt = (parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date()).toISOString();
      const pdfs = parsed.attachments.filter((a) => (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename ?? '')) && looksLikePdf(a.content));
      let n = 0;
      for (const att of pdfs) {
        n++;
        if (att.content.length > STATEMENT_MAX_BYTES) {
          result.errors.push(`${att.filename ?? 'A PDF'} from ${sender ?? 'a sender'} is over 20 MB, so it was left in Gmail.`);
          continue;
        }
        const r = await ingestStatement(db, {
          buf: att.content,
          fileName: att.filename ?? `statement-${msg.uid}-${n}.pdf`,
          source: 'email',
          messageId: `${baseId}#${n}`,
          sender,
          subject: parsed.subject ?? null,
          receivedAt,
          senderVerified,
        });
        if (r.duplicate) continue;
        result.fetched++;
        if (r.status !== 'failed') result.parsed++;
        if (r.applied) result.applied++;
        const s = get<{ code: string | null; start: string | null; end: string | null }>(
          db,
          `SELECT c.code, s.period_start AS start, s.period_end AS end FROM statements s LEFT JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ?`,
          [r.statementId],
        );
        stored.push(`${s?.code ?? 'unknown campaign'} ${formatStatementPeriod(s?.start, s?.end)}${r.status === 'failed' ? ' (could not be read)' : ''}`);
      }
    } catch (err) {
      console.error(`Statement email (UID ${msg.uid}) could not be processed`, err);
      const tries = (state.failedUid === msg.uid ? (state.failedTries ?? 0) : 0) + 1;
      if (failedUid === null && tries < MAIL_RETRIES) {
        failedUid = msg.uid;
        result.errors.push(`One email (UID ${msg.uid}) could not be read this time; Linear Hub tries it again on the next check.`);
      } else if (failedUid === null) {
        result.errors.push(`One email (UID ${msg.uid}) could not be read after ${MAIL_RETRIES} tries, so it was skipped. Open it in Gmail and upload its PDF in Finance → Statements.`);
      } else {
        result.errors.push(`One email (UID ${msg.uid}) could not be read; it is tried again on the next check.`);
      }
    }
  }
  const after = readMailState(db);
  // stop the cursor before the first email that failed (it and everything after it are read again; Message-ID keeps
  // what was stored from being stored twice)
  const cursor = failedUid === null ? fetched.lastUid : failedUid - 1;
  writeMailState(db, {
    ...after,
    mailbox: fetched.mailbox,
    uidValidity: fetched.uidValidity,
    lastUid: cursor,
    failedUid,
    failedTries: failedUid === null ? 0 : (state.failedUid === failedUid ? (state.failedTries ?? 0) : 0) + 1,
    lastCheckAt: checkedAt,
    lastError: null,
    lastFetchAt: result.fetched ? checkedAt : after.lastFetchAt,
  });
  if (result.fetched) {
    bumpDataVersion();
    recordSystemEvent(db, {
      name: 'statements.fetch',
      summary: `Fetched ${result.fetched === 1 ? 'a statement' : `${result.fetched} statements`} from Gmail: ${stored.join(', ')}${result.applied ? `; ${result.applied} applied automatically` : ''}`,
      entity: 'statement',
    });
  }
  return result;
}
