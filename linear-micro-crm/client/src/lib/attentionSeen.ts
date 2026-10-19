// Per-device "seen" and "toasted" sets for the Needs-attention feed — OWNED BY p5-needs-attention-feed.
//
// Unread = feed items whose token is not in the seen set. The bell marks what it shows as seen; toasts only ever fire
// for tokens not yet in the toasted set, so a reload never repeats a toast. Both sets live in localStorage under
// `lm-attention-seen:<userId>` / `lm-attention-toasted:<userId>` and keep the 300 most recently touched tokens; every
// fetch touches the tokens of items still in the feed (touchAttentionSet), so only items that have gone are evicted.
// Every storage call is wrapped: with storage blocked (private mode, cleared site data) the sets live in memory for
// the page's lifetime and the bell still works.
import type { AttentionItem } from '@lm/shared';

/** Tokens kept per set (most recently touched win). */
export const ATTENTION_STORE_MAX = 300;

export type AttentionStore = 'seen' | 'toasted';

const PREFIX: Record<AttentionStore, string> = { seen: 'lm-attention-seen:', toasted: 'lm-attention-toasted:' };

/** The storage key for one person's set. */
export function attentionStoreKey(store: AttentionStore, userId: number): string {
  return `${PREFIX[store]}${userId}`;
}

type TokenItem = Pick<AttentionItem, 'key' | 'severity' | 'count'>;

/**
 * What the sets remember for an item: its key, plus `!` while it is a danger, plus `#<count>` for a summary item
 * (a team gap, overdue follow-ups, runs to pay). An item that escalates (Runs to pay turning overdue) or whose count
 * GROWS (a third person missing from a gap) therefore counts as new once more; one that calms down or shrinks is
 * already known (see isKnownAttention).
 */
export function attentionToken(item: TokenItem): string {
  const base = item.severity === 'danger' ? `${item.key}!` : item.key;
  return typeof item.count === 'number' && Number.isInteger(item.count) && item.count > 0 ? `${base}#${item.count}` : base;
}

/** `gauges:gap:5#3` → { base: 'gauges:gap:5', count: 3 }; a token without a count → count null. Keys never hold '#'. */
function splitToken(token: string): { base: string; count: number | null } {
  const at = token.lastIndexOf('#');
  if (at < 0) return { base: token, count: null };
  const count = Number(token.slice(at + 1));
  return Number.isInteger(count) && count > 0 ? { base: token.slice(0, at), count } : { base: token, count: null };
}

/** The tokens in `list` that already account for `item`: its exact token, or the same summary with a count ≥ its count. */
function knownTokens(list: Iterable<string>, item: TokenItem): string[] {
  const token = attentionToken(item);
  const { base, count } = splitToken(token);
  const out: string[] = [];
  for (const t of list) {
    if (t === token) out.push(t);
    else if (count !== null) {
      const s = splitToken(t);
      if (s.base === base && s.count !== null && s.count >= count) out.push(t);
    }
  }
  return out;
}

/** True when `set` already accounts for the item (seen / toasted at this severity and at least this count). */
export function isKnownAttention(set: ReadonlySet<string>, item: TokenItem): boolean {
  return set.has(attentionToken(item)) || knownTokens(set, item).length > 0;
}

// The in-memory copy: the source of truth when storage is unavailable, and kept in step when it is not.
const memory = new Map<string, string[]>();

function readList(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter((t): t is string => typeof t === 'string').slice(-ATTENTION_STORE_MAX);
        memory.set(storageKey, list);
        return list;
      }
    }
  } catch {
    // blocked or corrupt storage: fall back to this page's memory
  }
  return memory.get(storageKey) ?? [];
}

function writeList(storageKey: string, list: string[]): void {
  const trimmed = list.slice(-ATTENTION_STORE_MAX);
  memory.set(storageKey, trimmed);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(trimmed));
  } catch {
    // quota or blocked storage: the memory copy still answers for this page
  }
}

/** The set for one person (an empty set when nothing is stored). */
export function readAttentionSet(store: AttentionStore, userId: number): Set<string> {
  return new Set(readList(attentionStoreKey(store, userId)));
}

/**
 * Adds the items' tokens at the newest end (moving them if already there). A summary's lower-count tokens are dropped
 * as it is added at a higher count, so one summary holds one token per severity.
 */
export function addToAttentionSet(store: AttentionStore, userId: number, items: ReadonlyArray<TokenItem>): Set<string> {
  const storageKey = attentionStoreKey(store, userId);
  const tokens = items.map(attentionToken);
  if (!tokens.length) return new Set(readList(storageKey));
  const adding = new Set(tokens);
  const superseded = (t: string) => {
    const s = splitToken(t);
    if (s.count === null) return false;
    return tokens.some((a) => {
      const n = splitToken(a);
      return n.base === s.base && n.count !== null && n.count >= s.count!;
    });
  };
  const list = [...readList(storageKey).filter((t) => !adding.has(t) && !superseded(t)), ...adding];
  writeList(storageKey, list);
  return new Set(list.slice(-ATTENTION_STORE_MAX));
}

/**
 * Moves the stored tokens that still account for an item in the feed to the newest end, so a long-lived item (two-step
 * off, Runs to pay) is never evicted by 300 newer tokens and then shown or toasted again. Writes only when the order
 * actually changes (normally once, after something new was added), so a poll costs one read.
 */
export function touchAttentionSet(store: AttentionStore, userId: number, items: ReadonlyArray<TokenItem>): void {
  if (!items.length) return;
  const storageKey = attentionStoreKey(store, userId);
  const list = readList(storageKey);
  const live = new Set<string>();
  for (const item of items) for (const t of knownTokens(list, item)) live.add(t);
  if (!live.size) return;
  const next = [...list.filter((t) => !live.has(t)), ...list.filter((t) => live.has(t))];
  if (next.every((t, i) => t === list[i])) return;
  writeList(storageKey, next);
}

/** Items the `seen` set does not account for yet. */
export function unreadAttention<T extends TokenItem>(items: ReadonlyArray<T>, seen: ReadonlySet<string>): T[] {
  return items.filter((i) => !isKnownAttention(seen, i));
}

/** Info items stay in the bell; the one exception is good news about your own pay. */
export function isToastable(item: Pick<AttentionItem, 'key' | 'severity'>): boolean {
  return item.severity !== 'info' || item.key.startsWith('pay:paid:');
}

/** At most this many toasts from the first fetch after a page load, and from each later fetch. */
export const ATTENTION_TOASTS_FIRST = 1;
export const ATTENTION_TOASTS_LATER = 3;

/**
 * Which items to toast now. `fresh` are toastable items not yet toasted and not already seen in the bell (the feed is
 * sorted, so the first is the most severe); `show` is the first `limit` of them, or none while a dialog is open.
 * The caller records every `fresh` item as toasted: whatever is not shown now waits in the bell instead of popping up
 * one poll later.
 */
export function pickAttentionToasts<T extends TokenItem>(
  items: ReadonlyArray<T>,
  opts: { seen: ReadonlySet<string>; toasted: ReadonlySet<string>; limit: number; blocked: boolean },
): { show: T[]; fresh: T[] } {
  const fresh = items.filter((i) => isToastable(i) && !isKnownAttention(opts.toasted, i) && !isKnownAttention(opts.seen, i));
  return { show: opts.blocked ? [] : fresh.slice(0, Math.max(0, opts.limit)), fresh };
}

/**
 * True while a dialog is really open: a Modal (role=dialog), the topbar's page search or the bell's own panel. The
 * mobile nav drawer is always in the DOM with role=dialog, so dialogs inside an inert / aria-hidden subtree, or with
 * no layout box, do not count.
 */
export function isDialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(
    (el) => !el.closest('[inert], [aria-hidden="true"]') && el.getClientRects().length > 0,
  );
}
