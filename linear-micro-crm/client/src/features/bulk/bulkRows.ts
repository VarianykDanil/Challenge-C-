// Release 1.2 — U2 bulk-entry: the bulk grid's row model (pure, no React). OWNED BY U2.
//
// A row is one team member. What the server already holds for them on this event's date is the `base`; what the
// leader typed or pasted is the `edit`. A row is sent only when it says something new: a member with no entry yet and
// at least one number typed (blanks count as 0), or a logged member whose numbers or check-in changed. Notes are never
// touched here (the API keeps an omitted note).
import type { BulkGaugeRow, GaugeEntryWithMeta, GaugeKey, GaugeTotals } from '@lm/shared';
import { GAUGE_KEYS, GAUGE_MAX_PER_DAY, pasteFunnelIssues } from '@lm/shared';

export type Cells = Record<GaugeKey, string>;

export interface BaseEntry {
  id: number;
  values: GaugeTotals;
  /** "HH:mm" when the stored check-in is on the event's date, else '' (kept as it is unless the leader types one). */
  checkIn: string;
}

export interface RowEdit {
  cells: Cells;
  /** "HH:mm" or ''. */
  checkIn: string;
  /** Line key of the paste that filled the row, until it is typed over. */
  pasteKey?: string | null;
}

/** logged = saved and unchanged · update = saved, changed · new = not saved yet, has numbers · empty = nothing to send. */
export type RowStatus = 'logged' | 'update' | 'new' | 'empty';

export const EMPTY_CELLS: Cells = { stops: '', table: '', presentations: '', closes: '', taps: '', sales: '' };

export const cellsFrom = (t: GaugeTotals): Cells => ({
  stops: String(t.stops), table: String(t.table), presentations: String(t.presentations), closes: String(t.closes), taps: String(t.taps), sales: String(t.sales),
});

/** Blank cells count as 0. */
export function cellsToTotals(c: Cells): GaugeTotals {
  const n = (s: string) => (s === '' ? 0 : Number(s));
  return { stops: n(c.stops), table: n(c.table), presentations: n(c.presentations), closes: n(c.closes), taps: n(c.taps), sales: n(c.sales) };
}

export const isBlank = (c: Cells) => GAUGE_KEYS.every((k) => c[k] === '');

/** Digits only, at most four (the per-day cap is 2,000). */
export const cleanCell = (raw: string) => raw.replace(/\D/g, '').slice(0, 4).replace(/^0+(?=\d)/, '');

/** The stored check-in as "HH:mm" when it is on the event's date ("" otherwise). */
export function checkInHHMM(checkedInAt: string | null, date: string): string {
  if (!checkedInAt || checkedInAt.slice(0, 10) !== date) return '';
  return checkedInAt.slice(11, 16);
}

export function baseFrom(entry: GaugeEntryWithMeta): BaseEntry {
  return {
    id: entry.id,
    values: { stops: entry.stops, table: entry.table, presentations: entry.presentations, closes: entry.closes, taps: entry.taps, sales: entry.sales },
    checkIn: checkInHHMM(entry.checkedInAt, entry.date),
  };
}

const sameTotals = (a: GaugeTotals, b: GaugeTotals) => GAUGE_KEYS.every((k) => a[k] === b[k]);

export function rowStatus(base: BaseEntry | null, edit: RowEdit | undefined): RowStatus {
  if (base) {
    if (!edit) return 'logged';
    return sameTotals(cellsToTotals(edit.cells), base.values) && edit.checkIn === base.checkIn ? 'logged' : 'update';
  }
  if (!edit || isBlank(edit.cells)) return 'empty';
  return 'new';
}

/** The cells that break the funnel or the per-day cap, for a red outline. */
export function invalidCells(t: GaugeTotals): Set<GaugeKey> {
  const out = new Set<GaugeKey>();
  GAUGE_KEYS.forEach((k, i) => {
    if (t[k] > GAUGE_MAX_PER_DAY) out.add(k);
    if (i > 0 && t[k] > t[GAUGE_KEYS[i - 1]!]) out.add(k);
  });
  return out;
}

/** What stops a row being saved, checked before sending (the server checks it all again). */
export function rowProblems(edit: RowEdit, ctx: { date: string; today: string; nowHHMM: string }): string[] {
  const issues = pasteFunnelIssues(cellsToTotals(edit.cells));
  if (edit.checkIn && ctx.date === ctx.today && edit.checkIn > ctx.nowHHMM) issues.push(`Check-in (${edit.checkIn}) is later than now`);
  return issues;
}

/** The API row for a changed or new member (null when there is nothing to send). */
export function toBulkRow(userId: number, base: BaseEntry | null, edit: RowEdit | undefined, date: string): BulkGaugeRow | null {
  const status = rowStatus(base, edit);
  if (!edit || status === 'logged' || status === 'empty') return null;
  const row: BulkGaugeRow = { userId, ...cellsToTotals(edit.cells) };
  if (base) {
    // only a changed check-in is sent; an omitted one keeps the stored value
    if (edit.checkIn !== base.checkIn) row.checkedInAt = edit.checkIn ? `${date}T${edit.checkIn}` : null;
  } else if (edit.checkIn) {
    row.checkedInAt = `${date}T${edit.checkIn}`;
  }
  return row;
}

export function sumCells(list: Cells[]): GaugeTotals {
  const t: GaugeTotals = { stops: 0, table: 0, presentations: 0, closes: 0, taps: 0, sales: 0 };
  for (const c of list) {
    const v = cellsToTotals(c);
    for (const k of GAUGE_KEYS) t[k] += v[k];
  }
  return t;
}

// ── the draft kept on this phone ──────────────────────────────────────────

/** Unsaved bulk numbers survive a reload or a lost signal: one draft per person and event, kept for 3 days. */
export interface BulkDraft {
  savedAt: string;
  edits: Record<string, RowEdit>;
}

const DRAFT_PREFIX = 'lm-bulk-draft:';
const DRAFT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const draftKey = (userId: number, eventId: number) => `${DRAFT_PREFIX}${userId}:${eventId}`;

function validEdit(v: unknown): v is RowEdit {
  if (!v || typeof v !== 'object') return false;
  const e = v as RowEdit;
  return typeof e.checkIn === 'string' && !!e.cells && GAUGE_KEYS.every((k) => typeof e.cells[k] === 'string' && /^\d{0,4}$/.test(e.cells[k]));
}

export function loadDraft(userId: number, eventId: number, now = Date.now()): BulkDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(userId, eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BulkDraft>;
    if (typeof parsed.savedAt !== 'string' || !parsed.edits || typeof parsed.edits !== 'object') return null;
    if (now - Date.parse(parsed.savedAt) > DRAFT_MAX_AGE_MS) {
      clearDraft(userId, eventId);
      return null;
    }
    const edits: Record<string, RowEdit> = {};
    for (const [id, e] of Object.entries(parsed.edits)) if (/^\d+$/.test(id) && validEdit(e)) edits[id] = { cells: { ...e.cells }, checkIn: e.checkIn, pasteKey: null };
    return Object.keys(edits).length ? { savedAt: parsed.savedAt, edits } : null;
  } catch {
    return null;
  }
}

export function saveDraft(userId: number, eventId: number, edits: Record<string, RowEdit>): void {
  try {
    if (!Object.keys(edits).length) {
      window.localStorage.removeItem(draftKey(userId, eventId));
      return;
    }
    window.localStorage.setItem(draftKey(userId, eventId), JSON.stringify({ savedAt: new Date().toISOString(), edits } satisfies BulkDraft));
  } catch {
    // storage full or blocked: the numbers stay on the page, they just will not survive a reload
  }
}

export function clearDraft(userId: number, eventId: number): void {
  try {
    window.localStorage.removeItem(draftKey(userId, eventId));
  } catch {
    // ignore
  }
}
