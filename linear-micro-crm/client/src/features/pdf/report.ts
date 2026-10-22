// Release 1.3 — OWNED BY P4 pdf-everywhere. What every export tells the audit trail, and what a table PDF borrows from
// the page around its button: the page heading (its subtitle) and the filters set on screen (its filter lines).
// Small on purpose: ExportButton (in many pages' chunks) imports it.
//
// Exports made without signal still reach the audit trail: a report Linear Hub could not take (no answer, a server
// error, too many at once, the session ended) waits on the device, one localStorage key per person
// ('lm-export-reports:<userId>', at most EXPORT_REPORT_QUEUE_LIMIT, oldest dropped first), and is sent again — oldest
// first, one at a time — when the signal is back (the window 'online' event, or api/client.ts announcing an answer
// after a failed request), after the next export that gets through, and when a page with an export button opens.
// Only the signed-in person's own reports are ever sent from their session. A report Linear Hub refuses outright
// (400, 403: it would be refused again) is dropped. Before sending what waits, it checks with GET /auth/me that the
// session is still that person's. The audit row is stamped when the report arrives; the file name keeps the day the
// file was made.
import { exportWhatFor, type AuditExportFormat, type AuthResponse, type ClientAuditEventInput } from '@lm/shared';
import { ApiError, NETWORK_EVENT, api, isNetworkError, type NetworkEventDetail } from '@/api/client';

/** POST /audit/events { kind: 'export', format, what, rows, filename } — never blocks or fails the download. */
export function reportExport(format: AuditExportFormat, filename: string, rows: number, what?: string, ownerId?: number | null): void {
  const event: ClientAuditEventInput = { kind: 'export', format, what: what?.trim() || exportWhatFor(filename), rows, filename };
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
  writeQueue(ownerId, [...readQueue(ownerId), { event, queuedAt: new Date().toISOString() }]);
}

async function deliver(event: ClientAuditEventInput, ownerId: number | null): Promise<void> {
  const outcome = await send(event);
  if (ownerId == null) return; // no one to keep it for: as before, fire and forget
  if (outcome === 'keep') enqueue(ownerId, event);
  else if (outcome === 'sent') void replayExportReports(ownerId);
}

let inflight: Promise<number> | null = null;

/** Send the person's waiting reports, oldest first; stops at the first one that has to wait again. Single-flight. */
export function replayExportReports(ownerId: number): Promise<number> {
  if (inflight) return inflight;
  inflight = (async () => {
    let sent = 0;
    if (!readQueue(ownerId).length) return sent;
    // only from the person's own session: someone else may have signed in on this device since
    const me = await api<AuthResponse>('/auth/me').catch(() => null);
    if (me?.user.id !== ownerId) return sent;
    for (;;) {
      const queue = readQueue(ownerId);
      const next = queue[0];
      if (!next) break;
      const outcome = await send(next.event);
      if (outcome === 'keep') break;
      // drop exactly the item sent (another tab may have added more meanwhile)
      const now = readQueue(ownerId);
      const at = now.findIndex((q) => q.queuedAt === next.queuedAt && q.event.filename === next.event.filename);
      if (at >= 0) now.splice(at, 1);
      writeQueue(ownerId, now);
      if (outcome === 'sent') sent++;
    }
    return sent;
  })().finally(() => {
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
 * Called by every export button with the signed-in person: sends what waits for them now, and again whenever the
 * signal comes back. Cheap when nothing waits (one localStorage read).
 */
export function armExportReports(ownerId: number | null | undefined): void {
  if (ownerId == null || typeof window === 'undefined') return;
  if (armedFor === null) {
    window.addEventListener('online', onOnline);
    window.addEventListener(NETWORK_EVENT, onNetwork);
  }
  if (armedFor !== ownerId) {
    armedFor = ownerId;
    if (readQueue(ownerId).length) void replayExportReports(ownerId);
  }
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
