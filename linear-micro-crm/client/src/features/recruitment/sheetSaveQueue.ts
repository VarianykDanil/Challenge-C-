// Release 1.3 — OWNED BY P7 recruitment-plus. One save at a time per interview sheet, in order, outside React: a save
// queued while another is on its way (a slow hotspot) still goes straight after it, even when the page has been left
// in the meantime (TanStack Query skips a mutate() call's own callbacks once the component has gone, which lost the
// later answers before). Each job builds its payload when it runs, from the page's latest rows.

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
