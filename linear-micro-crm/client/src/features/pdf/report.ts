// Release 1.3 — OWNED BY P4 pdf-everywhere. What every export tells the audit trail, and what a table PDF borrows from
// the page around its button: the page heading (its subtitle) and the filters set on screen (its filter lines).
// Small on purpose: ExportButton (in many pages' chunks) imports it.
//
// Exports made without signal still reach the audit trail: a report Linear Hub could not take (no answer, a server
// error, too many at once, the session ended) waits on the device, one localStorage key per person
// ('lm-export-reports:<userId>', at most EXPORT_REPORT_QUEUE_LIMIT, oldest dropped first), and is sent again — oldest
// first, one at a time — when the signal is back (the window 'online' event, or api/client.ts announcing an answer
// after a failed request), after the next export that gets through, and whenever a page with an export button opens
// (also after signing back in). One tab sends at a time (Web Locks, where the browser has them) and each report is
// taken off the queue before it is sent (put back if it has to wait), so with two tabs open a report is still sent
// once. Only the signed-in person's own reports are ever sent from their session. A report Linear Hub refuses
// outright (400, 403: it would be refused again) is dropped. Before sending what waits, it checks with GET /auth/me
// that the session is still that person's. The audit row is stamped when the report arrives; the file name keeps the
// day the file was made. reportExportEvent takes a whole event (a one-record PDF names its record) with the same outbox.
import { exportWhatFor, type AuditExportFormat, type AuthResponse, type ClientAuditEventInput } from '@lm/shared';
import { ApiError, NETWORK_EVENT, api, isNetworkError, type NetworkEventDetail } from '@/api/client';

/** POST /audit/events { kind: 'export', format, what, rows, filename } — never blocks or fails the download. */
export function reportExport(format: AuditExportFormat, filename: string, rows: number, what?: string, ownerId?: number | null): void {
  reportExportEvent({ kind: 'export', format, what: what?.trim() || exportWhatFor(filename), rows, filename }, ownerId);
}

/**
 * Release 1.3 fix round (I3): any export event (POST /audit/events, kind 'export'), with the outbox — for a page PDF
 * of ONE record that names it (`entity`, `entityId`: an invoice PDF or print, a candidate profile, an interview
 * sheet), which reportExport cannot carry. With `ownerId` (the signed-in person's id) a report Linear Hub could not
 * take waits on the device like any other; without it, it is sent once, as api/auditEvents.ts reportAuditEvent does.
 */
export function reportExportEvent(event: ClientAuditEventInput, ownerId?: number | null): void {
  void deliver(event, ownerId ?? null);
}

// ───────────────────────────── The outbox ─────────────────────────────

/** Reports kept per person while Linear Hub cannot be reached. */
export const EXPORT_REPORT_QUEUE_LIMIT = 100;
const PREFIX = 'lm-export-reports:';
export const exportReportKey = (ownerId: number) => `${PREFIX}${ownerId}`;

interface QueuedReport {
  event: ClientAuditEventInput;
  /** When it was kept on the device (the device's clock, ISO). */
  queuedAt: string;
  /** Release 1.3 fix round (I3): which report this is (reports kept before it have none). */
  id?: string;
}

/** A report's identity in the queue: its id, else (an older report) when it was kept and its file name. */
const sameReport = (a: QueuedReport, b: QueuedReport) =>
  a.id || b.id ? a.id === b.id : a.queuedAt === b.queuedAt && a.event.filename === b.event.filename;

function newReportId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // not a secure context: fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Outcome = 'sent' | 'keep' | 'drop';

async function send(event: ClientAuditEventInput): Promise<Outcome> {
  try {
    await api<void>('/audit/events', { method: 'POST', json: event });
    return 'sent';
  } catch (e) {
    if (isNetworkError(e)) return 'keep';
    // signed out, too many reports this minute, or a server problem: worth another try later. Anything else (400, 403)
    // would be refused again, so it is not kept (a kept one would hold up every report behind it).
    if (e instanceof ApiError && (e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500)) return 'keep';
    return 'drop';
  }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validReport(v: unknown): v is QueuedReport {
  if (!v || typeof v !== 'object') return false;
  const e = (v as { event?: unknown }).event as Partial<ClientAuditEventInput> | undefined;
  return !!e && e.kind === 'export' && typeof e.what === 'string' && e.what.length > 0;
}

function readQueue(ownerId: number): QueuedReport[] {
  const s = storage();
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s.getItem(exportReportKey(ownerId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(validReport) : [];
  } catch {
    return [];
  }
}

function writeQueue(ownerId: number, items: QueuedReport[]): void {
  const s = storage();
  if (!s) return;
  try {
    if (items.length) s.setItem(exportReportKey(ownerId), JSON.stringify(items.slice(-EXPORT_REPORT_QUEUE_LIMIT)));
    else s.removeItem(exportReportKey(ownerId));
  } catch {
    // storage full or blocked: the report is lost, as it would have been before 1.3's outbox
  }
}

function enqueue(ownerId: number, event: ClientAuditEventInput): void {
  writeQueue(ownerId, [...readQueue(ownerId), { event, queuedAt: new Date().toISOString(), id: newReportId() }]);
}

/** Take the oldest waiting report off the queue before it is sent, so another tab cannot send it too. */
function claimNext(ownerId: number): QueuedReport | null {
  const queue = readQueue(ownerId);
  const next = queue.shift();
  if (!next) return null;
  writeQueue(ownerId, queue);
  return next;
}

/** A claimed report that has to wait again goes back to the front of the queue. */
function putBack(ownerId: number, item: QueuedReport): void {
  const queue = readQueue(ownerId).filter((q) => !sameReport(q, item));
  writeQueue(ownerId, [item, ...queue]);
}

type LockManagerLike = { request: <T>(name: string, callback: () => Promise<T>) => Promise<T> };

/**
 * Run `send` while this person's outbox is locked in every tab of the browser (Web Locks: one tab sends, the others
 * wait and then find the queue empty), or straight away where the browser has no locks. Either way each report is
 * taken off the queue before it is sent, so two tabs never send the same one.
 */
async function withOutboxLock<T>(ownerId: number, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    // no locks (Safari before 15.4): tabs woken by the same 'online' event start at different moments, so the
    // queue one tab has claimed from has reached the other before it reads (a tab's storage reaches the others late)
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 900));
    return run();
  }
  let started = false;
  try {
    return await locks.request(exportReportKey(ownerId), () => {
      started = true;
      return run();
    });
  } catch (e) {
    if (started) throw e;
    return run(); // the lock itself was refused (a sandboxed frame): send without it
  }
}

async function deliver(event: ClientAuditEventInput, ownerId: number | null): Promise<void> {
  const outcome = await send(event);
  if (ownerId == null) return; // no one to keep it for: as before, fire and forget
  if (outcome === 'keep') enqueue(ownerId, event);
  else if (outcome === 'sent') void replayExportReports(ownerId);
}

let inflight: Promise<number> | null = null;

/**
 * Send the person's waiting reports, oldest first; stops at the first one that has to wait again. Single-flight in
 * this tab, and one tab at a time (withOutboxLock); each report is claimed (taken off the queue) before it is sent and
 * put back if it has to wait, so a report open in two tabs is sent once.
 */
export function replayExportReports(ownerId: number): Promise<number> {
  if (inflight) return inflight;
  inflight = withOutboxLock(ownerId, async () => {
    let sent = 0;
    if (!readQueue(ownerId).length) return sent;
    // only from the person's own session: someone else may have signed in on this device since
    const me = await api<AuthResponse>('/auth/me').catch(() => null);
    if (me?.user.id !== ownerId) return sent;
    for (;;) {
      const next = claimNext(ownerId);
      if (!next) break;
      const outcome = await send(next.event);
      if (outcome === 'keep') {
        putBack(ownerId, next);
        break;
      }
      if (outcome === 'sent') sent++;
    }
    return sent;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

let armedFor: number | null = null;
const onOnline = () => {
  if (armedFor != null) void replayExportReports(armedFor);
};
let offline = false;
const onNetwork = (e: Event) => {
  const online = (e as CustomEvent<NetworkEventDetail>).detail?.online;
  if (online === false) offline = true;
  else if (online && offline) {
    offline = false;
    onOnline();
  }
};

/**
 * Called by every export button when it appears, with the signed-in person: sends what waits for them now — on every
 * page with an export button that opens, and after signing back in — and again whenever the signal comes back. Cheap
 * when nothing waits (one localStorage read); the buttons of one page share a single send.
 */
export function armExportReports(ownerId: number | null | undefined): void {
  if (ownerId == null || typeof window === 'undefined') return;
  if (armedFor === null) {
    window.addEventListener('online', onOnline);
    window.addEventListener(NETWORK_EVENT, onNetwork);
  }
  armedFor = ownerId;
  if (readQueue(ownerId).length) void replayExportReports(ownerId);
}

// ───────────────────────────── The page around the button ─────────────────────────────

/**
 * The page's heading (its PageHeader h1) as on screen, for the PDF's subtitle; null when there is none. A heading may
 * hold an avatar ("JL") or a badge ("You") beside the name, so the longest piece of text in it is taken.
 */
export function pageHeadingNear(el: Element | null | undefined): string | null {
  if (typeof document === 'undefined') return null;
  const scope = el?.closest('main') ?? document.querySelector('main') ?? document;
  const h1 = scope.querySelector('h1');
  if (!h1) return null;
  let best = '';
  const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('[role="img"], [aria-hidden="true"], svg')) continue;
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > best.length) best = t;
  }
  return best || null;
}

/** How many levels above the button to look for its filter bar (a toolbar row, or the card header it sits in). */
const FILTER_SCOPE_LEVELS = 3;
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** A control's name as a person reads it: its aria-label, its <label>, or its placeholder. */
function controlName(c: HTMLInputElement | HTMLSelectElement): string {
  return oneLine(c.getAttribute('aria-label')) || oneLine(c.labels?.[0]?.textContent) || oneLine(c.getAttribute('placeholder'));
}

/** A rendered control (not hidden, not a closed responsive copy). */
const shown = (c: HTMLElement) => !c.closest('[hidden], [aria-hidden="true"]') && c.getClientRects().length > 0;

/**
 * The filters set on screen next to an export button, in words, for the PDF ("Team: Deansgate North", "Position:
 * Field rep", "Search: “jo”"). It reads the button's own filter bar — the nearest of the FILTER_SCOPE_LEVELS
 * elements around it that holds filter controls — and only:
 *  - drop-downs with an "all" choice (an empty value: "All teams", "Any owner") that are set to something else;
 *  - search boxes (type=search, or named "Search …") with words in them.
 * A drop-down without an "all" choice (a status, an order) is the file name's to say, or not a filter at all.
 */
export function screenFiltersNear(el: Element | null | undefined): string[] {
  if (!el || typeof document === 'undefined') return [];
  let scope: Element | null = el.parentElement;
  for (let level = 0; scope && level < FILTER_SCOPE_LEVELS; level++, scope = scope.parentElement) {
    if (scope.matches('main, body, [role="dialog"]')) break;
    const selects = [...scope.querySelectorAll('select')].filter((s) => shown(s) && [...s.options].some((o) => o.value === ''));
    const searches = [...scope.querySelectorAll('input')].filter(
      (i) => shown(i) && (i.type === 'search' || (i.type === 'text' && /^search\b/i.test(controlName(i)))),
    );
    if (!selects.length && !searches.length) continue;
    const lines: string[] = [];
    for (const s of selects) {
      const picked = s.selectedOptions[0];
      if (!s.value || !picked) continue;
      const name = controlName(s);
      const value = oneLine(picked.textContent);
      if (value) lines.push(name ? `${name}: ${value}` : value);
    }
    for (const i of searches) {
      const words = oneLine(i.value);
      if (words) lines.push(`Search: “${words.length > 60 ? `${words.slice(0, 59)}…` : words}”`);
    }
    return lines;
  }
  return [];
}
