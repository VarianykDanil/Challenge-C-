/**
 * Pure business logic shared by server and client.
 * Owned by the Logic Builder — keep this module free of I/O and framework code.
 * Function signatures are part of the contract; implementations may improve.
 *
 * Modules
 *  - gauges       funnel sums, ratios, benchmarks, projections, performance score
 *  - finance      weekly pay, payroll status, paydays, margins
 *  - punctuality  check-in vs event start
 *  - recruitment  pipeline stages, conversion, time to hire
 *  - leaderboard  stable ranking with ties and movement
 *  - dates        DST-safe YYYY-MM-DD arithmetic and dashboard ranges
 *  - insights     coaching messages
 */
export * from './gauges.ts';
export * from './finance.ts';
export * from './punctuality.ts';
export * from './recruitment.ts';
export * from './leaderboard.ts';
export * from './dates.ts';
export * from './insights.ts';
