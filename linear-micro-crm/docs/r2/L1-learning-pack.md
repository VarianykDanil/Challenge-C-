# L1 learning-pack: the COD pack as lessons, the Learn / Teach checklist and the progression tracker

The company's training pack (the "No. 1 Org COD pack", 20 pages) rebuilt as 21 lessons in Linear Hub, in the order of
the pack's leadership checklist: real HTML (headings, lists, tables), the pack's own illustrations cropped from it, a
three-question self-check per lesson, a written "teach it back" that the team leader signs off, the checklist with
Learn / Teach ticks per person, and a progression tracker that reads the person's real gauges.

Files: `shared/src/types/learning.ts` (contracts, additive), `shared/src/logic/learning.ts` (+ `learning.test.ts`),
`server/src/db/extensions/learning.ts`, `server/src/routes/learning.ts` (+ `server/src/test/learning.test.ts`),
`client/src/content/learning/*` (the lessons as typed data), `client/public/cod-pack/*.webp` (14 illustrations),
`client/src/features/learning/pack/*`, `client/src/features/learning/ProgressCard.tsx`, `client/src/api/learning.ts`,
`client/src/pages/Learning.tsx`, `LearningLesson.tsx`, `LearningProgress.tsx`.

## API

All under `/api/learning`, mounted with `requireAuth` (anonymous → 401). The three GET prefixes are in `CACHED_PATHS`
(20 s per user and URL, cleared by any write). Lesson keys are the 21 `LESSON_KEYS`; an unknown key → 404 "Lesson not
found". Validation errors → 400 `{ error: 'Validation failed', details }`.

| Method and path | Who | Body → answer |
| --- | --- | --- |
| `GET /learning/progress[?userId=]` | everyone (own); `?userId`: a leader for their own team, an admin for anyone; others 403. Unknown person 404, bad id 400 | `LearningProgress`: one `LessonProgress` per lesson in checklist order, `learned`, `taught`, `total` (21) |
| `POST /learning/progress/:lessonKey/quiz` | everyone, for themselves | `{ score, total }` (whole numbers, 1 ≤ total ≤ 10, score ≤ total) → `LessonQuizResult { passed, progress }` |
| `POST /learning/progress/:lessonKey/teachback` | everyone, for themselves, once the self-check passed (else 409 "Pass the self-check first, then teach it back") | `{ text }` (trimmed, 20–4000 characters) → `LessonProgress` (state `teachback_sent`) |
| `POST /learning/progress/:userId/:lessonKey/signoff` | the leader of that person's team, or an admin; never your own (403 "Someone else signs off your own teach-back"); another team 403 | `{ signedOff?: boolean = true }` → `LessonProgress`. `false` withdraws the sign-off |
| `GET /learning/team` | leader (own team, active people) or admin (everyone active, recruiters included); rep / recruiter 403 | `TeamLearning { rows, total, pending }` — `pending` (new, optional): teach-backs waiting for a sign-off, never the viewer's own, newest first, with the text |
| `GET /learning/progression/:userId` | self; a leader for their own team; an admin for anyone | `Progression` (see Logic), plus the new optional `weeks`, `learned`, `taught`, `total`, `enabled` |
| `PUT /learning/milestones/:userId/:key` (new) | admin only | `{ value }` (whole number 0–99) → the person's updated `Progression`. Unknown key 404 |

Teach-back text only ever reaches the person, the leader of their team and admins: those are the only callers these
routes let read a person's progress or the team queue. Nothing here writes a gauge row or a payroll run (tested).

New shared types (additive): `LESSON_GROUPS`, `TeachbackAwaiting`, `TeamLearning.pending?`, `ProgressionMilestoneKey`,
`PROGRESSION_MILESTONE_KEYS`, `ProgressionMilestoneInput`, `ProgressionWeek`, `Progression.weeks? / learned? / taught? /
total? / enabled?`. Client hook added: `useSetMilestone()` in `client/src/api/learning.ts`.

Database (`extensions/learning.ts`, two new tables, so `upgrade` changes nothing):

- `learning_progress(user_id, lesson_key, learned_at, quiz_score, quiz_total, teachback_text, teachback_at,
  taught_signed_off_by, taught_signed_off_at, updated_at, PRIMARY KEY(user_id, lesson_key))`, with a partial index on
  teach-backs waiting for a sign-off.
- `learning_milestones(user_id, milestone_key, value, set_by, set_at, PRIMARY KEY(user_id, milestone_key))`: the
  criteria the office ticks by hand.
- Demo seed (fresh demo databases only, its own random stream, never a core table): every active person gets progress
  by position — leaders, crew leaders, assistant owners and owners have the whole pack learned and taught; field reps
  6–16 learned with some taught and up to two teach-backs waiting; trainees 2–6; recruiters 3. The demo rep Jordan
  Lee (LM-0010) has 9 learned, 4 taught and 2 teach-backs waiting for Amelia. Crew leaders have "Show consistency"
  ticked; about half the team leaders have one person confirmed as trained to leadership.

## Logic

`shared/src/logic/learning.ts` (pure, tested in `learning.test.ts`):

- **Lesson state** (`lessonStateOf`): signed off → `taught`; a written teach-back → `teachback_sent`; the self-check
  passed → `learned`; else `new`. A sign-off counts even with nothing written (the leader heard it at the whiteboard).
- **Self-check** (`quizPassed`): learned only when every answer is right (`score === total`, total ≥ 1). The first pass
  sets `learned_at`; a later retake records the new score but never takes "learned" away. The two practical tasks
  ("Run an impact", "Go on a roadtrip") have no questions: **I've done this** posts 1 of 1.
- **Groups** (`LESSON_GROUP_OF`, `LESSON_GROUPS`): the pack checklist's blocks — fundamentals (5 steps, working habits,
  law of averages, impulse factors), in the field (green light, gumball + ABC days, can / can't controls, buying signs,
  strategic pause, pre-emptive strike), attitude (bamboo, attitude regain + attitude muscle), objections (bullet
  theory, straight line theory), leadership (3 core principles, pre- and post-management criteria, direct vs indirect,
  assuming the role, theory of teachback) and tasks. Checklist rows that share a lesson: ABC days → gumball theory,
  attitude muscle → attitude regain, pre- / post-management criteria → progression structure.
- **Career level from position** (`careerLevelFor`): trainee and field rep → entry level; team leader → leadership;
  crew leader → campaign manager; assistant owner → assistant director; owner → senior director; recruiter → none (the
  office sits outside the field ladder). The ladder continues to promoting owner, regional and national consultant.
- **Progression** (`progressionFrom`, rules in `PROGRESSION_RULES`): the server gathers the person's own sales and their
  current team's sales per Mon–Sun week for the last **12 weeks** (this week so far last, rows dated up to today, one
  grouped query), their learned / taught counts and the office's ticks. A requirement is met when **any** of its
  options is; the next level needs **every** requirement.
  - Entry → leadership: **sales** — 14 sales in any one week of the window, **or** 12+ in two consecutive weeks;
    **learn the COD pack** — 21 of 21 learned; **teach it back** — 21 of 21 signed off.
  - Leadership → campaign manager: **3 people trained from entry level to leadership** — met by either the active
    people on their team (other than them) at Team Leader or above (an approximation: there is no promotion history),
    or the count the office confirms; **prove you can train different personalities** — office tick.
  - Campaign manager → assistant director: **"4 + 1 or 3 + 2"** — office tick; **team generates 100 sales two weeks
    in a row** — two consecutive weeks of 100+ sales logged by everyone on their current team (no team → not met, "No
    team yet"); **show consistency** — office tick.
  - Assistant director → senior director: team is profitable, you're ready (office ticks). Senior director → promoting
    owner: mentor someone to their own office. Then 4 first-generation offices and a £50,000 wire 4 weeks running; 7
    offices and £75,000 8 weeks running (office counts and ticks).
  - Details carry the numbers: "12 of 14 sales this week; best recent week 13", "Reached: 15 sales the week of 5 Oct",
    "Last week 8, this week 12 of 12 sales", "Reached: 12 then 13 sales (weeks of 5 Oct and 12 Oct)", "2 of 3
    confirmed by the office". Option progress (`current` / `target`): this week's sales; the run of qualifying weeks
    (0–2) ending this week, or last week while this week is still short.
  - **Headline** (the dashboard card): unmet data requirements first, then the office ones, at most two phrases:
    "Your next level: 12 of 14 sales this week; 9 of 21 lessons learned" (a leader looking at someone reads "Next
    level: …"). Everything met: "Every criterion for Leadership is met: time to talk about the step up." Top of the
    ladder: "You're at the top of the ladder: …". Recruiters: "Recruiters sit outside the field ladder; every lesson is
    still open to you." Deterministic; never NaN / undefined.
- **Kill switch**: the tracker is a smart builder. With `LM_SMART=0`, `GET /learning/progression` answers the level and
  next level with `requirements: []`, `weeks: []`, `headline: ''`, `enabled: false`; the dashboard card hides and the
  Progress page says the tracker is switched off. Lessons, self-checks, teach-backs and the checklist keep working.

Content (`client/src/content/learning/*.ts`): every lesson keeps the pack's wording; only obvious typos are fixed
(excitment, consolodation, uou / omn, sgns, postitve, garuntee, arrises, minimim, politcs, compeition, dependant, liason,
comission, and the consolidation step printed as "3."). Two short explanatory notes are marked as such in muted text:
"SW3 = N: some will, some won't, so what… next" and the law of averages line read across the six gauges. The pack
prints no overturn for **direct debit**; the lesson says so and asks for the campaign's own. The illustrations are
cropped from 220 dpi renders (white turned to transparency, framed panels kept opaque, 7–67 kB each, 360 kB in all)
into `client/public/cod-pack/` — not `public/learning/`, because a folder named like the `/learning` page makes the
production server redirect `/learning` to `/learning/` on a reload. Section anchors match `LESSON_ANCHORS`
(`/learning/pack/bullet-theory#no-time`), so L2's annotation chips and the field cards land on the right part.

## User guide

**Learning** (sidebar, everyone) opens the Learning page:

- **Your COD pack**: how many lessons you have learned and taught back, and a button to carry on (**Continue: …**, or
  **Teach back: …** once everything is learned).
- **Field cards**: **5 steps to a conversation** and **The six objections**, each one phone screen with the line to
  say, for a quick look between stops. Tap a line to open that part of the lesson.
- Campaign pitches (from the pitch studio) sit above the lessons.
- **The COD pack**: 21 lessons grouped like the pack's leadership checklist, each with its state (**Not started**,
  **Learned**, **Teach-back sent**, **Taught**). Search finds a lesson by any word in it ("GIFGUP", "no time", "pause").

A lesson shows a summary and the key points, the lesson itself with the pack's pictures, then:

1. **Self-check**: three questions. Get all three right (**Check my answers**) and the lesson is learned. Got one wrong?
   The explanation shows under each question; **Try again** as often as you like.
2. **Teach it back**: write the theory in your own words and **Send to my leader** (people without a team leader
   send it to the office). Only you, your team leader and the office can read it. You can **Rewrite it** later. If you
   teach it at the whiteboard instead, your leader can sign it off in person.
3. **Signed off**: your leader ticks it and the lesson shows **Taught**.

"Run an impact" and "Go on a roadtrip" are practical tasks: tap **I've done this**, then say how it went.

**Progress** (from the Learning page, **Checklist and progress**):

- **Reps and recruiters**: your leadership checklist (Learn and Teach ticks for every lesson) and the progression
  tracker: your level, the next one and each criterion with your real numbers (for example "12 of 14 sales this week",
  "9 of 21 lessons learned"), a chart of your sales per week for the last 12 weeks against the 14 and 12 lines, and
  the whole ladder from entry level to national consultant. Recruiters see the checklist only (they are outside the
  field ladder).
- **Leaders**: **Me** shows your own; **My team** shows the teach-backs **Waiting for your sign-off** (read them and
  tap **Sign off**), everyone's Learn / Taught counts, and on a tablet or computer the whole checklist grid. Open a
  person to tick their Teach column (**Sign off**; tap a green **Taught** to withdraw it) and see their progression.
- **Admins**: **Everyone** instead of My team, and on a person's progression the criteria the office confirms by hand
  (marked **Office**) have a switch or a count to set, e.g. **4 + 1 or 3 + 2** or people trained to leadership.

**Dashboard** (reps and leaders): a one-line card under the week's pay estimate, e.g. "Your next level: 12 of 14 sales
this week; 9 of 21 lessons learned". Tap it for the Progress page.
