/**
 * Gauge outbox replay rule — OWNED BY p7-signal-proof-logging.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p7 replaces the bodies.
 */

export type ReplayDecision = 'send' | 'review';

/** What the phone knew when it queued the entry. */
export interface QueuedGaugeMeta {
  /** ISO timestamp the entry was saved on the phone. */
  queuedAt: string;
  /** The existing entry id the modal had prefilled when queuing, or null when there was none. */
  expectedExistingId: number | null;
}

/** The entry the server holds now for the same (event, user, date), if any. */
export interface ExistingEntryMeta {
  id: number;
  submittedAt: string;
}

/**
 * 'send' when it is safe to POST the queued entry; 'review' when an entry exists that the user had not seen when
 * queuing (expectedExistingId is null, the id differs, or it was submitted after queuedAt).
 */
export function replayDecision(item: QueuedGaugeMeta, existing: ExistingEntryMeta | null): ReplayDecision {
  void item;
  void existing;
  return 'review'; // p1 stub: the safe answer (never overwrite)
}
