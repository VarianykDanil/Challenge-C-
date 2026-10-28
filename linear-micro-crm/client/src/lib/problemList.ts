/**
 * A refused request lists at most 20 problems, then one line "And N more problems" (server app.ts). The one-line
 * message shows the first few and counts the rest, the unlisted ones included.
 */
const MORE_PROBLEMS = /^And (\d+) more problems?$/;

/** The first `max` problem lines, and how many more there are in all. */
export function summariseProblems(lines: string[], max: number): { shown: string[]; more: number } {
  const unlisted = Number(MORE_PROBLEMS.exec(lines.at(-1) ?? '')?.[1] ?? 0);
  const listed = unlisted > 0 ? lines.slice(0, -1) : lines;
  const shown = listed.slice(0, max);
  return { shown, more: listed.length - shown.length + unlisted };
}
