# P1 pay-rule: base or commission, cancellations, the breakdown

From 1.3 each pay week pays the base (£63.50 × days worked) or the commission (paid subs × each campaign's rate), whichever is higher; cancellations confirmed by the clients correct the next unpaid week; Matt adds bonuses by hand.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P1 pay-rule**.

The owner's decision 2, quoted: "base = £63.50 × days worked … If commission < base → paid the BASE only … If
commission ≥ base → paid the COMMISSION only … NO automatic sales bonus and NO automatic leader overrides … Matt adds a
bonus to individual top performers by hand. The breakdown must show all of this."

## API

All routes are under `/api/pay` (`server/src/routes/pay.ts`). Types are in `shared/src/types/pay.ts`. Every route
needs a signed-in session: an anonymous caller gets **401**, and a client account gets **403** with code
`clientPortalOnly` from the client guard before the router runs. "Own team" means the leader's `teamId`; a leader with no
team sees only their own pay.

| Method and path | Body / query | Answer | admin | leader | rep / recruiter |
| --- | --- | --- | --- | --- | --- |
| `GET /pay/settings` | — | `PayRuleSettings` `{ dayRate, ruleFrom }` | ✓ | 403 | 403 |
| `PUT /pay/settings` | `PayRuleSettingsInput` `{ dayRate?, ruleFrom? }` (strict) | `PayRuleSettings` | ✓ | 403 | 403 |
| `GET /pay/rates?campaignId=` | optional campaign | `CampaignRate[]`, newest first | ✓ | ✓ | 403 |
| `POST /pay/rates` | `CampaignRateInput` `{ campaignId, repRate, payoutRate, effectiveFrom }` | **201** `CampaignRate` (source `admin`) | ✓ | 403 | 403 |
| `GET /pay/breakdown?userId=&weekStart=` | default: the caller, this week | `WeekPayBreakdown` | anyone | own team | own only |
| `GET /pay/adjustments?userId=&weekStart=` | `weekStart` = the week a line lands on | `PayAdjustment[]` (newest week first, up to 200) | everyone (no `userId`) | own team | own only |
| `POST /pay/bonuses` | `BonusInput` `{ userId, weekStart, amount > 0, note }` | **201** `PayAdjustment` (kind `bonus`) | ✓ | 403 | 403 |
| `POST /pay/adjustments` | `ManualAdjustmentInput` `{ userId, targetWeekStart, sourceWeekStart?, amount ≠ 0, note }` | **201** `PayAdjustment` (kind `manual`); its `targetWeekStart` is the week it landed on (see below) | ✓ | 403 | 403 |
| `DELETE /pay/adjustments/:id` | — | **204** | ✓ | 403 | 403 |

**Status codes:**

- **400**:
  - a day rate that is not more than £0 or is over £500;
  - a rule date that is not a Monday or is after this week;
  - unknown keys in the settings body;
  - a breakdown more than 28 days ahead;
  - a bonus or adjustment more than four weeks ahead, or before the person started;
  - a £0 amount, or a note that is missing or over 300 characters;
  - a person on a salaried plan, which is not paid weekly;
  - a rate dated more than a year ahead;
  - a line taking off more than a finished week pays: "That would take Bo's pay for w/c 5 Oct below £0 (−£36.50). Take off at most £63.50 here and put the rest on a later week." Nothing is written.
- **201 on another week**: a line put on a past week the person did not work lands on their next open week (see Logic), and the answer's `targetWeekStart` says which.
- **403**: the role is not allowed, or the person is outside the caller's scope ("You can only see your own pay", "Leaders can only see their own team's pay").
- **404**: an unknown person, a client account as `userId`, an unknown campaign or an unknown adjustment.
- **409**:
  - the week is already paid: "The week w/c 5 Oct has already been paid. Choose the next unpaid week.";
  - removing a line that came from a statement or a dispute;
  - `POST /finance/payroll/:id/pay` for a run below £0: "Bo's pay for w/c 5 Oct comes to −£36.50, below £0, so it cannot be marked paid. Add an adjustment to carry part of a correction to a later week first." (before P2's invoice check).

**`WeekPayBreakdown`**:

- The STABLE fields from the foundation: `rule`, `daysWorked`, `dayRate`, `baseAmount`, `commissionAmount`, `paidAs`, `lines[]`, `salesLogged`, `salesConfirmed`, `salesCancelled`, `perCampaign[]`, `adjustments[]`, `explanation[]`, `runId`, `status`.
- The additive optional fields:
  - `adjustmentsTotal`, `userName`, `dueDate` and `paidDate`;
  - `corrections[]`: the lines this week's statement figures put on later weeks;
  - `asCalculated`: true when the figures are the run's stored calculation, or a paid 1.2 run's own stored columns;
  - `salaried`;
  - `awaiting[]`: campaign codes whose statement for the week has not arrived.
- `status` is `estimate` when the week has no run yet.
- The explanation says "you" to the person and uses their first name for anyone else: "Jordan worked 4 days".

**Caching:**

- `GET /pay/breakdown` goes through the response cache (`X-Cache: HIT` / `MISS`), keyed on user, role and URL. `GET /pay/adjustments` is a plain list (newest week first, at most 200 lines) and is not cached.
- Every write route above, and every recalculation, bumps the data version, so the next read is fresh.

**Audit.** Each write route has a spec in `server/src/lib/audit/paySpecs.ts`. Examples:

- "Changed pay settings: day rate £63.50 → £65"
- "Added a rate for FXC: £45 a sub to the rep, £125 payout, from 2026-10-05"
- "Added a bonus: Remy Rep w/c 5 Oct, £50 — Top seller in October", followed by a second row "Recalculated after a bonus: … £127 → £177" on the run
- "Added an adjustment …"
- "Removed a bonus …"
- A settings change or a new rate adds one summary row for the unpaid runs it recalculated (none when nothing moved): "Recalculated 7 unpaid pay runs after the pay settings change: £1,778 → £1,960 in all", "Recalculated 1 unpaid pay run after the rate change: £128 → £181 in all".
- The automatic takeover of a dated rate is recorded as Linear Hub (`SYSTEM pay.rates`, entity `campaign`): "FXC rate from Fri 16 Oct in effect: £31 a sub to the rep (was £30), £130 payout (was £120)"

**Changes to existing responses (additive only):**

- `PayrollRun` (`GET /finance/payroll`, `/finance/me`, CSV) fills `paidAs`, `salesLogged`, `salesConfirmed`, `salesCancelled` and `adjustmentsTotal`. The stored calculation (`payroll_runs.breakdown_json`) is never returned.
- `GET /finance/me` → `forecast` and `GET /me/insights` → `personal.payForecast` gain a `rule` block (`PayForecastWithRule`) in a 1.3 week: `{ dayRate, projectedDays, baseLikely, commissionSoFar, commissionLikely, paidAsLikely, ratePerSub, subsToBeatBase, stopsToBeatBase, beatBaseProbability, extras }`. In that case the bonus fields are 0 and `none`. A salaried plan gets no forecast.
- `GET /finance/summary` → `byCampaign[].commission` for 1.3 weeks is subs × the campaign's rep rate on each sale's date (the plan maths before the rule date).

**Server helpers for other packages** (`server/src/lib/payRule.ts`, STABLE):

- `applyConfirmedSales(db, rows, { statementId, actorId, dryRun })` → `ApplyResult` `{ people[], totalDifference }` for P3's statements. Each person gets `{ before, after, difference, effect: 'recalculated' | 'adjustment' | 'no-change', targetWeekStart, adjustmentId, sentence }`. `dryRun` writes nothing.
- `addCampaignRate(db, input, actorId)` for P6's approved client changes (`source: 'client'`, `clientPostId`). A missing `repRate` or `payoutRate` keeps the one in effect on the date.
- `recordCampaignRateChange(db, id, before, after, actorId)` is called by the Campaigns routes when a rate changes in the Campaigns form.
- Breakdown, adjustments and recalculation: `weekPayBreakdown`, `addPayAdjustment` (P2's disputes), `recalculateUnpaidRuns` and `nextUnpaidWeek`.
- Rates and settings: `campaignRateOn`, `listCampaignRates`, `payRuleSettings` and `updatePaySettings`.

## Logic

**The rule** (`shared/src/logic/payRule.ts` → `calculateWeekPay`, `paidAsFor`) works per pay week, Monday to Sunday:

- **Base** = day rate × days worked. The day rate is £63.50 for everyone, set in Settings → Pay. A day worked is a day with gauges that week. A recruiter is office based: Monday to Friday, clamped to their start date and, for the week in progress, to today.
- **Commission** = the week's paid subs × each campaign's rep rate **in effect on the day of the sale**. The rate comes from `campaign_rates`, the newest row with `effective_from` on or before the day, falling back to the campaign's own rate.
- If commission < base, the base is paid and the commission is not. If commission ≥ base, the commission is paid and the base is not. **A tie pays the commission.**
- Then the extras are added and taken off:
  - gross = the paid one + Matt's bonuses + adjustment lines − deductions;
  - there is no automatic bonus and no leader override in a 1.3 week;
  - a negative total is shown as a negative figure.
- **Paid subs** for a campaign are the subs logged in gauges until the client's statement for that week arrives (P3's `sale_confirmations`); then they are the confirmed number.
  - Cancellations come off the **latest days first**, at those days' rates.
  - Subs confirmed beyond those logged are paid at the latest day's rate.
- The breakdown shows "not yet confirmed by BCN" while a campaign that sends statements has not sent that week's. A campaign "sends statements" when it has statement senders, or has sent any confirmation before.
- **Weeks before the rule date** (`PAY_RULE_FROM`, in Settings → Pay) keep the 1.2 pay-plan maths: base + commission + bonus + overrides.
- A pay plan with no day rate and no commission (the owner's salaried plan) is not paid weekly from the rule date. Bonuses and adjustments to it are refused.

**Worked example** (the owner's case):

1. Jordan works Monday to Thursday (4 days) and logs 18 BCN subs. BCN pays the rep £10 a sub.
2. Base = 4 × £63.50 = £254.00. Commission = 18 × £10 = £180.00, below the base, so Jordan is paid **£254.00** and the breakdown marks the commission "Not paid".
3. BCN's statement then confirms 16 of the 18 (2 cancelled). Commission = 16 × £10 = £160.00, still below the base. Pay stays £254.00 and the statement changes nothing. The sentence reads: "2 cancelled by BCN, but the base still applied: no change."
4. In a week where Jordan logged 18 subs at £15, commission was £270.00, so the £270.00 commission was paid. If 2 are then cancelled, the commission is 16 × £15 = £240.00, below the base, so the week should have paid £254.00. The difference is **−£16.00**, not −£30.00.

**Statements** (`applyConfirmedSales`) work per person, week and campaign:

- **An unpaid week** (pending or failed) is recalculated live, before and after each campaign's confirmation, and its run follows.
- **A paid week never changes.** Its correction is **corrected − paid** (`server/src/lib/paidWeek.ts`):
  - "corrected" recalculates the week from the run's **own stored inputs**: the day rate, the rates per day, the logged subs, the bonuses, the corrections and the deductions it was paid with, with every confirmation the week now has. Gauges edited after payday (an admin may; the run is flagged), a rate dated in the past or a new day rate never move it;
  - "paid" is what the run paid plus the statement corrections already made for that week, **for any campaign**: base-or-commission is decided on the whole week, so a second campaign's statement sees the first's correction;
  - every figure is anchored on what was paid, so a statement that confirms exactly the subs paid for changes nothing.
- The difference goes on the person's **next unpaid week** as a correction line:
  - kind `cancellation` when fewer subs were confirmed, `statement` when more;
  - the note reads e.g. "2 cancelled by BCN: paid for 18, confirmed 16";
  - the target is the earliest pending run after that week, else the current week, whose run includes the line when the week closes;
  - a failed transfer is money already owed, so it is not reused as a target.
- Applying the same statement again changes nothing. With different figures, the line is updated in place while its target week is unpaid, and deleted at £0.
- Several rows for one person, campaign and week add up.
- `dryRun` runs the same steps inside a savepoint and rolls them back.

**Second example** (the route test fixture):

- Rule date Mon 7 Sep. Campaign FXC pays £10 a sub, rising to £15 from Thu 24 Sep.
- Week 2 was paid as commission: 3 days (base £190.50) and 18 subs logged (12 at £10, then 6 on Thursday at £15), so £210.00.
- FXC's statement first confirmed 16. The 2 cancelled come off Thursday at £15, so the commission is 12 × £10 + 4 × £15 = £180.00, below the base. The week should have paid £190.50, so **−£19.50** goes on week 3 (not −£30.00). The note reads "2 cancelled by FXC: paid for 18, confirmed 16".
- A corrected statement then confirmed 17. The commission is £195.00, which beats the base, so the same line is updated in place to **−£15.00**.
- Week 3, which is unpaid, was recalculated with its own 3 cancellations. It now shows commission 27 × £15 = £405.00 and "Correction for w/c 21 Sep −£15.00", for a total of £390.00.

**Third example: paid weeks keep what they were paid with** (`server/src/test/pay-rule-paid-weeks.test.ts`, FXC £10 a sub):

- Remy's week of 14 Sep was paid the base, £254.00, for 18 subs (£180.00 of commission). The office then raised Thursday from 4 to 14 subs. FXC confirms the 18: **no change** ("All 18 confirmed by FXC: no change."). Recalculating from today's gauges would have taken £26.00 off him.
- His week of 21 Sep was paid the commission, 30 × £10 = £300.00. A rate of £12 dated from that week is added later. FXC confirms 28: 28 × £10 = £280.00, so **−£20.00** ("Paid for 30, 2 cancelled by FXC, so −£20.00 on the pay for w/c 12 Oct."), not the −£24.00 a mix of the two rates gave.
- The day rate goes up to £70 after Rita's week of 14 Sep was paid the base at £63.50 (£254.00, 18 subs). FXC confirms 30: 30 × £10 = £300.00 beats the £254.00 she was paid, so **+£46.00**.
- Lee's week of 21 Sep was paid the commission: FXC 10 × £10 + FXB 12 × £20 = £340.00 (base £317.50). FXC confirms 5: £290.00, below the base, so −£22.50. FXB then confirms 6: £170.00, still the base, which the first correction already pays, so **no change**.

**Stored calculations.**

- Each run stores the calculation it was made with (`breakdown_json`, never returned by the API) and what it was calculated from (`inputs`: the subs per day and campaign at their rates, the confirmations and the deductions; a 1.2 plan week: the plan's figures, the sales and team sales it paid on). A paid week's breakdown shows exactly what was paid, and a statement corrects it from those inputs. A run stored before the inputs were kept (P1's first build) is corrected from its own per-campaign figures.
- A paid run made by the 1.2 code has no stored calculation. Its breakdown is the live calculation while that still equals the run's figures, else the run's own columns (base, commission, plan bonus, overrides, deductions, total). A statement for it starts from the run's days, sales and team sales with the person's plan.
- A paid week whose gauges were changed after payment says so: "The gauges for this week were changed after it was paid; the figures here are what it was paid with."
- The corrections made later are listed with it: "After this week was paid, BCN confirmed 13 of 14 subs." and the "Corrected after payment" note. A campaign that was awaited when the week was paid reads "not confirmed by BCN when paid".
- Unpaid runs are recalculated whenever their facts change: gauges, statements, rates, bonuses, adjustments or settings.

**Bonuses and adjustments** (`pay_adjustments`):

- Matt's bonus (kind `bonus`, more than £0) and manual lines (kind `manual`, plus or minus) go on an **unpaid** week, at most four weeks ahead, with a note the person sees. That week's run is recalculated straight away.
- Only bonuses and manual lines can be removed by hand. Statement corrections follow their statement, and disputes belong to P2.
- A week with no work whose only lines are corrections that would make it negative moves those corrections on to the person's **next open week**: the first later week with no run yet or a pending one. A paid, late or failed run never takes them, so a line can never land where nobody pays or takes it off (and it stays removable). A leaver's week is the exception: it is not moved.
- A manual line that would take a finished week below £0 is refused (400). A statement correction bigger than the week it lands on still can: that run shows the total below £0 and the sentence "Bo's corrections come to more than this week's pay, so the total is below £0 (−£36.50) and nothing can be paid for it as it is …", and **Mark paid** refuses it (409) until part of the correction is carried to a later week with **Add an adjustment**.

**Settings → Pay** (`updatePaySettings`):

- A new day rate recalculates every unpaid run from the rule date.
- A new rule date, which must be a Monday and not after this week, moves the weeks between the old and new date to the other rule and recalculates their unpaid runs.
- Paid runs never change.
- On upgrade from 1.2, the rule date is set to the Monday of the upgrade week, so earlier unpaid weeks keep the plan maths. Each campaign without a rate history gets its current rates as a starting row from its start date.

**Campaign rates:**

- A new rate, from **Add a rate**, from changing the rep commission in the Campaigns form, or from a client change Matt approved (P6), recalculates the unpaid weeks from its date in which that campaign was worked.
- A future rate takes over on its date: the 15-minute sweep (`rollForwardEventStatuses`) and the daily materialisation make it the campaign's own (so the revenue snapshot on that day's gauges uses it), and record it in the audit trail as an automatic step.
- The campaign's own figures follow the rate in effect today.

**The week so far** (`shared/src/logic/payForecast.ts`, rule branch):

- `baseLikely` = day rate × the likely days this week.
- `commissionSoFar` = the subs logged so far at their rates. `ratePerSub` = the average rate of the team's events still to come, else the week's own rate so far, else the person's trailing rate.
- `subsToBeatBase` = ⌈(base − commission so far) ÷ rate⌉.
- Likelihood: the chance of selling at least that many in the remaining event days at the person's own daily rate (Poisson): likely ≥ 60%, possible ≥ 25%, else a stretch.
- The stops figure uses the person's own stop-to-sub ratios.

**Elsewhere:**

- Payroll flags never warn "near the bonus" in a 1.3 week (there is none).
- The digest counts no plan bonus.
- Smoke checks every seeded run is `base` or `commission` with no overrides, and that Company → By campaign commission equals subs × rate.

**Demo data** (the seed):

- Every plan is £63.50 a day with no commission, bonus or override. The owner's plan is salaried.
- Rep rates: BCN £20 (it was £18 until a client change from a Thursday six weeks ago), CHN £18, VLT £35 and FCB £15 (£14 until an admin change 14 weeks ago). About 31% of weeks pay commission.
- Statements: CHN confirms two days after the week (before payday), with about 7% cancelled. BCN confirms nine days after (the week is already paid, so the correction lands a week later), with about 6% cancelled.
- Bonuses: £50 for each month's top seller over three months, and £25 for each team's top seller last week.
- The result is 674 runs (502 base, 172 commission), none negative.

## User guide

**Everyone on weekly pay: Finance → My pay.**

- **Commission weeks** shows how many of the last 12 weeks the commission beat the base, and what those weeks paid ("4 of 12", "£1,228 · beat the base").
- **This week so far** shows the likely pay and a bar of commission so far against the base for the days you are likely to work, with a line such as "9 more subs and commission beats your £381.00 base — about 188 stops (likely)".
- **How this week is worked out** opens the week's breakdown as it stands.
- **Payslips** lists every week. The **Paid as** column shows Base or Commission with its amount. Under the gross it shows "incl. £25.00 bonus", "incl. −£16.50 corrections" or "after £20.00 deductions". Sales show "2 cancelled" when a client cancelled subs.
- Select a week to see the full breakdown:
  - two tiles, **Base** (days × £63.50) and **Commission** (subs at the campaign rates). On a paid week the one paid is marked **Paid** and the other **Not paid**, with the badge **Paid the base** or **Paid the commission**;
  - on a week not paid yet (waiting for payday, or a transfer that failed) they read **Applies** and **Does not apply**, with the badge **Pays the base** or **Pays the commission**;
  - while the week is still going, the tiles read **Ahead** and **Behind**;
  - each campaign's subs × rate, with "18 logged, 2 cancelled by BCN" or "Not yet confirmed by BCN";
  - any bonus with its note, any correction from an earlier week, the total, and the reasons in plain sentences.
- A week a client corrected after it was paid shows **Corrected after payment** with the amount and the week it went on.

**Leaders: Finance → Team pay.** The same columns for the team, plus **Paid as commission**: how many of the team's runs the commission beat the base. A leader can open a team member's week and read the same breakdown.

**Administrators: Finance → Company.**

- **Runs to pay** has the same columns.
- Open a run to see the breakdown, where **Add a bonus** and **Add an adjustment** work on an unpaid week, and the bin removes a bonus or a manual line.
- **Bonuses and corrections** lists the last six weeks' bonuses, manual lines and statement corrections.
  - **Add a bonus**: choose the person and the week it is paid with (last week by default), the amount and what it is for. The person sees the note.
  - **Add an adjustment**: choose **Add money** or **Take money off**, and optionally the week it corrects.
  - A paid week cannot take a line; choose the next unpaid week.
  - A line on a past week the person did not work goes on their next unpaid week; the message after **Add adjustment** says which ("−£20.00 on w/c 5 Oct: no work in w/c 14 Sep, so it goes on the next unpaid week").
  - Taking off more than a finished week pays is refused; split it over two weeks.

**Administrators: Settings → Pay.**

- **Day rate (£)** and **The rule applies from** (a Monday), then **Save pay settings**. Unpaid weeks are recalculated and paid weeks never change.
- **Rate per sub, by campaign** lists each campaign's current rep rate and payout. Open one to see its history (who approved a client's change).
- **Add a rate** adds a new rate from a date. Sales on and after that day use it.

## Owner notes

- **Paid weeks never change.** A client's cancellation after payday takes the difference off the person's next unpaid week, as a line they can see with its reason. Because the base is a floor, a cancellation only costs as much as it changes the week: a week paid the base loses nothing.
- **Bonuses are by hand only**, as decided. Nothing is added automatically: not a sales bonus, and not a leader's override.
- The owner's own plan is treated as salaried (no day rate and no commission), so it gets no weekly pay from the rule date. Give a plan a day rate if someone on it should be paid weekly.
- **The rule date** is Monday of the week 1.3 is installed. If Matt wants earlier unpaid weeks paid by the new rule, he can move it back in Settings → Pay; only unpaid weeks move.
- **The demo rates are illustrative** (BCN £20, CHN £18, VLT £35, FCB £15 a sub to the rep). Set the real rates with **Add a rate** before the first 1.3 payday.
- **A dispute settlement is not netted against a later statement.** If P2's office settles "I made 18, not 16" with a dispute line and the client's statement later confirms the 18, the statement's correction is worked out without that line (a dispute may be about something else, such as a missed day). Check a statement's preview against open disputes for the same week.
- Statements for a 1.2 week paid by the 1.2 code start from the run's own sales; when gauges at several campaigns of that week were changed after payment, the split of those sales per campaign is approximate (the difference is put on the campaigns with the most sales).
- Applying a statement of 477 rows (every person, campaign and week of 8 weeks of the demo) takes about 100 ms, a dry run about 95 ms; applying it again changes nothing.
- For the lead and the other packages:
  - The dated-rate takeover runs inside `rollForwardEventStatuses` (P1's `db/maintenance.ts`), which the foundation's 15-minute sweep in `index.ts` already calls. The lead may prefer its own call in `index.ts`: `applyDatedRates(db)`.
  - P2: a run can now be refused by **Mark paid** because it is below £0 (409, before the invoice check). Agree how a self-billed invoice shows money owed, and have the bulk **Mark week paid** skip such runs and say so.
  - P2's disputes call `addPayAdjustment`: a dispute line that would take a finished week below £0 is refused with a 400 in the same words.
  - P2's payslip and invoice still show plan hints such as "N sales × £0.00", and the foundation's UserDetail plan card still shows "Commission per sale £0.00". Both should switch to the breakdown lines, for example `lines` from `GET /pay/breakdown`.
  - `attention.ts` wording still uses `plan.basePerDay`.
  - P2 must reissue an invoice when a run's total changes: a bonus, a statement or a rate.
  - P3 may set `statement_id` on the seeded `sale_confirmations`.
  - The seed's payroll uses its own random stream, so the hours of announcement `created_at` values moved.
