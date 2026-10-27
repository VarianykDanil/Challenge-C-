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
 *
 * Release 1.2 (r2-foundation lays down every module so nobody else edits this file; owners replace stub bodies):
 *  - learning          COD pack lesson rules and the progression tracker                (L1)
 *  - pitchScript       pitch script parser, step targets, fact-check notes              (L2)
 *  - pitchAnnotations  phrase rules → COD pack theory chips                             (L2)
 *  - pin               PIN format rules                                                 (U1)
 *  - bulkPaste         "Paste from WhatsApp" parser for bulk gauge entry                (U2)
 *  - audit             audit snapshot diff and redacted keys                            (U3)
 *  - shiftCheckIn      one-tap shift check-in status and undo window                    (U4)
 *  - search            command palette query rules                                      (U5)
 *  - payExport         payroll export rows and CSV (Xero, Sage)                          (U5)
 *  - lessonTitles      lesson key → title, for summaries the server writes                (UC fix group)
 *
 * Release 1.3 (r3-foundation lays down every module so nobody else edits this file; owners replace stub bodies):
 *  - payRule           base-or-commission week pay and its explanation                   (P1)
 *  - invoices          self-billing invoice number and the deemed-accepted moment        (P2)
 *  - statements        commission statement column detection and name matching           (P3)
 *  - exportFormat      CSV / PDF export helpers (orientation, safe text)                 (P4)
 *  - videos            learning video topics, embed URLs, watched rule                   (P5)
 *  - clientPortal      client post labels, access codes                                  (P6)
 *  - recruitmentPlus   candidate age, Under 18, timeline                                 (P7)
 *  - venues            venue key, event plan maths                                       (P8)
 *
 * Release 1.3.1:
 *  - people            names without a surname, who may add people, sign-in instructions
 *  - access            setup codes, trial mode and secure-connection wording
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
// Release 1.2
export * from './learning.ts';
export * from './pitchScript.ts';
export * from './pitchAnnotations.ts';
export * from './pin.ts';
export * from './bulkPaste.ts';
export * from './audit.ts';
export * from './shiftCheckIn.ts';
export * from './search.ts';
export * from './payExport.ts';
export * from './lessonTitles.ts';
// Release 1.3
export * from './payRule.ts';
export * from './invoices.ts';
export * from './statements.ts';
export * from './exportFormat.ts';
export * from './videos.ts';
export * from './clientPortal.ts';
export * from './recruitmentPlus.ts';
export * from './venues.ts';
// Release 1.3.1
export * from './people.ts';
export * from './access.ts';
// Release 1.4
export * from './payments.ts';
export * from './bankFiles.ts';
