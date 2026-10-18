# Linear Hub — User guide

Step-by-step for everyone at Linear MCR, by role. Start with **Everyone**, then jump to your section. Buttons, tabs and fields are named exactly as they appear in the app, in **bold**.

- [What's new in 1.1](#whats-new-in-11) — the smart release
- [Everyone](#everyone) — signing in, what your role can do, your dashboard, the six gauges, logging a day, ratios and benchmarks, the Gauges page, pay and punctuality, the leaderboard, events, the team directory, settings
- [Leaders](#leaders) — scheduling events, logging for your team, the team view, announcements
- [Recruiters](#recruiters) — your dashboard, the pipeline, adding and moving candidates, interviews, hiring, your pay
- [Administrators](#administrators) — campaigns, people, gauges and events for anyone, payroll, expenses, company finance
- [If something goes wrong](#if-something-goes-wrong)

---

## What's new in 1.1

<!-- p9-week-in-review-digest writes the introduction here. -->

### Links that open the right screen

Some links now take you straight to the action, not just the page. A link to **Log gauges** for an event opens the
**Log gauges** window with that event already chosen (a leader's or administrator's link can also pick the person);
after it opens, the address goes back to plain **Gauges**, so pressing Back never opens the window again. An
administrator's link to **Runs to pay** opens **Finance → Company** and scrolls to the **Runs to pay** card.

### If a card hits a problem

If one card on a page fails to draw, only that card is replaced by **This card hit a problem** with a **Try again**
button; the rest of the page keeps working. The bell at the top works the same way: if it fails it turns into a
crossed-out bell, and tapping it tries again. If a whole page fails you see **This page hit a problem** instead — try
again, or open another page from the menu.

### Your pace and streaks (p2)

<!-- p2-personal-pace-streaks: filled from docs/smart/p2-personal-pace-streaks.md -->

### This week's pay estimate and payroll checks (p3)

<!-- p3-money-forecast-payroll-checks: filled from docs/smart/p3-money-forecast-payroll-checks.md -->

### Check in with… (leaders and the owner) (p4)

<!-- p4-leader-check-ins-coaching: filled from docs/smart/p4-leader-check-ins-coaching.md -->

### Needs attention (p5)

<!-- p5-needs-attention-feed: filled from docs/smart/p5-needs-attention-feed.md -->

### Event forecasts and who has not logged yet (p6)

<!-- p6-event-forecasts-roster: filled from docs/smart/p6-event-forecasts-roster.md -->

### If the signal drops (p7)

<!-- p7-signal-proof-logging: filled from docs/smart/p7-signal-proof-logging.md -->

### Recruitment deadlines (p8)

<!-- p8-recruitment-slas: filled from docs/smart/p8-recruitment-slas.md -->

### Your week in review (p9)

<!-- p9-week-in-review-digest: filled from docs/smart/p9-week-in-review-digest.md -->

### Backups and running in the background (administrators) (p10)

<!-- p10-backups-autostart: filled from docs/smart/p10-backups-autostart.md -->

---

## Everyone

### Signing in

1. Open Linear Hub at the address the office gave you. (Running it yourself: <http://localhost:5173> during `npm run dev`, or <http://localhost:4000> after `npm run build && npm start`.)
2. Enter your **Work email** and your **Employee ID** — format `LM-0000`, e.g. `LM-0042`; it is on your welcome email and your payslip. Capital letters do not matter.
3. Choose **Sign in**. You stay signed in on this device for up to fourteen days or until you sign out.

There is no password yet, so your employee ID is the second half of your credential — treat it like one. Linear Hub shows employee IDs only to administrators and to you: nobody else can read yours on the Team page, a payslip or your profile. After **eight failed attempts in fifteen minutes** the sign-in for that email is paused and the message says how many minutes to wait. If the office sets your status to **Left**, you are signed out on every device immediately.

On a demo database the sign-in page also shows **Try a demo account** — one button per role. The office switches this off on the live database, so if you do not see it, that is why.

**Signing out:** open your avatar at the top right and choose **Sign out**.
**Light or dark:** use the sun/moon toggle in the top bar, the **Light** / **Dark** / **Match system** entries in the same avatar menu, or **Settings → Appearance** (**Light**, **Dark**, **System**). The choice is remembered on this device.
**Finding a page:** the **Go to page…** box in the top bar (⌘K or Ctrl+K) lists every page your role can open. The sidebar groups them into **Workspace**, **Manage** and **Account**.

### What your role can see and do

| Role | You can see | You can change |
|---|---|---|
| **Representative** | Your own gauges and pay; your team's events, leaderboard and gauges summary; the directory; any event or colleague's profile read-only (other people's check-in times and notes are hidden) | Your own gauges, at your team's events |
| **Leader** | Everything company-wide — every team's events, the full leaderboard, any profile — plus your own team's check-in times and notes, your team's pay runs, and recruitment | Events for your team; gauges for your team's members at your team's events; candidates, interviews and stage changes; announcements |
| **Recruiter** | The whole recruitment pipeline, the directory, your own pay; events and the leaderboard read-only (no Gauges page) | Candidates, interviews, stage changes — hiring creates the rep's account |
| **Administrator** | Everything, including every employee ID | Everything — people, campaigns, events, any gauges, payroll payments, expenses, announcements |

A page your role cannot open shows "This area isn't available on your account" with a **Back to dashboard** link.

### Reading your dashboard

The dashboard greets you by name and shows your position, team and the dates in view. Change the period with **This week**, **This month** or **This quarter**. Reps, leaders and administrators also have **Log gauges** here.

| Tile or card | What it shows |
|---|---|
| **Sales** | Confirmed sales for the period. Underneath: **Ranked #N of M in your team** (reps — the same people as your leaderboard) or **company-wide** (leaders and administrators). |
| **Conversion** | sales ÷ stops, tinted against the benchmark. |
| **Stops** | With your presentations underneath. |
| **Earnings to date** | Gross pay for the period: the pay runs that start in it, plus a live estimate for any week that has no run yet. |
| **Next payday** | The date and amount of the earliest **unpaid** run. If its due date has passed the tile turns red and says **overdue**; when nothing is owed it shows this week's payday and the live estimate. |
| **Punctuality** | The share of your check-ins that were on time. Green from 90%, amber from 75%, red below. |
| **Your trend** / **Your funnel** | Sales and stops per day; your funnel against the law of averages with one to three coaching notes underneath. |
| Team card (named after your team) | Stops, sales, conversion and your team's top five. People without a team see **Top performers** across the company instead. |
| **Upcoming events** | The next five for your team (administrators: the whole company). |
| **Announcements** | The latest five, pinned first. Leaders and administrators see **New announcement** here. |

**The "vs" arrows.** Each change compares with the **same days of the previous period**, and the small label under the tile names them — on Thursday 15 October the week view says "vs 5 Oct – 8 Oct". This week (Monday to today) is compared with last week Monday to the same weekday; this month (1st to today) with the same days of last month; this quarter with the same stretch of the previous quarter. The leaderboard's movement arrows use the same comparison. An arrow is blank when there was nothing in the previous period.

Leaders and administrators also get a **Company** section — sales, revenue, active reps, payroll on time, open candidates, hires, the company trend and sales by campaign. For administrators it comes first and their own gauges follow under **Your activity**; for leaders it sits under their own numbers. Recruiters get a recruitment-first dashboard, described under [Recruiters](#recruiters).

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

A valid day might read `120 · 42 · 21 · 9 · 5 · 5`. A day reading `120 · 42 · 21 · 5 · 6 · 5` is rejected, because 6 taps cannot come from 5 closes.

### Logging gauges

Open the form with **Log gauges** on the Dashboard or the Gauges page, or open the event under **Events** and choose **Log gauges** there (**Update my gauges** if you have already logged that event).

1. **Event.** From the Dashboard or Gauges the list shows your team's events from the last three weeks up to today; cancelled events are not offered. From an event page the event is fixed. A future event cannot take gauges — the form says "This event is on … — gauges can be logged from that day." — and neither can a cancelled one.
2. **Rep.** Reps: this is you. Leaders choose a member of the event's team; administrators anyone.
3. **Date.** Fixed to the event's date and shown read-only: gauges are recorded against the day the event ran. If you already have an entry for that event the hint says so, and saving will update it.
4. **Gauges.** Use the six steppers (**Stops**, **To table**, **Presentations**, **Closes**, **Taps**, **Sales**) in order. A stage that breaks the funnel rule is highlighted and named in the warning; the **Live ratios vs law of averages** panel updates as you type. **What counts as what?** expands the definitions.
5. **Checked in at.** Tap **Now** when you arrive — this is what your punctuality is measured from; the hint shows the event's start time and the 5-minute grace. Add **Notes** if the day needs explaining.
6. **Save gauges** — or **Update gauges** when the form is editing an existing entry. You will see "Gauges logged" or "Gauges updated".

There is one entry per person, per event, per day. Saving again for the same event **updates** it rather than adding a second one, and the time you submitted is kept. To change a day later, open the event and choose **Edit** on your row in **Gauges by rep**; only leaders (own team) and administrators can **Delete** an entry.

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

- Ratio cells are tinted: **green** within 10% of the benchmark or above (for a 50% benchmark, 45% and up), **amber** 10–25% below, **red** more than 25% below. Colour is a hint — the number is always shown alongside.
- Look for the **lowest ratio relative to its benchmark**. That is the stage to coach or practise. The coaching notes under your funnel say it in a sentence: a low stop → table means the opening needs work; a low presentation → close means you are pitching well but not asking.
- With **fewer than 20 stops** in the period the ratios are too noisy to read much into. The notes say "Early days" until then.
- A stage nobody has reached yet (4 closes but no taps) is not graded — it is undefined, not poor.
- The volume target is **2 sales per worked day**. Ratios tell you *how well*; sales per day tells you *how much*.

### The Gauges page

Open **Gauges**. The tabs depend on your role: **My performance** (everyone), **Team** (leaders: your team; administrators: any team via the **Team** picker) and **Company** (administrators). The range picker offers **This week**, **Last week**, **This month**, **Last month**, **This quarter** and **Custom** (type a from and to date).

**My performance** shows six tiles — **Sales** (with per day), **Stops** (with days worked), **Presentations**, **Conversion**, **Stops per sale**, **Punctuality** — then **Funnel vs benchmarks** with coaching notes, your **Trend**, **By campaign** and **Recent entries**. The same panel appears on your profile under **Team**.

**Team** and **Company** show a summary table grouped **By person**, **By team**, **By campaign**, **By day** or **By week**, with the six gauges, sales per day and every ratio tinted against the benchmarks. By day and By week add a **Trend** chart. Clicking a person opens their profile. The **Rep-days** column counts distinct person × day pairs, so for a campaign or a week it is "days of work", not calendar days.

### Checking your pay

Open **Finance**. Everyone lands on **My pay**:

- Four tiles: **Earned · last 12 weeks**, **Commission**, **Paid on time** (share of your paid runs that landed by the due date) and **Next payday**.
- **Earnings** — gross pay per week, split into **Base**, **Commission**, **Bonus** and **Overrides** (only the components you actually earn are plotted).
- **Payslips** — one row per pay week: **Week**, **Days**, **Sales**, **Commission**, **Gross**, **Due**, **Status**. Click a row for the payslip (**Payslip · PAY-2026W41-LM-0010** and so on): **Base pay** (days × your daily rate), **Commission** (sales × your rate), **Bonus** (paid when the week's sales reach your plan's threshold), **Overrides** (leaders: team sales × the override), **Deductions**, **Gross pay**; your **Pay plan** alongside; and **The week's gauges** that fed into it.

**Pay weeks run Monday to Sunday** and are **due on the Friday after the week ends** — a week ending Sunday 18 October is due Friday 23 October. When a week closes, its runs appear by themselves on the Monday as **Pending**.

**Status** badges: **Pending** (not yet paid), **Paid** (on or before the due date), **Paid late**, **Failed** (the transfer bounced; the office will pay it again). A pending run past its due date also carries a red **Overdue** badge, and the **Next payday** tile on your dashboard turns red and keeps pointing at it until it is paid — money owed never drops off.

Leaders have a **Team pay** tab and administrators a **Company** tab; see their sections.

### Punctuality

Your check-in time at each event is compared with the event's start time. Checking in up to **5 minutes** after the start still counts as on time. Your punctuality rate is the share of recorded check-ins that were on time; days with no check-in recorded do not count either way, so record it. Other people's check-in times are visible only to administrators and to their own team's leader; everyone else sees **—** in the **Check-in** column.

### The leaderboard

Open **Leaderboard**. Choose the period (**This week**, **This month**, **This quarter**) and the metric (**Sales** or **Conversion**). Leaders, recruiters and administrators can pick a **Team**; reps always see their own team, shown as a badge. Everyone who logged sales in the period is ranked — ties share a rank — with the top three on a podium and the full table beneath: **#**, **Rep**, **Team**, **Sales**, **Stops**, **Conv.**, **Days**, **Move**.

When you are ranked, the header says **You're #N of M this week** (month, quarter). For a rep, M is the number of people in your team; for leaders and administrators it is the whole company — the same number your dashboard's Sales tile quotes. The **Move** column compares your rank with the same days of the previous period: an arrow up or down with the number of places, a dash for no change, **New** when you were not ranked last time.

### Events

Open **Events**. The default range is **Upcoming** — a week back to three weeks ahead; the other presets are **This week**, **Last week**, **This month**, **Last month** and **Custom**. Filter by **Team** (reps always see their own team), **Campaign** and **Status** (**Scheduled**, **Live**, **Completed**, **Cancelled**).

Days are listed with **today first** (highlighted), then the days to come, then last week's completed days under an **Earlier** divider, newest first — so nobody scrolls past history to find today. Lists with more than 60 events show two weeks of days and a **Show N more days** button. Each row shows the event, campaign code, venue, times, team, type, sales against target, how many reps have logged, and the status. Statuses follow the clock: today's events turn **Live** at their start time and past events become **Completed**, checked every fifteen minutes.

Open an event for the day's totals, the **Event funnel** against the benchmarks, the notes, and **Gauges by rep** — each person's six gauges, conversion and check-in punctuality.

### The team directory

Open **Team**. Team chips at the top (member count and leader) filter by team; the search box **Search name, email or ID…** also finds employee IDs for administrators. Filter by **Team**, **Position** and **Status** (**Active**, **On leave**, **Left**, **Everyone**) and switch between **Card view** and **Table view**. Open a person for their contact details, pay plan name, and their full performance panel for any range (default **This month**). Employee IDs appear on your own card and, for administrators, on everyone's.

### Settings

**Settings** shows your profile as the office holds it (**Employee ID**, **Email**, **Phone**, **Position**, **Role**, **Team**, **Pay plan**, **Start date**, **City** — ask an administrator to change anything), **Appearance** and **About this app** (version and when the sample data was seeded).

---

## Leaders

Everything above applies to you too. In addition:

### Scheduling an event

1. Open **Events** and choose **New event**.
2. Fill in **Event name** (what the team will recognise, e.g. "Trafford Centre weekend"), **Campaign** (active campaigns only), **Team** (locked to yours — "Leaders schedule events for their own team."), **Venue**, **City**, **Type** (Private site, Event, B2B, Residential or Retail), **Date**, **Start** and **End** (24-hour; the end must be after the start), **Sales target** and **Notes** (parking, dress code, who to ask for).
3. **Create event.** It appears on every team member's dashboard and in Events.

The status is set for you: **Completed** for a past date, **Live** for today once the start time has passed, otherwise **Scheduled**. To change anything later, open the event and choose **Edit** — the same form plus a **Status** field (set it to **Cancelled** rather than deleting) — then **Save changes**. Only administrators can **Delete** an event.

### Logging for team members

Choose **Log gauges** (Dashboard, Gauges or the event page), pick the event, then pick the **Rep** from your team. The form is the same as a rep's, with the same funnel, event-date and today-or-earlier rules. You can only log at **your own team's events**: an attempt elsewhere is refused. On the event page every row of **Gauges by rep** has **Edit** (opens **Update gauges**) and **Delete** (asks "Delete this gauge entry?").

### The team view

- **Dashboard** — your team's card with its top five, and the **Company** section under your own numbers.
- **Gauges → Team** — your team only, grouped **By person** (compare ratios side by side), **By campaign**, **By day** or **By week**.
- **Team** — open any member for their full performance; for your own team you also see their check-in times and notes on each entry.
- **Leaderboard** and **Events** — the whole company, with a **Team** picker.
- **Finance → Team pay** — your team's runs for **This week**, **Last week**, **Last 4 weeks**, **Last 12 weeks**, **This month** or a custom range, with **Team payroll**, **Commission**, **Awaiting payment** and **People paid** on top. Click a run for its payslip. Marking runs paid is an administrator's job.
- **Recruitment** — full access: add candidates, schedule interviews and move stages, as described under [Recruiters](#recruiters).

### Announcements

On the Dashboard choose **New announcement**, add a **Title** and the **Message**, switch on **Pinned** if it should stay at the top, and **Post announcement**. Everyone sees it on their dashboard, pinned ones first.

---

## Recruiters

### Your dashboard

Your dashboard leads with **Recruitment**: **Open candidates** (with how many are at interview or observation), **Interviews this week**, **Overdue actions**, **Hires** for the chosen period and **Avg time to hire**; then **Upcoming interviews** (the next two weeks), **Overdue follow-ups** and **Weekly activity** for the last twelve weeks. Below that: **Top performers** across the company, **Upcoming events** and **Announcements**. You do not log gauges, so the Gauges page is not on your menu; Events, Leaderboard and Team are read-only.

### The pipeline

Candidates move through six stages in order, and can leave at any point:

**Applied → Phone screen → Interview → Observation day → Offer → Hired**

**Rejected** and **Withdrawn** are the two other end states. Hired, Rejected and Withdrawn are final; everything else is the **open pipeline**.

Open **Recruitment**. The range picker (**Last 4 weeks**, **Last 12 weeks**, **This quarter**, **This month**, **Last month**, **Custom**) drives the summary: **Applied**, **In interview**, **Hired** (with the share of applicants hired), **Avg time to hire**, **Overdue actions**, plus **Weekly activity** and **Conversion by source**. Below, filter candidates with **Search name or email…**, **Source** and **Owner**, and switch between **Board view** — the open pipeline by stage, with the **Hired** column showing hires made in the range — and **List view**, where **Include closed** also shows rejected, withdrawn and hired candidates.

### Adding a candidate

1. Choose **Add candidate**. New candidates start at Applied.
2. **First name**, **Last name** and **Email** are required. Add **Phone** and **City**.
3. Choose the **Position applied for** (Trainee or Field Representative — nobody is hired straight into a leadership or office role), the **Source** (Indeed, LinkedIn, Referral, Website, Walk-in, Agency, University or Other) and, for a referral, **Referred by**.
4. Set the **Owner** — "who follows up"; it defaults to you — and any **Notes**.
5. **Add candidate.** The candidate's page opens.

### The candidate page

- **Pipeline** — a stepper showing the stage and since when.
- **Profile** — email, phone, city, **Source**, **Rating** (click the stars, 1–5), **Owner**, **Position**, and after hiring **Hired as → View profile**.
- **Notes & next action** — **Notes**, **Next action**, **Due** and **Owner**; **Save**. Always set a next action and its date: when it passes, the candidate is flagged **Overdue** on the board, in the list and on your dashboard, so nothing goes quiet.
- **Interviews** and **Timeline** — every stage change, newest first, with who made it and the note.

### Moving candidates

Use the **Move to…** dropdown — in the header of the candidate page, or on a card on the board — and pick the new stage. Moving to Hired or Rejected asks you to confirm and lets you add a **Note** (what was decided and why). Hired, Rejected and Withdrawn are final: once there, the dropdown becomes a badge.

### Interviews

Choose **Schedule interview** (or **Schedule** in the Interviews card): the **Type** (Phone screen, First interview, Observation day or Final interview — suggested from the stage), the **Date and time**, the **Interviewer** (leaders, recruiters or the office) and **Notes**, then **Schedule**. Afterwards set the outcome with the dropdown on the interview: **Pending**, **Passed**, **Failed** or **No show**.

### Hiring

Move the candidate to **Hired**. The **Hire …?** dialog asks for the **Team** (it defaults to the owner's team) and the **Position** (Trainee or Field Representative, from the application), with an optional **Note**; **Confirm hire**. Linear Hub creates the employee record straight away: role Representative, the team and position you chose, the standard pay plan for that position, start date today, a work email in the `first.last@linear-mcr.co.uk` pattern and the next free employee ID. You will see "Rep account created · Field Representative · Deansgate" or similar, and the candidate's profile gains **Hired as → View profile**. An administrator reads the new employee ID off the profile and gives it to the new starter so they can sign in on day one.

### Your pay

**Finance → My pay** works for you as for everyone. Recruiters are on the **Office recruiter plan**: a daily rate Monday to Friday, no sales commission, and a **bonus in any week with two or more hires**. On your payslips the **Sales** column counts the **hires you closed** that week — candidates you own who were moved to Hired.

---

## Administrators

You can do everything above for anyone, plus:

### Campaigns

Open **Campaigns** (tabs **Active**, **Inactive**, **All**). Choose **New campaign**: **Name**, **Code** (2–6 letters or digits, e.g. `BCN`), **Sector** (Charity, Energy, Telecoms, Broadband, Other), **Type** (Fundraising, B2C, B2B), **Client payout per sale (£)**, **Rep commission per sale (£)** (cannot exceed the payout; a pay plan may override it), **Start date**, **Colour** for charts and chips, **Description**, and the **Active** switch; then **Create campaign**. Use the pencil on a card to edit and **Save changes**. Switch **Active** off to pause a campaign — its history is kept and it is no longer offered when scheduling an event.

### People

On **Team**, choose **Add member**: **First name**, **Last name**, **Work email**, **Employee ID** (format `LM-0000`; used with the email to sign in), **Role** (Administrator, Leader, Recruiter or Representative), **Position** (Trainee, Field Representative, Team Leader, Crew Leader, Assistant Owner, Owner or Recruiter), **Team**, **Pay plan**, **Start date**, **Status** (Active, On leave, Left), **Phone**, **City** and **Avatar colour**; then **Add member**. To change anything, open the person and choose **Edit profile**, then **Save changes**.

When someone leaves, set their **Status** to **Left**: they are signed out everywhere at that moment and can no longer sign in; their gauges, pay runs and history stay so the numbers still add up. You cannot set your own status to Left. Only administrators see other people's employee IDs — on the Team page, profiles and payslips — and the Team search finds people by ID for administrators only.

### Gauges and events for anyone

You can **Log gauges** at any team's event for any active member of that team (and for yourself), **Edit** or **Delete** any entry, and **Edit** or **Delete** any event. Deleting an event removes its gauge entries for everyone — set its **Status** to **Cancelled** instead unless it was created in error.

### Payroll

1. Open **Finance → Company**. The range (**Last 4 weeks**, **Last 12 weeks**, **This quarter**, **This month**, **Last month** or **Custom**) is snapped to whole Monday–Sunday pay weeks, so revenue, payroll and expenses always cover the same days.
2. **Runs to pay** lists every **Pending** and **Failed** run across the company, newest week first (grouped by week in collapsible sections when there are more than twenty). Click a run to check its payslip against the pay plan.
3. Once the money has gone, choose **Mark paid**. The run is recorded as paid **today** and becomes **Paid** if today is on or before the due date, otherwise **Paid late**; you will see "Marked paid" or "Marked paid (late)". A run that is already paid cannot be paid twice. When the list is empty it says "Everyone is paid up".

Make this a Friday routine: pay weeks close on Sunday, their pending runs appear on Monday, and they are due the following Friday. A **Failed** run (a transfer that bounced) stays in Runs to pay until you mark it paid again.

### Expenses

Further down **Finance → Company**, choose **Add expense**: **Date**, **Amount (£)**, **Category** (Venue fees, Travel, Office, Software, Recruitment, Marketing or Other), optionally the **Campaign** it belongs to, and a **Description**; then **Add expense**. The bin icon deletes an expense entered in error (you are asked to confirm). The table shows 25 at a time with a **Show N more** button.

### Company finance

The top of **Finance → Company** shows, for the chosen range:

- Tiles: **Revenue** (sales × campaign payout), **Payroll**, **Expenses**, **Profit** and **Sales**. The week in progress has no runs yet, so its payroll is a live estimate and the tiles say "incl. this week's estimate".
- **Weekly money flow** — revenue against payroll and expenses per pay week.
- **Payroll punctuality** — paid on time, paid late, pending and failed, the **On-time rate** and the average days late.
- **By campaign** — sales, revenue, the commission reps actually earned on that campaign and the margin.

### Announcements

As a leader does: **New announcement** on the Dashboard, with the **Pinned** switch to keep it at the top for everyone.

### Resetting the sample data

From the repository root, `npm run seed` rebuilds the database with the deterministic 26-week sample data, anchored to today. Do not run it against a live company database — and on a live database set `LM_DEMO_ACCOUNTS=0` so the sign-in page offers no demo accounts.

---

## If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| "We couldn’t match that email and employee ID." | One of them is wrong, or your status is Left. | Check both against your payslip, then ask the office. |
| "Too many attempts, try again in N minutes" | Eight failed sign-ins for this email in fifteen minutes. | Wait the stated minutes; a successful sign-in resets the count. |
| "Your session has ended" | Your sign-in expired or was revoked. | Sign in again; you return to where you were. |
| "This area isn't available on your account" | Your role cannot open that page (recruiters and the Gauges page, for example). | Use **Back to dashboard**; speak to your crew leader or the office if you think you should have access. |
| **Not saved.** "Invalid funnel" | One stage is larger than the one before it. | Fix the stage named in the message. |
| **Not saved.** "Gauges are recorded against the event's date" or "Gauges cannot be recorded before the event takes place" | The entry was for a date other than the event's, or the event is in the future. | Pick the right event; log it on or after the day it runs. |
| **Not saved.** "Reps can only record their own gauges" (or a similar refusal) | Your role does not allow that write — a rep logging for someone else, a leader at another team's event. | Ask your leader or the office. |
| "This event was cancelled, so gauges cannot be logged for it." | The event's status is Cancelled. | Ask a leader or administrator to reinstate it if it did run. |
| A pay run shows **Overdue** | It is pending and its Friday due date has passed. | Nothing for you to do; the office sees the same badge in Runs to pay. |
| A pay run shows **Paid late** | It was marked paid after the due date. | Nothing for you to do; the office tracks the on-time rate. |
| Your punctuality shows **—** | No check-ins have been recorded yet. | Tap **Now** in **Checked in at** when you arrive at each event. |
| **Check-in** shows **—** for other people | Their check-in times are only shown to administrators and their own team's leader. | Expected. |
| "Demo accounts aren’t available right now" | The database has real users, or demo accounts are switched off. | Sign in with your own details. |

*Linear Hub v1.0.0 — © Linear MCR Limited, internal use.*
