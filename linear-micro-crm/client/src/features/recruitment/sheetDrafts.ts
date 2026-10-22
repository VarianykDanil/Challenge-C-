// Release 1.3 — OWNED BY P7 recruitment-plus. What an interview sheet page had not saved yet when it was left, kept
// in this tab so opening the sheet again carries straight on: words still on their way (the save after leaving, or the
// last save as the tab reloads), and questions in conflict with another device (the interviewer still chooses, Keep
// mine / Use theirs). Kept in memory for the page load and in sessionStorage for a reload; read once when the sheet
// opens again, by the same person only (a draft of someone else's is dropped).
//
// A draft is always the page's LATEST rows (written as the page is left, or as the tab closes or reloads, never while
// it is still being typed into), so the next page may treat the saves of the devices it lists as its own.
import { sheetRowChanged, type SheetEditRow } from '@lm/shared';

export interface SheetDraft {
  /** Who it belongs to (drafts never cross people on a shared tab). */
  userId: number;
  /** Every row of the page as it was left (in step ones too: the merge with the server sorts them out). */
  rows: SheetEditRow[];
  /** Questions taken off and not saved yet. */
  removed: SheetEditRow[];
  /** The device ids whose saves were this tab's (this page load's, and the earlier pages' that this one carried on). */
  devices: string[];
  /** When it was kept (ms since 1970). */
  at: number;
}

const memory = new Map<number, SheetDraft>();
/** The sheet page that is (or was last) open for each interview: a page left earlier never writes over its draft. */
const owners = new Map<number, symbol>();
const KEY = (interviewId: number) => `lm:sheet-draft:${interviewId}`;

/** Something on the page is not saved: a change, an added or taken-off question, or a question in conflict. */
export function draftHasUnsaved(rows: readonly SheetEditRow[], removed: readonly SheetEditRow[]): boolean {
  return removed.length > 0 || rows.some((r) => r.conflict !== null || r.added || sheetRowChanged(r));
}

function writeStorage(interviewId: number, draft: SheetDraft | null): void {
  try {
    if (draft) sessionStorage.setItem(KEY(interviewId), JSON.stringify(draft));
    else sessionStorage.removeItem(KEY(interviewId));
  } catch {
    // Private mode or full storage: the in-memory copy still covers opening the sheet again in this page load.
  }
}

function readStorage(interviewId: number): SheetDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY(interviewId));
    if (!raw) return null;
    const d = JSON.parse(raw) as SheetDraft;
    return d && Array.isArray(d.rows) && Array.isArray(d.removed) && Array.isArray(d.devices) && typeof d.userId === 'number' ? d : null;
  } catch {
    return null;
  }
}

/** Keeps (or, with nothing unsaved, drops) the draft of the sheet page `owner`, unless a newer page has opened since. */
export function keepSheetDraft(interviewId: number, owner: symbol, draft: Omit<SheetDraft, 'at'>): void {
  const current = owners.get(interviewId);
  if (current !== undefined && current !== owner) return;
  if (!draftHasUnsaved(draft.rows, draft.removed)) {
    dropSheetDraft(interviewId);
    return;
  }
  const full: SheetDraft = { ...draft, at: Date.now() };
  memory.set(interviewId, full);
  writeStorage(interviewId, full);
}

export function dropSheetDraft(interviewId: number): void {
  memory.delete(interviewId);
  writeStorage(interviewId, null);
}

/** The draft left for this interview by this person, if any. Reads only (opening the page claims it). */
export function peekSheetDraft(interviewId: number, userId: number | null | undefined): SheetDraft | null {
  const d = memory.get(interviewId) ?? readStorage(interviewId);
  return d && userId != null && d.userId === userId ? d : null;
}

/** A sheet page opened: it owns the interview's draft from now on (the one it carried on from is cleared). */
export function claimSheetDraft(interviewId: number, owner: symbol): void {
  owners.set(interviewId, owner);
  dropSheetDraft(interviewId);
}

/** No newer sheet page has opened for this interview since `owner` (it may still write the draft or warn). */
export function ownsSheetDraft(interviewId: number, owner: symbol): boolean {
  return owners.get(interviewId) === owner;
}
