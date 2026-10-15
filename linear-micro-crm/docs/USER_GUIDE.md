# Linear Hub — User guide

Step-by-step for everyone at Linear MCR, by role. Start with **Everyone**, then jump to your section.

Screens are described by what they do; the exact wording of a button may differ slightly from this guide.

- [Everyone](#everyone) — signing in, your dashboard, the six gauges, logging a day, ratios and benchmarks, pay and punctuality, the leaderboard
- [Leaders](#leaders) — creating events, logging for your team, the team view, announcements
- [Recruiters](#recruiters) — the pipeline, adding and moving candidates, interviews, hiring
- [Administrators](#administrators) — campaigns, people, payroll, expenses, company finance
- [If something goes wrong](#if-something-goes-wrong)

---

## Everyone

### Signing in

1. Open Linear Hub at the address the office gave you. (When running it yourself: <http://localhost:5173> in development, or <http://localhost:4000> after `npm run build && npm start`.)
2. Enter your **work email** and your **employee ID** (the code on your payslip, e.g. `LM-0042`). Capital letters do not matter.
3. Choose **Sign in**. You stay signed in on this device until you sign out.

The sign-in page also offers one-click **demo accounts** — one per role — for trying the product with sample data.

Cannot sign in? Check the employee ID against your payslip, then ask the office. If your status has been set to *left*, sign-in is switched off.

**Signing out:** open your name in the top bar and choose **Sign out**.
**Light or dark:** use the theme toggle in the top bar. Your choice is remembered on this device.

### Reading your dashboard

The dashboard is the first thing you see. Change the period at the top: **This week**, **This month** or **This quarter**.

| Panel | What it shows |
|---|---|
| **Your numbers** | Your six gauge totals for the period, your stage-to-stage ratios, days worked and sales per day. Arrows show the change against the previous period of the same length. |
| **Rank** | Where you sit among the people ranked this period, and out of how many. |
| **Earnings to date** | Gross pay for the period so far, your **next payday** and the amount due. |
| **Punctuality** | The share of your event check-ins that were on time. |
| **Trend** | Stops, presentations and sales day by day. |
| **Upcoming events** | The next five events for your team. |
| **Announcements** | The latest five from leaders and the office, pinned ones first. |

Leaders also see a **Team** panel (team totals, ratios, trend and mini-leaderboard). Leaders and administrators also see a **Company** panel (company totals, active reps, revenue, payroll on-time rate, open candidates, hires and sales by campaign).

### The six gauges

Every rep records the same six numbers for every event day. They are a funnel: each stage is a subset of the one before, so **no stage can be larger than the previous one**. All six are whole numbers, zero or more.

| # | Gauge | What counts | Rule |
|---|---|---|---|
| 1 | **Stops** | Every person you stopped and spoke to. | — |
| 2 | **To table** | Stops who came over to the table or stand to hear more. | ≤ Stops |
| 3 | **Presentations** | Full pitches delivered, start to finish. | ≤ To table |
| 4 | **Closes** | Presentations where you asked for the sale. | ≤ Presentations |
| 5 | **Taps** | Closes where the customer tapped, signed or confirmed their details. | ≤ Closes |
| 6 | **Sales** | Confirmed sales that count towards your commission and the campaign. | ≤ Taps |

A valid day might read `120 · 42 · 21 · 9 · 5 · 5`. A day reading `120 · 42 · 21 · 5 · 6 · 5` will be rejected, because 6 taps cannot come from 5 closes.

### Logging gauges at an event

1. Open **Gauges** and choose **Log gauges** (or open the event under **Events** and log from there).
2. Pick the **event**. You will see your own team's events for today and the last few days.
3. Enter the six numbers **in order**, stops first. The form checks the funnel rule as you type and names the stage that is wrong.
4. If you have not already checked in, record your **check-in time** (one tap when you arrive is best — it is what your punctuality is measured from). Add **notes** if something about the day needs explaining.
5. **Save.**

There is one entry per person, per event, per day. Saving again for the same event and day **updates** your entry rather than adding a second one. The time you submitted is kept with the entry.

### Your ratios against the benchmarks

Linear Hub turns your gauges into five stage-to-stage ratios and compares each with the company's **law of averages** benchmarks:

| Ratio | Benchmark | Meaning |
|---|---|---|
| Stop → table | **35%** | 35 of every 100 people you stop come to the table |
| Table → presentation | **50%** | half of those hear the full pitch |
| Presentation → close | **40%** | you ask for the sale in 4 of every 10 pitches |
| Close → tap | **60%** | 6 of every 10 asks get a tap |
| Tap → sale | **90%** | 9 of every 10 taps become confirmed sales |

Hit every benchmark and about **3.8% of stops become sales — roughly 1 sale for every 26 stops**.

**How to read your ratios**

- A ratio within **±10%** of its benchmark counts as **on track** (for a 50% benchmark, anything from 45% to 55%). Above is better; below is the stage to work on. Colour is a hint — the number is always shown alongside.
- Look for the **lowest ratio relative to its benchmark**. That is the stage to coach or practise. A low stop → table means the opening needs work; a low presentation → close means you are pitching well but not asking.
- With **fewer than 20 stops** in the period the ratios are too noisy to read much into. Give it a few more days.
- The volume target is **2 sales per worked day**. Ratios tell you *how well*; sales per day tells you *how much*.

### Checking your pay and punctuality

Open **Finance**. You will see your pay runs for the last twelve weeks, newest first.

- **Pay weeks run Monday to Sunday** and are paid on the **Friday after the week ends**. That Friday is the **due date**.
- Each run shows **days worked**, **sales**, **base pay** (your plan's daily rate × days), **commission** (per sale), **bonus** (paid when your weekly sales reach your plan's threshold), **overrides** (leaders only: a small amount per sale made by their team), **deductions**, and the **gross** total.
- The **status** is *pending* until the office marks it paid, then *paid* (on or before the due date) or *late* (after it). *Failed* means the payment bounced and the office is on it.
- Open a run to see the **payslip**: your pay plan and every gauge entry that fed into it.
- At the top: total gross and commission for the period, your **on-time rate** (how often you were paid by the due date), and your **next payday** with the amount expected.

**Punctuality.** Your check-in time at each event is compared with the event's start time. Checking in up to **5 minutes** after the start still counts as on time. Your punctuality rate is the share of recorded check-ins that were on time; days with no check-in recorded do not count either way, so record it.

### The leaderboard

Open **Leaderboard**. Choose the period (**week**, **month**, **quarter**), the metric (**sales** or **conversion**) and optionally a team. It shows the top 25. The **movement** arrow compares your rank with the previous period; **new** means you were not ranked last time.

### Events and the team directory

**Events** lists what is scheduled from a week ago to three weeks ahead; filter by team, campaign or status, and open any event to see the day's entries and ratios. **Team** is the company directory — search by name, email or employee ID; open a person to see their position on the ladder and, if your role allows, their performance.

---

## Leaders

Everything above applies to you too. In addition:

### Creating an event

1. Open **Events** and choose **New event**.
2. Choose the **campaign** and confirm the **team** (your own).
3. Give it a **name** (what the team will recognise, e.g. "Trafford Centre — Saturday"), the **venue** and **city**, the **type** (Private site, Event, B2B, Residential or Retail), the **date**, **start** and **end** times (24-hour), and a **target** number of sales. Add **notes** for travel or set-up.
4. **Save.** It appears on every team member's upcoming events.

Events move through **scheduled → live → completed**, or **cancelled**. Open the event to edit it or change its status. Only administrators can delete an event.

### Logging for team members

Open **Gauges**, choose **Log gauges**, and pick the **team member** before the event. The form is the same, with the same funnel checks. You can also **correct** an entry (saving again for the same person, event and day updates it) or **delete** one that should not exist.

### The team view

- **Dashboard → Team panel**: the team funnel and ratios, the trend, and a mini-leaderboard of your team.
- **Gauges → Summary**: totals and ratios grouped by **person**, **campaign**, **day** or **week**. Use *by person* to compare ratios side by side and find the stage each person should work on.
- **Team**: open any team member for their full performance — totals, ratios, trend, by campaign, recent entries and punctuality rate.
- **Finance**: your team's pay runs and whether they went out on time.
- **Recruitment**: you can see the pipeline and move candidates between stages.

### Announcements

From the dashboard, choose **New announcement**, add a title and the message, and post. Everyone sees it on their dashboard. Tick **Pinned** to keep it at the top.

---

## Recruiters

### The pipeline

Candidates move through six stages in order, and can leave at any point:

**Applied → Phone screen → Interview → Observation day → Offer → Hired**

**Rejected** and **Withdrawn** are the two other end states. *Hired*, *Rejected* and *Withdrawn* are terminal; everything else is the **open pipeline**.

### Adding a candidate

1. Open **Recruitment** and choose **Add candidate**.
2. **First name**, **last name** and **email** are required. Add **phone** and **city**.
3. Choose the **source** (Indeed, LinkedIn, Referral, Website, Walk-in, Agency, University or Other) and, for referrals, **who referred them**.
4. Set the **position applied** (usually Trainee) and the **owner** (you, unless someone else is running this candidate).
5. **Save.** The candidate starts at *Applied* with today's date.

After the phone screen, add a **rating** (1–5) and **notes**. Always set the **next action** and its **date** — overdue actions are counted and flagged on the summary so nothing goes quiet.

### Moving candidates

Open the candidate and choose **Move to stage**. Pick the new stage and add a short **note** (what was decided and why). Every move is recorded with who made it and when, so the history is always available on the candidate's page.

### Interviews

From the candidate's page choose **Schedule interview**: the **type** (phone, first, observation or final), the **date and time**, and the **interviewer**. Afterwards record the **outcome** — passed, failed or no-show — and notes.

### Hiring

Move the candidate to **Hired**. Linear Hub creates their **employee record** straight away: role *Representative*, position as applied, and the owner's team (or no team if the owner has none). The office then checks their pay plan, team and start date on the **Team** page and gives them their employee ID so they can sign in on day one.

### The recruitment summary

The summary at the top of **Recruitment** shows, for the last twelve weeks by default: open candidates by stage; the funnel for people who applied in the period (how many reached each stage); applications, hires and conversion **by source**; a weekly view of applications, interviews and hires; the average **time to hire** in days; and the number of **overdue actions**.

---

## Administrators

You can do everything above for anyone, plus:

### Campaigns

Open **Campaigns**. For each client campaign record the **name**, a short **code** (e.g. `BCN`), **sector** and **type** (fundraising, B2C or B2B), the **payout per sale** the client pays Linear, the **default rep commission per sale** (a pay plan may override it), a **colour** for charts, the **start date** and a **description**. Untick **Active** to pause a campaign — its history is kept and it disappears from new-event choices.

### People

On **Team**, choose **Add person**: **employee ID**, **work email**, **name**, **role** (Administrator, Leader, Recruiter or Representative), **position** on the ladder, **team**, **pay plan**, **start date**, **status**, **phone** and **city**. Edit anyone at any time. When someone leaves, set their status to **Left** — they can no longer sign in and their history stays intact.

### Payroll

1. Open **Finance → Payroll**. Filter by team, status or date range (last twelve weeks by default).
2. Open a run to check the **payslip** against the pay plan.
3. Once the money has gone, choose **Mark paid**. Enter the **paid date** if it was not today. The run becomes **paid** if that date is on or before the due date, otherwise **late**.

Make this a Friday routine: pay weeks close on Sunday and are due the following Friday.

### Expenses

Open **Finance → Expenses** and choose **Add expense**: **date**, **category** (Venue fees, Travel, Office, Software, Recruitment, Marketing or Other), **amount**, **description**, and optionally the **campaign** and **event** it belongs to. Delete an expense if it was entered in error.

### Company finance

**Finance → Summary** shows, for the chosen range (last twelve weeks by default):

- **Totals**: revenue (sales × campaign payout), payroll, expenses, profit and sales.
- **By week**: the same, week by week.
- **By campaign**: sales, revenue, rep commission and margin.
- **Payroll health**: runs, paid, pending, late, the **on-time rate**, and the average days late.
- **Expenses by category.**

### Announcements

As a leader does, plus you can **pin** anything so it stays at the top for everyone.

### Resetting the sample data

From the repository root, `npm run seed` rebuilds the database with the same deterministic 26-week sample data. Do not run it against a live company database.

---

## If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| **"Invalid funnel"** when saving gauges | One stage is larger than the one before it. | Fix the stage named in the message. |
| **"Forbidden"** | Your role does not allow that action (for example, a rep editing someone else's gauges). | Ask your leader or the office. |
| You are asked to sign in again | Your session has ended. | Sign in with your email and employee ID. |
| A pay run shows **late** | It was marked paid after the due date. | Nothing for you to do; the office tracks the on-time rate. |
| Your punctuality shows **—** | No check-ins have been recorded yet. | Record your check-in time when you arrive at each event. |

*Linear Hub v1.0.0 — © Linear MCR Limited, internal use.*
