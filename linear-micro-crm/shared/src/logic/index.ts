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
 *
 * Smart release 1.1 (p1 lays down every module so nobody else edits this file; owners replace stub bodies):
 *  - stats          mean, SD, z-tests, Poisson tail, quantiles, weekly series        (p1)
 *  - baseline       personal pace against your own usual weeks                       (p2)
 *  - streaks        sales streaks and personal-best weeks                             (p2)
 *  - payForecast    this week's pay estimate and bonus distance                       (p3)
 *  - payrollFlags   advisory checks before paying                                     (p3)
 *  - signals        "Check in with…" reasons and ranking                              (p4)
 *  - attention      the Needs-attention feed rules                                    (p5)
 *  - eventForecast  event expected sales and suggested targets                        (p6)
 *  - outbox         replay rule for gauges saved offline                              (p7)
 *  - digest         "Your week in review"                                             (p9)
 */
export * from './gauges.ts';
export * from './finance.ts';
export * from './punctuality.ts';
export * from './recruitment.ts';
export * from './leaderboard.ts';
export * from './dates.ts';
export * from './insights.ts';
export * from './stats.ts';
export * from './baseline.ts';
export * from './streaks.ts';
export * from './payForecast.ts';
export * from './payrollFlags.ts';
export * from './signals.ts';
export * from './attention.ts';
export * from './eventForecast.ts';
export * from './outbox.ts';
export * from './digest.ts';
