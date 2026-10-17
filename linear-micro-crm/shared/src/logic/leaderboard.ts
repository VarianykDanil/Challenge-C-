/**
 * Ranking helpers for leaderboards.
 */

/** Either a numeric property name or an accessor returning the number to rank by. */
export type Metric<T> = keyof T | ((row: T) => number);

export interface RankOptions<T> {
  /** `desc` (default) ranks the biggest value first. */
  direction?: 'asc' | 'desc';
  /**
   * Secondary metric that decides the *order* of rows tied on `metric` (bigger secondary first), before falling
   * back to input order. It never splits the rank: rows with the same primary value always share one rank.
   */
  tieBreak?: Metric<T>;
}

export type Ranked<T> = T & { rank: number };

function read<T>(row: T, metric: Metric<T>): number {
  const raw = typeof metric === 'function' ? metric(row) : (row[metric] as unknown);
  const n = Number(raw);
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Sort rows by `metric` and assign competition ranks ("1, 2, 2, 4"): equal primary values share a rank and the
 * next distinct value skips ahead, whatever the tie-break says — `tieBreak` only orders the rows inside a tie.
 * The sort is stable — rows that tie on every criterion keep their input order. Returns new objects; the input
 * is not mutated.
 */
export function rankRows<T extends object>(
  rows: ReadonlyArray<T>,
  metric: Metric<T>,
  options: RankOptions<T> = {},
): Ranked<T>[] {
  const dir = options.direction === 'asc' ? 1 : -1;
  const indexed = rows.map((row, index) => ({
    row,
    index,
    primary: read(row, metric),
    secondary: options.tieBreak ? read(row, options.tieBreak) : 0,
  }));
  indexed.sort((a, b) => {
    if (a.primary !== b.primary) return (a.primary - b.primary) * dir;
    if (a.secondary !== b.secondary) return (b.secondary - a.secondary) * -dir;
    return a.index - b.index;
  });
  const out: Ranked<T>[] = [];
  let rank = 0;
  for (let i = 0; i < indexed.length; i++) {
    const cur = indexed[i];
    const prev = indexed[i - 1];
    if (i === 0 || cur.primary !== prev.primary) rank = i + 1;
    out.push({ ...cur.row, rank });
  }
  return out;
}

/**
 * Rank movement since the previous period: positive = moved up (e.g. 5 → 2 gives +3),
 * negative = dropped, 0 = unchanged, null = new entrant.
 */
export function movement(prevRank: number | null | undefined, currentRank: number): number | null {
  if (prevRank === null || prevRank === undefined || !Number.isFinite(prevRank)) return null;
  return prevRank - currentRank;
}

/** The first `n` rows (a leaderboard excerpt); `n <= 0` gives an empty list. */
export function topN<T>(rows: ReadonlyArray<T>, n: number): T[] {
  return n > 0 ? rows.slice(0, n) : [];
}

/** Find a row's rank by a key, or null when it isn't ranked. */
export function rankOf<T extends { rank: number }>(rows: ReadonlyArray<T>, predicate: (row: T) => boolean): number | null {
  const hit = rows.find(predicate);
  return hit ? hit.rank : null;
}
