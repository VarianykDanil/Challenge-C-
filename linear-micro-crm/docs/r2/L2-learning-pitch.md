# L2 learning-pitch: the pitch studio

One pitch per campaign, set for reading aloud, with the fact check beside the lines it concerns, the COD pack theory
behind each line, a step timer and three practice modes (Read, Teleprompter, Memorise). The owner's Breast Cancer Now
(BCN) pitch is seeded word for word with its fact-check notes; admins and leaders write and edit the others.

## API

All three routes are mounted behind `requireAuth` (anonymous → 401). Pitches are company-wide training material
(campaigns are not team-scoped), so **every signed-in role reads every pitch**; only admins and leaders write.
Types: `shared/src/types/pitches.ts`. Both GETs go through the response cache (`/pitches` is in `CACHED_PATHS`, which
covers `/pitches/:campaignCode` too); every PUT bumps the data version, so the next read is fresh.

| Method and path | Who | Answer |
| --- | --- | --- |
| `GET /pitches` | every role | `PitchListItem[]`: one row per campaign, active campaigns first, then by name: `{ campaignId, campaignCode, campaignName, campaignColor, campaignActive, hasPitch, title, updatedAt }` (`title` and `updatedAt` null without a pitch) |
| `GET /pitches/:campaignCode` | every role | `CampaignPitch`: `{ id, campaignId, campaignCode, campaignName, campaignColor, title, body, facts, updatedBy, updatedByName, updatedAt }`. The code is case-insensitive. **404 `Campaign not found`** for an unknown or malformed code (not 2–6 letters or digits), **404 `Pitch not found`** when the campaign has no pitch yet |
| `PUT /pitches/:campaignCode` | admin, leader (others 403) | Body `PitchUpsertInput` `{ title, body, facts? }`. **201** with the `CampaignPitch` when it creates the pitch, **200** when it replaces it. 404 `Campaign not found`; 400 `Validation failed` with details |

PUT rules:

- `title`: inner whitespace collapsed, trimmed, 1–120 characters (`PITCH_TITLE_MAX`).
- `body`: CRLF/CR become LF, trimmed, 1–20,000 characters (`PITCH_BODY_MAX`). Stored exactly as written otherwise: the
  server never rewrites the script.
- `facts`: CRLF normalised, trimmed, at most 10,000 characters (`PITCH_FACTS_MAX`). **Left out keeps the saved notes**;
  `null` or blank clears them.
- `updated_by` is the caller, `updated_at` the business clock (`nowISO()`). One row per campaign (`campaign_id` is
  unique): a PUT is an upsert. U3's audit middleware records each edit; nothing here writes the audit log itself.
- A pitch never creates gauge rows or payroll runs (route test).

Database (`server/src/db/extensions/pitches.ts`):

```sql
CREATE TABLE IF NOT EXISTS campaign_pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  facts TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
```

The BCN pitch (title "The BCN pitch", `BCN_PITCH_BODY`, `BCN_PITCH_FACTS`, saved by the owner) goes in:

- on a **fresh demo seed** by the extension's `seed` (BCN campaign from `ctx.campaigns`, owner from `ctx.users`,
  `ctx.nowIso`), which also records the meta flag `ext:pitches:bcn`;
- on an **existing database** by `upgrade`, once: when the flag is missing and a campaign with code BCN exists, it
  inserts with `INSERT OR IGNORE` (an office-edited pitch is never replaced), sets the flag and reports
  `pitches:campaign_pitches.bcn` only when a row went in. On a fresh install `upgrade` runs before the seed on an empty
  campaigns table, finds no BCN campaign and skips without setting the flag, so the first restart after a fresh seed
  reports nothing (r2-contracts test). Other campaigns get no pitch.

## Logic

Pure, in `shared/src/logic/pitchScript.ts` and `shared/src/logic/pitchAnnotations.ts` (tests in
`shared/src/logic/pitchScript.test.ts`, on the owner's BCN pitch word for word and on synthetic scripts).
The modules have no top-level calls, so the client bundles them with the pitch page only (main chunk unchanged).

### Script format (`parsePitchScript(body)` → `PitchScript`)

Plain text, one spoken line per line; a blank line separates paragraphs (`break` blocks, never two in a row, none at
either end). Line numbers are the 1-based source lines.

- A line that is only brackets is a **stage direction** (`direction` block): `(Slow smile and cautious)`.
- `(Pause)`, `(Pause - 1 Second)`, `(Pause 2s)`, `(Long pause)`, `(Pause for effect)` is a **pause beat** (`pause`
  block); its length is the first number (seconds), or null (counted as 1 s, `PITCH_DEFAULT_PAUSE_SECONDS`).
- `(Name)` is the person's **name slot**; `(Close)` is the **close marker**.
- Brackets inside a spoken line become inline segments in order (`text`, `name`, `close`, `pause`, `direction`):
  `Pretty amazing right!! (Close)` → text + close; `… have you got some for me? (Smile and laugh)` → text + direction.
  An unbalanced bracket stays text.
- `(Introduction)`, `(Short story)`, `(Presentation)`, `(Consolidation)` (or `(Step 3: presentation)`) on its own line
  **starts that step**; the page shows a step heading instead of the direction (`stepMarker`). A lone `(Close)` line is
  a close beat and starts the close step.
- A line starting **`Yes -`** or **`No -`** (also `Yes:`, en/em dash; never `No-one`) starts a **branch** for the
  answer to the previous question (`branch` block with `question` = the last spoken line, `branches` Yes/No). A branch
  runs until the other answer's line, or until an end line `(Both)` / `(Back to the pitch)` / `(End of branch)` (not
  shown). The last branch otherwise ends at the end of its first paragraph. The same answer again starts a new
  question's branches. Text after `No -` on the same line is the branch's first line.

### Steps and timing

- The five steps of the COD pack (`PITCH_STEP_TARGETS`): Introduction 7–10 s, Short story 10–15 s, Presentation,
  Close, Consolidation (no set time for the last three).
- Each spoken line is tagged with a step. The first spoken line is always the Introduction. After that a step starts at
  an explicit marker, or at a cue (`PITCH_STEP_CUES`): Short story at "what we do", "who we are", "we're from", "we
  help/support/fund/provide/raise"; Presentation at "survival rate", "as of 19xx/20xx", "since 19xx/20xx", "the
  problem", "the solution", "unfortunately", "obviously"; Close at the `(Close)` marker, "I'm sure we can count on",
  "can we count on", "shall we get you", "let's get you signed up"; Consolidation at "welcome call", "welcome pack",
  "thank you for signing/joining", "at least 2 years". **Cues only move forward**: a later "unfortunately" never takes
  the close back to the presentation. Branches start at the step before them; after them the furthest step wins.
- Read-aloud estimate: words at **150 words a minute** (`PITCH_WORDS_PER_MINUTE`; numbers count as words, emoji and
  punctuation do not) plus every pause, along the **longest path** (per Yes/No question only the longer branch).
  `steps[]` gives each step's whole seconds, spoken lines and first line; `estimatedSeconds` the total;
  `lineCount`/`wordCount` count every spoken line with words (both branches).
- `pitchStepVerdict(seconds, target)`: `under` / `within` / `over` against the target (inclusive), `none` without a
  target or when the step is empty.
- The seeded BCN pitch: 19 spoken lines; Introduction (lines 1, 4, 9) about 22 s, Short story (from "What we do",
  line 11, through the Yes/No and "Our mission") about 25 s, Presentation (from "As of 1980", line 24) about 14 s,
  Close (from the owner's "(Close)" on line 28) about 52 s, no Consolidation: about 1 min 52 s in all. The page shows
  the introduction and short story as "Longer than 7–10 s" / "Longer than 10–15 s" (an estimate; the step timer
  measures the real thing).

### Annotations (`PITCH_ANNOTATION_RULES`, `annotatePitchLine`)

Phrase patterns → the COD pack theory, a one-line why and the L1 lesson it links to
(`/learning/pack/:lessonKey#anchor`; every key and anchor is checked against `LESSON_KEYS` / `LESSON_ANCHORS`).
Matching is case-insensitive on the line as written (brackets included), with curly quotes straightened; a theory
appears once per line, in rule order.

| Chip | Matches (examples) | Lesson |
| --- | --- | --- |
| Hook | a line opening "Over/Nearly/About 1000 …", "every 43 minutes" | five-steps#introduction |
| Strategic pause | `(Pause …)` | strategic-pause |
| Pre-emptive strike | "I know that's …", "I know you're …", "I can see you're …" | pre-emptive-strike |
| Indifference | "no pressure", "take it or leave it" | impulse-factors#indifference |
| Short story | "what we do", "who we are", "our mission", "why we are here" | five-steps#short-story |
| Problem and solution | "survival rate", "our goal", "this close" | five-steps#presentation |
| Close | `(Close)` | five-steps#close |
| Buzzwords | "unfortunately", "obviously", "however" | five-steps#presentation |
| Past tense | "said they'd love", "who have stopped" | five-steps#presentation |
| Group effect | "people like yourself", "everyone", "we all", "as well" | impulse-factors#group-effect |
| Greed | "something small", "wouldn't miss", "a few quid", "a tenner", "£10 a month" | impulse-factors#greed |
| Power of suggestion | "I'm sure" | impulse-factors#power-of-suggestion |
| Fear of loss | "I would need to check", "if you qualify" | impulse-factors#fear-of-loss |
| Qualifying question | "You live/bank in the UK", "over the age of", "cheeky question" | impulse-factors#fear-of-loss |
| Consolidation | "welcome call", "at least 2 years" | five-steps#consolidation |
| Smile (directions only) | a stage direction with "smile" | five-steps#introduction |

### Fact-check notes (`parsePitchFacts(facts, body)` → `PitchFact[]`)

- One note per bullet (`- `, `* `, `• `, `1.`); wrapped lines join their bullet; without bullets each paragraph is a
  note.
- Leading quotes (`"…"` or `“…”`, several joined by "and") are what the note is about (`quotes`, `quote` = the first);
  the note is the rest after the colon. URLs become `sources` and leave the note ("Source:" and empty brackets go
  too); `Suggested wording: "…"` becomes `suggestion`. The first letter is capitalised.
- `tone`: `info` without a quote (a general note), `verified` when the note starts "Matches", "Confirmed", "Correct",
  "Verified", "Accurate" or "True", else `check`.
- `lines`: the body lines a quote matches, ignoring case, punctuation, apostrophes and emoji; `...`/`…` in a quote
  stands for left-out words (fragments in order); a quote may span up to three lines.
- The script itself is never changed to match a note: the notes sit beside it ("Check the figures"), and the office
  approves final figures (the BCN general note quotes the Fundraising Regulator's code).

### Flashcards (`pitchCards(script)`)

One card per spoken line with words, in reading order: the cue is the line said just before (a branch line's cue is
the question, never the other branch), branch lines carry their answer. Keys are `pitchLineKey(text)` (FNV-1a of the
straightened, lower-cased words, base 36; `:2`, `:3` for repeats), so editing one line resets only that card.
Progress lives on the device: `localStorage['lm-pitch-memorise:<userId>:<CAMPAIGN>'] = { v: 1, known: [keys] }`
(every storage call wrapped). Other per-device choices: `lm-pitch-mode`, `lm-pitch-theory`, `lm-pitch-prompter-wpm`.

## User guide

**Learning → Pitches.** At the top of the Learning page there is a card for every active campaign (and any inactive
one that has a pitch). A campaign with a pitch shows its title and when it was last updated; tap it to open the pitch.
Admins and leaders see **Write the pitch** on a campaign without one; everyone else sees "Not written yet".

**Opening a pitch from the field.** On **Quick gauges** a microphone button next to the event opens that campaign's
pitch; on an event's page the **Pitch** button does the same. Both only appear when the campaign has a pitch.

**The pitch page** (`/learning/pitch/BCN`) shows the campaign, the title, how many lines it has, about how long it
reads aloud and who updated it last. Choose how to practise:

- **Read**: the script in large type, in its five steps (Introduction, Short story, Presentation, Close,
  Consolidation), each with the pack's target time and the script's estimate. Stage directions are grey italics,
  pauses are a row of dots ("Pause · 1 s"), **Name** marks where their name goes and **Close** marks the close. When
  they answer a question, "If yes" and "If no" sit side by side (tabs on a phone). Under each line, small chips name
  the COD pack theory it uses (**Pre-emptive strike**, **Group effect**, **Greed** …); tap one to see why it works and
  **Open the lesson**. Turn **Show the theory** off for a clean script.
- **Check the figures.** Where the fact check has a note on a line, it sits beside the line on a wide screen and under
  it on a phone (tap **Check the figures**): what the charity actually says, a suggested accurate wording and the
  source. A green **Figure checked** note means it matches. The script itself is never changed by the check: the office
  decides the final wording.
- **Step timer**: tap **Start** as you begin, **Next step** as you move from the introduction to the short story and
  on, then **Finish** (or **Stop**). Each step shows your time against the target (introduction 7–10 s, short story
  10–15 s). On a phone it shrinks to one line that stays at the top while you read down. Nothing is saved.
- **Teleprompter**: the script on a dark panel that scrolls by itself past a reading line. **Play**/**Pause**, **−**
  and **+** to change the speed (words a minute, kept on the phone), the circle arrow to go back to the start, and the
  corner button for full screen. Turn the phone sideways for the widest lines. On a keyboard: Space plays and pauses,
  the arrow keys change the speed, F goes full screen, Esc leaves it. The screen stays awake while it plays.
- **Memorise**: flashcards, one line at a time. You see the line before as the cue; say the next line, then tap to
  check and mark it **Known** or **Again**. "Lines you know" counts up; **Only lines still to learn** skips the ones you
  know; **Start over** clears it. Progress is saved on this device only.

**Writing and editing (admins and leaders).** **Edit** on a pitch (or **Write the pitch**) opens the editor: a title,
the script, and the fact-check notes, with a live **Preview** beside it (a **Write**/**Preview** switch on phones and
tablets). **How to write the script** lists the format: one spoken line per line; `(Pause - 1 Second)` for a pause;
`(Name)` for their name; `(Close)` for the close; `Yes -` and `No -` for the answers to a question; `(Short story)`,
`(Presentation)` and so on to start a step. **Start from a template** fills an empty script with a skeleton in that
format. Fact-check notes go one per line starting with "- ", with the words they are about in double quotes and a
colon; links become sources. **Save pitch** publishes it to everyone straight away; **Cancel** asks before throwing
changes away. Every save records who made it, and the audit trail keeps the history.

Recruiters and reps read every pitch and practise with all three modes; they cannot edit.
