/**
 * Moves the JavaScript clock of a test process to LM_TEST_FAKE_NOW, so the suite can be run "on another day".
 * Loaded with NODE_OPTIONS="--import=<this file>" by scripts/test-at.mjs; it does nothing when the variable is unset.
 *
 * Date.now(), new Date() and Date() all read the moved clock, and it keeps ticking from there. Everything else stays
 * real: timers, performance.now(), file times and SQLite's own 'now'. So a test that compares a file's time with the
 * clock sets that time itself (utimes) rather than relying on when the file was written.
 *
 * The first process works out how far to move the clock and leaves it in LM_TEST_CLOCK_OFFSET_MS. Child processes
 * (each test file, and any server a test starts) inherit that and NODE_OPTIONS, so they all share one moved clock
 * instead of each starting again from LM_TEST_FAKE_NOW.
 */
const RealDate = Date;

function offsetMs() {
  const inherited = process.env.LM_TEST_CLOCK_OFFSET_MS;
  if (inherited) {
    const n = Number(inherited);
    if (!Number.isFinite(n)) throw new Error(`LM_TEST_CLOCK_OFFSET_MS is not a number: ${inherited}`);
    return n;
  }
  const raw = process.env.LM_TEST_FAKE_NOW;
  if (!raw) return null;
  const target = new RealDate(raw).getTime();
  if (Number.isNaN(target)) throw new Error(`LM_TEST_FAKE_NOW is not a date: ${raw}`);
  const n = target - RealDate.now();
  process.env.LM_TEST_CLOCK_OFFSET_MS = String(n);
  return n;
}

const offset = offsetMs();

if (offset !== null) {
  const now = () => RealDate.now() + offset;

  globalThis.Date = new Proxy(RealDate, {
    // new Date() with no arguments is "now"; any other form is a fixed date and passes through unchanged
    construct(Target, args, newTarget) {
      return Reflect.construct(Target, args.length === 0 ? [now()] : args, newTarget);
    },
    // Date() called without new returns the current time as a string
    apply() {
      return new RealDate(now()).toString();
    },
    get(Target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(Target, prop, receiver);
    },
  });
}
