// Release 1.3 — OWNED BY P7 recruitment-plus. One save at a time per interview sheet, in order, outside React: a save
// queued while another is on its way (a slow hotspot) still goes straight after it, even when the page has been left
// in the meantime (TanStack Query skips a mutate() call's own callbacks once the component has gone, which lost the
// later answers before). Each job builds its payload when it runs, from the page's latest rows.
//
// Every save also says which device sent it: SHEET_DEVICE, an id this tab makes up once per page load (so a sheet
// opened again in the same tab keeps it), and nextSheetVersion(), the tab's save number. The server stamps the rows it
// writes with them and never takes a device's own earlier save for another device's change: the last save, sent at
// once as the tab closes or reloads while an earlier one is still on its way, is written instead of refused.

const queues = new Map<number, Promise<void>>();

/** Runs `job` after every save already queued for this interview. Never rejects (the job handles its own errors). */
export function queueSheetSave(interviewId: number, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(interviewId) ?? Promise.resolve()).then(job).catch(() => undefined);
  queues.set(interviewId, next);
  void next.then(() => {
    if (queues.get(interviewId) === next) queues.delete(interviewId);
  });
  return next;
}

/** A save for this interview is on its way or waiting. */
export function sheetSaveBusy(interviewId: number): boolean {
  return queues.has(interviewId);
}

/**
 * 24 random hex characters after "tab-". crypto.getRandomValues works over plain http on the office network too
 * (crypto.randomUUID needs https or localhost).
 */
function makeDeviceId(): string {
  const bytes = new Uint8Array(12);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `tab-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** This tab's device id for interview sheet saves (shared SHEET_DEVICE_PATTERN). */
export const SHEET_DEVICE = makeDeviceId();

let version = 0;

/** The next save number from this tab: 1, 2, 3 … (the server keeps the highest it has written for each answer). */
export function nextSheetVersion(): number {
  version += 1;
  return version;
}
