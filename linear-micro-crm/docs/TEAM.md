# How Linear Hub was built

Linear Hub is written, owned and supported by **Noryn System Ltd**, and licensed to Linear MCR Limited under the
written agreement between the two companies (see [`LICENSE`](../LICENSE)).

## Who built it

**One developer at Noryn System Ltd**, directing **AI coding agents** (Anthropic's Claude) that wrote most of the
code. There is no larger team behind it. Earlier versions of this page named a team of five people: those people
did not exist, and the page was wrong to say so.

The developer's part: agreeing the scope with Linear MCR, splitting each release into work packages, writing each
package's brief and its rules, deciding the trade-offs, reading every review and deciding what ships. The agents'
part: reading the code, writing tests and code, running the checks, and reporting what they did and what they could
not do.

## How the work is organised

1. **Work packages in parallel.** Each release is split into packages with a clear owner and a written list of the
   files it may change (for 1.5: sign-in, keys and backups, money, phone, docs, and quality). Each package is built by
   its own agent in its own copy of the code (a git worktree on its own branch), at the same time as the others.
   Names that several packages share (settings, commands, functions) are agreed before any code is written.
2. **Tests first.** A problem that can be tested is first written down as a test that fails, then fixed, then shown to
   pass. The rules that decide pay, gauges, permissions and dates live in `shared/` and have their own tests.
3. **The same checks for every change.** Type checking, the shared and server test suites (over 1,300 automated tests
   at 1.4.0), an end-to-end check of the API, and a production build. GitHub Actions runs them on every change; the
   app's start-up is also checked on macOS.
4. **Integration.** One step merges the packages, resolves where they meet, writes the release notes from each
   package's notes, and runs every check again.
5. **Independent reviews.** After a release, separate reviewers test it against what was promised, one area each:
   claims, security, money, reliability, phone use and code quality. A second reviewer checks each first reviewer's
   findings, confirms or rejects them, and looks for what was missed. The findings become the next round of work:
   release 1.5 answers the 92 findings of the review of 1.4.0.
6. **Screens.** The screens are checked by scripted browser runs at phone and laptop sizes, in light and dark, while
   each package is built. Those runs are not yet part of the automated checks (see [`ROADMAP.md`](ROADMAP.md)).

## What this means for Linear MCR

- **It moves fast.** Release 1.0 came out on 15 October 2026 and 1.4.0's final version on 26 October: each release
  takes days, not months.
- **The safety net is the tests and the reviews,** not a person reading every line. No one has read all of the
  roughly 130,000 lines line by line. The parts that matter most (pay, payments, sign-in, backups) have the most tests
  and the strictest reviews, and each review's findings are written down and answered in the next release.
- **One developer is a single point of failure.** [`MAINTAINERS.md`](MAINTAINERS.md) is written so another developer
  can take Linear Hub over: how it fits together, where the rules live, how to change it safely and how releases work.

Questions about how Linear Hub is built or supported: hq@norynsystem.com.
