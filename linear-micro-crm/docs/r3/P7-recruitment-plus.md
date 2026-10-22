# P7 recruitment-plus

Date of birth, who handled each stage, interviewer changes, the interview schedule, and the exact questions asked with the candidate's answers.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P7 recruitment-plus**.

## API

Every route is for the recruitment roles only (admin, leader, recruiter; reps 403, a client account 403
`clientPortalOnly`, anonymous 401). The question bank is the admin's and the recruiter's (leaders 403).

| Route | Body / query | Answer |
| --- | --- | --- |
| `GET /recruitment/schedule` | `from`, `to` (YYYY-MM-DD, Europe/London days; default today … today + 6; `from` alone is one day; at most 93 days), `interviewerId` (a person, or `none` for "no interviewer yet"), `type` (`phone` · `first` · `observation` · `final`) | `InterviewScheduleItem[]` by time: the interview, `candidateName`, `candidateStage`, `positionApplied`, `day` (its London date), `sheetQuestions` / `sheetAnswered` (the saved sheet's counts, else the bank's draft count for the type and position) |
| `GET /recruitment/candidates/:id/timeline` | — | `CandidateTimelineItem[]`, newest first (see Logic); 404 "Candidate not found" |
| `GET /recruitment/candidates/:id/sheets` | — | `CandidateSheet[]`: every interview of the candidate with a saved sheet — its type, time, interviewer, outcome, the answers as asked and `summary` |
| `GET /recruitment/questions` | `type` (optional) | `InterviewQuestion[]` in interview order (phone, first, observation, final), then the bank's order |
| `POST /recruitment/questions` | `InterviewQuestionInput { interviewType, text (5–300 characters, whitespace tidied), position? (null = every position), sort? (default: the end of its type), active? }` | 201 `InterviewQuestion`; 409 "That question is already in the final interview list" when the same words (ignoring case and spaces) are already in that type's list for the same position or for every position (a sheet would show it twice) — "…, turned off. Turn it back on instead" when that one is turned off |
| `PATCH /recruitment/questions/:id` | any of the above | `InterviewQuestion` (moving it to another type puts it at the end there); a save of the same values changes nothing; the same 409 when the new words, type or position clash with another question |
| `PUT /recruitment/questions/order` | `{ interviewType, ids }` — every question of that type, once each, in the new order | `InterviewQuestion[]` of that type |
| `GET /recruitment/interviews/:id/sheet` | — | `InterviewSheet { interview (+ candidateName), answers, saved, candidate { id, name, stage, positionApplied, dateOfBirth }, summary, changes }`; a read never writes |
| `PUT /recruitment/interviews/:id/answers` | `InterviewAnswerInput[]` (1–30 items) — the first save sends every question on screen, in order; later saves only **what this device changed**: `{ questionId (a bank question) or null (a question of their own), questionText (required for their own; for a bank question, the words on screen), answer (≤ 4,000 characters), score? (1–5 or null), base? { answer, score } (what this device started from), removed? (true: take the question off) }` | `InterviewSheet`; **409** `{ error: "Question 3 was changed by Rhys Morgan on another device. Choose which answer to keep.", details: InterviewSheetConflictDetails { conflicts: [{ questionId, questionText }], sheet } }` when another device changed (or answered) the same question since this one saw it — nothing is written then; 400 for an unknown bank question, a question twice, their own question without words, an empty list, a bad score, a long answer, or a sheet left with no question or more than 30 |

Changes to the 1.0 routes (`routes/recruitment.ts`, P7's in 1.3):

- `POST /recruitment/candidates` and `PATCH /recruitment/candidates/:id` take `dateOfBirth` (YYYY-MM-DD; `null` or `""`
  clears it). It must be a real date, not in the future, giving an age of 14 to 100 (400 with the reason, e.g. "That
  makes them 11. Check the year: candidates are at least 14"). Every candidate payload carries `dateOfBirth` only when
  it is recorded (`db/queries.ts` mapCandidate, the foundation's hook).
- `POST /recruitment/interviews` also records who booked it, for when (`interview_changes` field `booked`).
- `PATCH /recruitment/interviews/:id` also records each field that really changed — the interviewer (ids), the time
  (compared as instants, so the same moment written another way is no change), the type, the outcome — with who and
  when, in the same transaction. Notes are not logged there (the audit trail has them). It refuses to move an
  interview to another candidate (400 "An interview stays with its candidate. Book a new interview for the other
  candidate"): its bookings, interviewers and sheet belong to its candidate. Sending its own `candidateId` is fine.

Audit (`lib/audit/recruitmentSpecs.ts`): "Added a phone screen question: “…”", "Edited a first interview question:
text …", "Turned off / on a … question", "Reordered the … questions", "Started / Updated the first interview sheet for
Sam Brown: 4 of 6 answered, average score 4.5" (filed under the candidate, the snapshot holds the questions as asked and
the answers). A save that changes nothing writes no row. `POST /recruitment/candidates` and `PATCH
/recruitment/candidates/:id` are refined from the 1.2 specs (same rows, same wording) so a date of birth change is
explained — "Updated candidate Sam Brown: date of birth set to 12 Mar 2001" / "changed from … to …" / "removed (was …)"
— instead of "(no changes)"; when the date of birth does not change the 1.2 rows pass through untouched. If a 1.2
spec is ever not found (P9's file changed), only this refinement is lost, with a warning at start-up; the server still
starts. A refused (409) save writes no audit row.

## Logic

**Date of birth** (`shared/src/logic/recruitmentPlus.ts`): `ageOn(dob, today)` is whole years (the birthday itself
counts; a 29 February birthday turns over on 1 March); `isUnderAge` is under `CANDIDATE_ADULT_AGE` (18);
`dateOfBirthProblem(dob, today)` is the one rule the form and the server share (real date, not future, 14–100). The
profile shows "18 Oct 2007 · 19", an **Under 18** badge and, while under 18, a note with the 18th birthday. Recruitment
roles only, like every candidate field; it is never copied to the person's account on hire and is not in the CSV.

**Who handled what.** "Who moved each stage" is `stage_changes.changed_by_id` (recorded since 1.0). Bookings,
reassignments, reschedules, changes of type and outcomes are rows of `interview_changes (interview_id, field, from_value,
to_value, changed_by, changed_at)`; field is `booked` · `interviewer` · `scheduled_at` · `type` · `outcome`.

**The timeline** (`buildCandidateTimeline`, pure, tested with hand-written fixtures) merges three lists, newest first:
every stage move ("Moved from Applied to Phone screen by Priya Shah", "Rejected at Interview by …", "Withdrew at Offer
(recorded by …)", "Hired by …", "Reopened at Offer by …", "Applied for the Trainee position (added by …)"), every
interview at its own time ("First interview with Amelia Hart", with its outcome; an upcoming one sits at the top), and
every change ("First interview: interviewer changed from Amelia Hart to Rhys Morgan by Priya Shah", "Phone screen moved
from Thu 22 Oct, 10:00 to Fri 23 Oct, 14:00 by …", "Phone screen changed to first interview by …", "First interview
outcome recorded as passed by …", "First interview booked for Mon 28 Sep, 12:45 by …"). Times are Europe/London; the
year is written only for another year. Ties at the same instant keep the story's order (applied, stage, booked,
interviewer / reschedule, interview, outcome; newest first, so an outcome sits above its interview), then the later row.
Interviewers who have left keep their name ("a former colleague" if the row is gone). Three queries per candidate.

**The interview sheet.** Until anything is saved, a sheet is a *draft*: the bank's active questions for the interview's
type, for every position or the candidate's (`draftSheetQuestions`, ordered by sort then id); reading it writes nothing.
The first save (anything at all: an answer, a score, "Not asked", a question added) fixes the questions: each
`interview_answers` row stores the words the interviewer had on screen, and a stored question keeps its words for good,
whatever a later save or a bank edit says — so changing the bank never changes a past interview. A bank question is
matched by its id, a question of the interviewer's own by its words.

**One sheet on two devices** (a laptop tab opened before the interview, a phone in the room, a second interviewer on
an observation day). After the first save a save holds only the questions this device changed, each with its `base`
(the answer and score it started from). Server rules (`saveInterviewAnswers`): a question left out of a save is never
touched; one comes off only with `removed: true` ("Not asked", only offered while it has no answer and no score); a
question whose answer equals its base is left as it is (another device's newer words stand); a changed one is written
only while the stored row still equals its base, else it is a **conflict** and nothing in that save is written (409
with the latest sheet); an answer already equal to the stored one is never a conflict (the same save arriving twice).
Taking off a question another device has answered is a conflict too. New questions go at the end; the order of stored
ones never changes. Only rows whose answer or score changed are written, with who and when; each answer shows who last
changed it. The page's side (`mergeSheetRows`, pure, tested): after every save, 409 and refetch it takes in other
devices' words for questions it has not touched, keeps whatever is being typed, and flags a question both devices
changed with the other version, until the interviewer picks **Keep mine** (sent with theirs as the base) or **Use
theirs**; every other question keeps saving meanwhile.
`sheetSummary`: questions, answered (a written answer), scored (a 1–5 score), and the mean score to one decimal place,
half up (hand-computed tests: 13 / 3 → 4.3, 15 / 4 → 3.75 → 3.8).

**Autosave** (the sheet page): 2.5 s after typing stops, when an answer box loses focus, 0.3 s after a score, on adding
or taking off a question, when the page is hidden (a phone put away) and when it is left. Saves go one at a time, in
order, through a queue outside React (`features/recruitment/sheetSaveQueue.ts`); each builds its payload when it runs
from the page's latest rows, so a change made while one is in flight is sent straight after it — also when the page has
been left in the meantime (the 1.3 review found the later answers lost then: TanStack Query skips a `mutate()` call's
own callbacks once the component has gone). Closing the tab sends what is left at once with `keepalive`. A save that
fails after the page was left says so in a toast. "Saving…", "Saved 10:42" (or "Last saved Tue 20 Oct, 13:44"), "Not
saved: … Try again", or the conflict line. A refetch (an outcome saved, a reschedule) never overwrites what is being
typed. The pacing keeps the audit trail to about one row per answer, not one per keystroke.

**The schedule** groups interviews by their Europe/London day (an interview at 23:30 UTC in summer is on the next day):
the server reads a UTC window one day wider each side and trims by London date. Quick ranges: today, this week and next
week (Monday–Sunday, `scheduleRange`). The filters live in the address (`?range=today&who=none&type=phone`).

**The question bank** starts with a default set on every database (`lib/recruitmentPlus/defaults.ts`, 25 questions:
6 phone screen, 8 first interview — one for team leader applicants only — 6 observation day, 5 final interview): plain
questions about the job, experience, availability, travel and how pay works. A fresh demo seed writes it; an existing
database gets it once on the next start (`upgrade`, meta `ext:recruitment:questions`, only while the bank is empty; a
fresh install's upgrade runs before the seed with no people yet and leaves it to the seed). It is a data step in P7's own
table, so it is not in the start-up "Upgraded schema" line (the 1.2 upgrade tests compare that list exactly). Questions are never deleted,
only turned off, so past sheets keep their link; the same words twice in one list are refused (see API).
`questionTopicWarning(text)` flags a question that seems to touch a protected characteristic (age, health — "health and
safety" is fine — family, religion, nationality or race, sexual orientation or gender, trade union membership) with a
warning under the field; it never blocks. It leaves the agency's own clients and causes alone ("Children's Hospice
North", "a children's charity"), matches whole words where a longer word means something else ("faith", not
"faithful"; "how old are you", not "how old is your car"), and flags "first language" and "mother tongue". Every default
question passes it (tested, with the review's fixtures).

**Demo data** (the extension's seed, its own random stream, fresh databases only; on core tables it changes only
`candidates.date_of_birth`): a date of birth for about 85% of candidates (two open applicants are 17, one turning 18 in a
few weeks); the change log of every seeded interview (booked soon after the stage move, in office hours — Mon–Fri 09:00–18:00
local time, like the core seed's interview slots; a stage move out of hours books the next working morning, or the last
working afternoon when the interview comes first, always at least 30 minutes before the interview and never after now;
about 10% first booked for an earlier slot and moved, about 12% of the non-phone interviews reassigned from another
leader, every recorded outcome); and the sheets of about 80% of the passed or failed interviews of the last six weeks with sample answers and
scores. Nothing is dated in the future; the same day gives the same rows.

**Files.** Shared: `types/recruitmentPlus.ts`, `logic/recruitmentPlus.ts` (+ test). Server: `db/extensions/recruitment.ts`,
`lib/recruitmentPlus/store.ts` and `defaults.ts`, `routes/recruitmentPlus.ts`, `routes/recruitment.ts`,
`lib/audit/recruitmentSpecs.ts`, tests `recruitment-plus.test.ts` and `recruitment-plus-seed.test.ts`. Client:
`api/recruitmentPlus.ts` (keys now under `['recruitment', 'plus', …]`, so the 1.0 recruitment hooks refresh them;
`putInterviewAnswers` / `storeSavedSheet` for the sheet's queue), `pages/InterviewSchedule.tsx`,
`pages/InterviewSheet.tsx` (mounts P9's `RecordOpened` — entity `candidate`, "interview sheet" — since the sheet shows
the date of birth and the answers), `pages/CandidateDetail.tsx`, `pages/Recruitment.tsx`, `features/recruitment/`
(QuestionBankSection, QuestionTopicHint, ScheduleInterviewModal (now with a candidate picker), RescheduleInterviewModal,
CandidateTimeline, CandidateSheets, DateOfBirth, AddCandidateModal, linkStyles, pdf, sheetSaveQueue).

**PDFs** (`features/recruitment/pdf.ts`, P4's `pdfDocument`): the candidate profile (details with the date of birth and
age, notes, the timeline, every saved sheet) and one interview sheet (the questions as asked, answers, scores, outcome),
each reported to the audit trail as a PDF export. The **PDF** buttons appear only while `PDF_EXPORTS_READY` is true
(P4 sets it), so they are not in this package's screenshots.

## User guide

**Recruitment → Schedule.** Every interview by day with its time, type, candidate (and the stage they are at now),
interviewer and how far the sheet has got. Choose **Today**, **This week** or **Next week**, and filter by interviewer
(**Me**, **No interviewer yet**, or a person) or by type. **Schedule interview** books one for any open candidate.
**Reschedule** moves it to another time or gives it to another interviewer; **Open sheet** opens the interview sheet.

**The interview sheet.** Open it from the schedule, from a candidate's **Interviews** card (**Sheet**) or from the
timeline. Each question has an answer box and an optional score from 1 to 5 (tap the score again to clear it). Write
the candidate's answers in a few words as you go — the sheet saves by itself ("Saved 10:42"). If you asked something
that is not on the sheet, add it under **Add a question you asked**; if you did not ask a question, tap **Not asked**.
Record the outcome on the right (at the bottom on a phone). Under each answer you can see who last changed it and
when. Until anything is saved the sheet shows today's questions; as soon as anything on it is saved its questions are
fixed, so changes in Settings never alter an interview that has happened.

The same sheet can be open on two devices: each saves only what it changed, so one never wipes the other's answers. If
both change the same question, the second sees "Rhys Morgan changed this on another device" with their answer under
yours: tap **Keep mine** or **Use theirs**. Nothing else on the sheet waits for that choice.

**A candidate's page** now shows the date of birth and age in the profile (the pencil edits it) with an **Under 18**
warning when it applies, every interview with **Reschedule** and **Sheet**, **Questions and answers** (each saved
sheet, the questions as they were asked, with who last changed each answer), and a **Timeline** of everything: who moved each stage, every interview and
its interviewer, bookings, interviewer changes, reschedules and outcomes. **Add candidate** has an optional **Date of
birth**.

**Settings → Recruitment: interview questions** (administrators and recruiters): pick the interview type, then **Add
question** (optionally only for one position), edit the words (pencil), move a question up or down, or **Turn off** one
you no longer ask (**Turn on** brings it back). A question already in the list is refused ("That question is already in
the final interview list"). Ask about the job only; a warning appears if a question seems to be about age,
health, family, religion, where someone is from or another protected characteristic.

## Owner notes

- **Default questions.** Your database gets the 25 default questions on the first start of 1.3 (Settings →
  Recruitment: interview questions). They are a starting point: edit them to your own words. Changing a question never changes an interview
  that already has a saved sheet.
- **Lawful questions.** The warning in Settings is a gentle check, not legal advice: interview questions should be about
  the job only (Equality Act 2010). Availability ("Which days can you work?") is fine; family plans, health, age,
  religion and nationality are not. Right-to-work checks belong in your onboarding process, not in the interview.
- **Date of birth is personal data.** Only administrators, leaders and recruiters can see it (recruitment is theirs
  already), it is not in the candidates CSV, and it is not copied to a person's account when they are hired. Recording
  it is optional; the profile warns when a candidate is under 18 so the extra rules for young workers (hours, breaks,
  supervision) can be checked before an offer. Under 14 or over 100 is refused as a likely typo in the year.
- **Interviews booked before 1.3** have no record of who booked them or of earlier interviewers; the timeline shows what
  was recorded (the stage moves always had who made them). Old interviews have no sheet until someone opens and saves
  one.
- **Leaders and recruiters can edit any sheet** (as they can edit any interview today); every save is in the audit
  trail with who wrote it, and each answer shows who last changed it (on the sheet and in the candidate's Questions
  and answers). Two devices on one sheet never overwrite each other: a clash on the same question asks the second
  person to choose. Opening a sheet is reported to the audit trail like opening the candidate's profile (once P9 fills
  `RecordOpened`).
- **For the lead / P9:** `lib/auditSpecs.ts` `candidateSnapshot` (P9's) has no `dateOfBirth`; P7 refines the two 1.2
  candidate specs from `recruitmentSpecs.ts` to add it (the same pattern as P6's campaign specs). If a 1.2 spec is not
  found it is skipped with a warning (no crash). Better: at merge, P9 adds `c.date_of_birth AS dateOfBirth` to
  `candidateSnapshot` and the refinement (`withDateOfBirth`) is dropped.
- **For the lead: a renamed label.** The plan says "Question bank: Settings → Recruitment"; the card is titled
  **Recruitment: interview questions** so both words are on screen.
- **For the lead: PUT /answers changed shape during the review fixes** (P7's own route, unreleased): questions left out
  of a save are no longer taken off (`removed: true` does it), each item may carry `base`, and a clash answers 409. No
  other package calls it. The main chunk grows by 0.57 kB
  (472.19 → 472.76 kB) only for the preload map of the new lazy chunks; no P7 code is in it.
