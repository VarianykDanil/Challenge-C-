// Gauge outbox — OWNED BY p7-signal-proof-logging.
//
// Gauges saved while Linear Hub cannot be reached wait here, on the phone, and are replayed safely later:
// - one localStorage key per signed-in person, 'lm-gauge-outbox:<userId>', at most OUTBOX_LIMIT items;
// - every storage call is wrapped, and a failed write returns null / false so the caller keeps today's error path
//   (nothing is ever dropped silently);
// - replayAll() is single-flight: for each waiting item it looks the day up (GET /gauges), applies the shared
//   replayDecision() and only then POSTs the upsert. An entry the person had not seen moves to 'review' instead of
//   being overwritten, and so does an update whose entry was deleted meanwhile (it is not quietly re-created).
//   The (eventId, userId, date) upsert makes a repeated send idempotent.
// Replay only ever reads the signed-in person's key, and the server still enforces who may write what.
// Release 1.4 (package S): a session now ends 14 hours after sign-in, mid-shift perhaps. Nothing waiting here is lost:
// the key is per person and survives the sign-out, a 401 stops the replay with every item still waiting, and so does
// the setup gate's 403 (PIN or two-step verification still to set up) — the replay runs again after the next sign-in.
import { useSyncExternalStore } from 'react';
import type { GaugeEntryWithMeta, GaugeUpsertInput } from '@lm/shared';
import { OUTBOX_LIMIT, replayDecision, replayOutcome, sameGaugeDay } from '@lm/shared';
import { ApiError, PIN_SETUP_REQUIRED_EVENT, apiRaw, isNetworkError, qs } from '@/api/client';

export type OutboxStatus = 'waiting' | 'review' | 'failed';

/** What the server held for the same day when an item moved to review. */
export interface OutboxServerEntry {
  id: number;
  submittedAt: string;
  stops: number;
  sales: number;
}

export interface OutboxItem {
  id: string;
  /** When it was saved on the phone (the phone's clock; shown to the person). */
  queuedAt: string;
  input: GaugeUpsertInput;
  /** The entry the form had prefilled (so the person had seen it), or null for a new day. */
  expectedExistingId: number | null;
  /**
   * That entry's submittedAt as the form saw it (the server's clock). Replay compares against it rather than queuedAt
   * when it is known, so a phone clock that is minutes out can never turn a colleague's later edit into a "send".
   */
  seenSubmittedAt?: string | null;
  eventName: string;
  userName: string;
  status: OutboxStatus;
  /** Why it failed or is still waiting (the server's message for a 4xx). */
  error?: string;
  /**
   * For a 'review' item: what the server held for that day. Absent when the entry the form had shown is no longer on
   * the server (someone deleted it while this waited).
   */
  server?: OutboxServerEntry;
}

export interface EnqueueInput {
  input: GaugeUpsertInput;
  expectedExistingId: number | null;
  seenSubmittedAt?: string | null;
  eventName: string;
  userName: string;
}

const PREFIX = 'lm-gauge-outbox:';
const EMPTY: OutboxItem[] = [];

export const outboxKey = (ownerId: number) => `${PREFIX}${ownerId}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Can this browser keep entries at all? (False in some private modes, or with site data blocked.) */
export function outboxAvailable(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem('lm-probe', '1');
    s.removeItem('lm-probe');
    return true;
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function validItem(v: unknown): v is OutboxItem {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.queuedAt !== 'string' || !isObj(v.input)) return false;
  const i = v.input;
  return isId(i.eventId) && isId(i.userId) && typeof i.date === 'string' && (v.status === 'waiting' || v.status === 'review' || v.status === 'failed');
}

function read(ownerId: number): OutboxItem[] {
  const s = storage();
  if (!s) return EMPTY;
  try {
    const raw = s.getItem(outboxKey(ownerId));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validItem) : EMPTY;
  } catch {
    return EMPTY;
  }
}

// ── A tiny external store, so the banner, the modal and sign-out all see the same list ──
const cache = new Map<number, OutboxItem[]>();
const listeners = new Set<() => void>();

function changed(): void {
  cache.clear();
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent): void {
  // Another tab of the same browser changed an outbox (or storage was cleared).
  if (e.key === null || e.key.startsWith(PREFIX)) changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** The signed-in person's outbox, oldest first. */
export function getOutbox(ownerId: number): OutboxItem[] {
  let items = cache.get(ownerId);
  if (!items) {
    items = read(ownerId);
    cache.set(ownerId, items);
  }
  return items;
}

export function useOutbox(ownerId: number | null | undefined): OutboxItem[] {
  return useSyncExternalStore(subscribe, () => (ownerId ? getOutbox(ownerId) : EMPTY), () => EMPTY);
}

function write(ownerId: number, items: OutboxItem[]): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (items.length) s.setItem(outboxKey(ownerId), JSON.stringify(items));
    else s.removeItem(outboxKey(ownerId));
  } catch {
    return false;
  }
  changed();
  return true;
}

const sameDay = (a: GaugeUpsertInput, b: GaugeUpsertInput) => a.eventId === b.eventId && a.userId === b.userId && a.date === b.date;

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Keep a save on the phone. A newer save for the same (event, person, date) replaces the waiting one, so the queue
 * never sends two versions of one day. Returns null when the phone cannot keep it (no storage, storage full, or
 * OUTBOX_LIMIT items already waiting): the caller then shows the error as before.
 */
export function enqueueGauge(ownerId: number, e: EnqueueInput): OutboxItem | null {
  if (!outboxAvailable()) return null;
  const rest = getOutbox(ownerId).filter((i) => !sameDay(i.input, e.input));
  if (rest.length >= OUTBOX_LIMIT) return null;
  const item: OutboxItem = {
    id: newId(),
    queuedAt: new Date().toISOString(),
    input: e.input,
    expectedExistingId: e.expectedExistingId,
    seenSubmittedAt: e.seenSubmittedAt ?? null,
    eventName: e.eventName,
    userName: e.userName,
    status: 'waiting',
  };
  return write(ownerId, [...rest, item]) ? item : null;
}

/** Remove one item (sent, or discarded by the person). */
export function discardOutboxItem(ownerId: number, id: string): boolean {
  const items = getOutbox(ownerId);
  if (!items.some((i) => i.id === id)) return true;
  return write(ownerId, items.filter((i) => i.id !== id));
}

function patchItem(ownerId: number, id: string, patch: Partial<OutboxItem>): void {
  const items = getOutbox(ownerId);
  if (!items.some((i) => i.id === id)) return; // discarded meanwhile
  write(ownerId, items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
}

/** The waiting item for one day, if any (the modal shows it and saving again replaces it). */
export function outboxItemFor(items: OutboxItem[], key: { eventId: number | null; userId: number | null; date: string }): OutboxItem | null {
  if (key.eventId == null || key.userId == null || !key.date) return null;
  return items.find((i) => i.input.eventId === key.eventId && i.input.userId === key.userId && i.input.date === key.date) ?? null;
}

// ───────────────────────────── Replay ─────────────────────────────

export type SentOutcome = 'logged' | 'updated' | 'already';

export interface ReplayReport {
  sent: Array<{ item: OutboxItem; outcome: SentOutcome; entry: GaugeEntryWithMeta | null }>;
  review: OutboxItem[];
  failed: OutboxItem[];
  /** Why the loop ended early: no signal, the session ended, or the server had a problem. */
  stopped: 'network' | 'signed-out' | 'server' | null;
}

type StepResult =
  | { kind: 'sent'; outcome: SentOutcome; entry: GaugeEntryWithMeta | null }
  | { kind: 'review'; item: OutboxItem }
  | { kind: 'failed'; item: OutboxItem }
  | { kind: 'stop'; reason: 'network' | 'signed-out' | 'server' };

const serverProblem = (status: number) => `Linear Hub had a problem (${status}) — it will try again.`;

function apiMessage(e: ApiError): string {
  const details = Array.isArray(e.details) ? e.details.map((d) => (isObj(d) && typeof d.message === 'string' ? d.message : typeof d === 'string' ? d : '')).filter(Boolean) : [];
  return details.length ? `${e.message}: ${details.slice(0, 2).join('; ')}` : e.message;
}

/** "Send mine anyway": an omitted check-in / note keeps the server's value, so a colleague's record is not cleared. */
function forcedInput(input: GaugeUpsertInput): GaugeUpsertInput {
  const out: GaugeUpsertInput = { ...input };
  if (out.checkedInAt === null) delete out.checkedInAt;
  if (out.notes === null) delete out.notes;
  return out;
}

/**
 * One request, noting whether the answer was a setup gate's 403 (a PIN or two-step verification still to set up:
 * api/client.ts announces it with PIN_SETUP_REQUIRED_EVENT before it throws). Such an item keeps waiting.
 */
async function noteGate<T>(fn: () => Promise<T>): Promise<{ value: T } | { error: unknown; gate: boolean }> {
  let gate = false;
  const onGate = () => {
    gate = true;
  };
  if (typeof window !== 'undefined') window.addEventListener(PIN_SETUP_REQUIRED_EVENT, onGate);
  try {
    return { value: await fn() };
  } catch (error) {
    return { error, gate };
  } finally {
    if (typeof window !== 'undefined') window.removeEventListener(PIN_SETUP_REQUIRED_EVENT, onGate);
  }
}

function handleError(ownerId: number, item: OutboxItem, e: unknown, gate = false): StepResult {
  if (isNetworkError(e)) return { kind: 'stop', reason: 'network' };
  if (gate) return { kind: 'stop', reason: 'signed-out' }; // set up the PIN / two-step first; it waits
  if (e instanceof ApiError) {
    const outcome = replayOutcome(e.status);
    if (outcome === 'failed') {
      const failed: OutboxItem = { ...item, status: 'failed', error: apiMessage(e) };
      patchItem(ownerId, item.id, { status: 'failed', error: failed.error });
      return { kind: 'failed', item: failed };
    }
    if (e.status === 401) return { kind: 'stop', reason: 'signed-out' };
    patchItem(ownerId, item.id, { error: serverProblem(e.status) });
    return { kind: 'stop', reason: 'server' };
  }
  patchItem(ownerId, item.id, { error: e instanceof Error ? e.message : 'Something went wrong — it will try again.' });
  return { kind: 'stop', reason: 'server' };
}

async function replayOne(ownerId: number, item: OutboxItem, force: boolean): Promise<StepResult> {
  const { eventId, userId, date } = item.input;
  const lookup = await noteGate(() => apiRaw<GaugeEntryWithMeta[]>(`/gauges${qs({ eventId, userId, from: date, to: date, limit: 5 })}`));
  if ('error' in lookup) return handleError(ownerId, item, lookup.error, lookup.gate);
  const existing = (lookup.value.data ?? []).find((g) => g.eventId === eventId && g.userId === userId && g.date === date) ?? null;
  // A save that reached the server but whose answer was lost: nothing left to send.
  if (existing && sameGaugeDay(existing, item.input)) {
    discardOutboxItem(ownerId, item.id);
    return { kind: 'sent', outcome: 'already', entry: existing };
  }
  if (!force) {
    const decision = replayDecision(
      { queuedAt: item.seenSubmittedAt ?? item.queuedAt, expectedExistingId: item.expectedExistingId },
      existing ? { id: existing.id, submittedAt: existing.submittedAt } : null,
    );
    if (decision === 'review') {
      // No `server` means the entry the form showed is gone (deleted while this waited): the sheet says so.
      const server: OutboxServerEntry | undefined = existing ? { id: existing.id, submittedAt: existing.submittedAt, stops: existing.stops, sales: existing.sales } : undefined;
      patchItem(ownerId, item.id, { status: 'review', server, error: undefined });
      return { kind: 'review', item: { ...item, status: 'review', server, error: undefined } };
    }
  }
  const sent = await noteGate(() => apiRaw<GaugeEntryWithMeta>('/gauges', { method: 'POST', json: force ? forcedInput(item.input) : item.input }));
  if ('error' in sent) return handleError(ownerId, item, sent.error, sent.gate);
  discardOutboxItem(ownerId, item.id);
  return { kind: 'sent', outcome: replayOutcome(sent.value.status) === 'logged' ? 'logged' : 'updated', entry: sent.value.data ?? null };
}

// One replay at a time: replayAll and "Send mine anyway" never race on the same item.
let tail: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = tail.then(fn, fn);
  tail = p.catch(() => undefined);
  return p;
}

let inflight: Promise<ReplayReport> | null = null;
let replaying = false;
const replayListeners = new Set<() => void>();
function setReplaying(v: boolean): void {
  replaying = v;
  for (const l of replayListeners) l();
}

/** True while a replay is running (the banner's "Send now" shows a spinner). */
export function useReplaying(): boolean {
  return useSyncExternalStore(
    (l) => {
      replayListeners.add(l);
      return () => replayListeners.delete(l);
    },
    () => replaying,
    () => false,
  );
}

/**
 * Send every waiting item, oldest first. Single-flight: a call while one is running gets the running one (which
 * re-reads the list after each item, so anything queued meanwhile goes too). A NetworkError, a 401 or a server error
 * stops the loop; the remaining items keep waiting.
 */
export function replayAll(ownerId: number): Promise<ReplayReport> {
  if (inflight) return inflight;
  inflight = exclusive(async () => {
    const report: ReplayReport = { sent: [], review: [], failed: [], stopped: null };
    const tried = new Set<string>();
    setReplaying(true);
    try {
      for (;;) {
        const next = getOutbox(ownerId).find((i) => i.status === 'waiting' && !tried.has(i.id));
        if (!next) break;
        tried.add(next.id);
        const step = await replayOne(ownerId, next, false);
        if (step.kind === 'sent') report.sent.push({ item: next, outcome: step.outcome, entry: step.entry });
        else if (step.kind === 'review') report.review.push(step.item);
        else if (step.kind === 'failed') report.failed.push(step.item);
        else {
          report.stopped = step.reason;
          break;
        }
      }
    } finally {
      setReplaying(false);
    }
    return report;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** "Send mine anyway" for one review / failed item: POST it whatever the server holds now. */
export function sendAnyway(ownerId: number, id: string): Promise<ReplayReport> {
  return exclusive(async () => {
    const report: ReplayReport = { sent: [], review: [], failed: [], stopped: null };
    const item = getOutbox(ownerId).find((i) => i.id === id);
    if (!item) return report;
    setReplaying(true);
    try {
      const step = await replayOne(ownerId, item, true);
      if (step.kind === 'sent') report.sent.push({ item, outcome: step.outcome, entry: step.entry });
      else if (step.kind === 'failed') report.failed.push(step.item);
      else if (step.kind === 'review') report.review.push(step.item);
      else report.stopped = step.reason;
    } finally {
      setReplaying(false);
    }
    return report;
  });
}

/** "2 entries" / "1 entry". */
export const entriesLabel = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
