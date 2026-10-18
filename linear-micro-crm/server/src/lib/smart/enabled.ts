/**
 * The smart release kill switch (p1). `LM_SMART=0` turns every smart builder off: they return null / [] / an empty
 * Map, so routes attach nothing (optional keys stay absent) and /me/insights, /me/attention and /me/digest answer
 * with empty payloads. Read on every call (cheap), so tests and operators can flip it without a restart.
 */
export function smartEnabled(): boolean {
  return process.env.LM_SMART?.trim() !== '0';
}
