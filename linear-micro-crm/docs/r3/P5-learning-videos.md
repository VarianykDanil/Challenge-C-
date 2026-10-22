# P5 learning-videos

Recorded interviews and talks to watch in Learning: uploads streamed from the server or YouTube / Vimeo / Google Drive links, with progress and required videos.

The contracts this package builds on (tables, types, routes, slots, helpers, the files it owns) are in
`r3-foundation.md`, section **P5 learning-videos**. Owner's decision 5: "Learning: Matt wants VIDEOS (recorded
interviews, talks) people watch as part of learning." Lead decision: upload to the server (mp4/webm/mov, up to 2 GB,
streamed with byte ranges) or a link (YouTube, Vimeo, Google Drive); an optional "required" flag adds the video to the
Learning checklist.

## API

All under `/api/videos` (`server/src/routes/videos.ts`), behind `requireAuth`: anonymous → 401; a client portal
account → 403 `{ clientPortalOnly: true }` on every one of them (the foundation's client guard). Types in
`shared/src/types/videos.ts`. A video outside the caller's audience answers **404 "Video not found"**, exactly like one
that does not exist.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /videos` | staff | `LearningVideo[]` the caller's role sees, newest first, each with `my` (their own progress or null) |
| `GET /videos/access` | staff | `{ canAdd, uploadRoomBytes? }`: `canAdd` is true for admins always, and for leaders while Settings → Learning videos allows it. `uploadRoomBytes` (only for admins and leaders who may add videos) is the bytes an upload may use now: free space, less the reserve, less what the uploads already arriving will still write. It is null when the server cannot tell |
| `GET /videos/settings` · `PUT /videos/settings { leadersCanAdd }` | admin | `VideoSettings { leadersCanAdd, storage: { uploads, bytes, folder } }` (`storage` on GET and PUT answers only) |
| `GET /videos/team[?userId=]` (cached) | admin (everyone), leader (own team) | `TeamVideoProgress { required, rows, videos }`; `?userId=` one person (a leader: themself or their team, else 403; a client account or unknown id 404) |
| `POST /videos` `VideoLinkInput` | admin; leader when allowed | 201 `LearningVideo`. 400 for anything but a YouTube, Vimeo or Google Drive video link; 409 "This video is already in Learning as “…”" for the same video in any form of link |
| `POST /videos/upload` (multipart) | admin; leader when allowed | 201 `LearningVideo`. See *Uploads* below |
| `GET /videos/:id` | staff in its audience | `LearningVideo` |
| `GET /videos/:id/stream` (+ `HEAD`) | staff in its audience | the file: 200, or 206 for a `Range: bytes=…` request, 416 past the end; `Accept-Ranges: bytes`, `Cache-Control: private, no-store`, `ETag`, `If-Range`. 404 for a link; 404 "The video file is missing on the server: restore the media folder from your backup, or upload the video again" when the row's file is gone |
| `GET /videos/:id/poster` | staff in its audience | the upload's still (JPEG, `private, max-age=86400`); 404 without one |
| `POST /videos/:id/poster { image, durationS? }` | whoever may edit it | `LearningVideo`. `image` = `data:image/jpeg;base64,…` of at most 600 KB (fits the 1 MB JSON limit); `durationS` fills a missing length only (and then counts everyone who has already seen 90% of it as watched). 400 for a link or anything but a JPEG |
| `GET /videos/:id/views` | admin | `VideoViewRow[]`: everyone who started it (never client accounts), watched first, with `marked` when **Mark as watched** made it watched (stored when it happened) |
| `PATCH /videos/:id` `VideoUpdateInput` | admin; the leader who added it while leaders may add | `LearningVideo`. Title, description, topic, audience, required, `durationS` (the link itself never changes; a new length counts everyone who has already seen 90% of it as watched, and never takes "watched" back); 400 "Nothing to change" for `{}` |
| `DELETE /videos/:id` | same | 204; an upload's file and still are deleted too; everyone's progress goes (CASCADE) |
| `POST /videos/:id/progress` `VideoProgressInput` | staff in its audience | `VideoProgress` (their own row only), with `marked` and `owedS`: seconds the report showed as seen that are not counted yet (over the watch credit). 429 after 30 reports by the same person for the same video in a minute: "That is more than 30 progress reports for this video in a minute. What you watch is kept and counted from your next report." The player sends about 4 a minute |

`LearningVideo` adds to the foundation's fields: `provider` ('youtube' \| 'vimeo' \| 'drive'), `thumbnailUrl`
(YouTube's still from i.ytimg.com, or `/api/videos/:id/poster`), `canEdit`; `VideoProgress` (and so `LearningVideo.my`)
adds `marked`. File paths are never sent. `embedUrl` is
the plain embed; the page builds the tracking one (`videoEmbedUrl(url, { startS, origin })`).

**Uploads** (`POST /videos/upload`, the app's only multipart route; `lib/videos/upload.ts`, busboy 1.6.0). Parts in
the order `VIDEO_UPLOAD_FIELDS`: `title`, `description`, `topic`, `audience`, `required` ("true"/"false"),
`durationS` (whole seconds, optional), `poster` (optional JPEG ≤ 600 KB; one that is not a JPEG is left out), then
`video` last. The fields are validated when the video part starts, so a missing title fails at once, not after 2 GB.
The file streams straight to `media/videos/<uuid>.upload` and is renamed to `<uuid>.mp4|webm|mov` once complete.
Refusals: 400 not multipart / no file / empty file / cut off; 413 over 2 GB (a declared `Content-Length` over the cap
is refused before reading; the counter stops a lying one) or too many parts; 415 "Upload an MP4, WebM or MOV video"
when the first bytes are not an ISO media (MP4 / MOV) or WebM container, whatever the name says; **507 before the
file is read** when the disk has no room for it: an upload may use the disk's free space less a reserve of a tenth of
the disk, at most 500 MB (a 1 GB cloud volume keeps 100 MB for the database and its backups): "The server has room for
420 MB more and this video is 1.3 GB. Free some disk space on the server, or add the video as a YouTube, Vimeo or
Google Drive link." (or "The server is almost out of disk space. …" without a declared size). The room counts the
uploads already arriving: each holds its declared size, less what it has written, until it ends (last fix round). So
two uploads that each fit, but not together, are never both let in. 507 also if the disk fills while it arrives:
"The server ran out of disk space while this video arrived. Free some disk space on the server, or add the video as a
YouTube, Vimeo or Google Drive link." Any failure removes the partial file and answers with `Connection: close`. While at least one upload is
arriving the HTTP server's `requestTimeout` is raised from Node's 5 minutes to 3 hours (a 2 GB file over a hotspot)
and put back once the last one ends.

**Progress** (`POST /videos/:id/progress`): `{ watchedS, positionS?, ended?, ranges?, durationS?, markWatched? }`.
`ranges` (≤ 200 per report) are the parts seen since the page opened; the server merges them with the stored ones and
counts each second once (`watched_s` never goes down). Without `ranges` a link keeps the larger of `watchedS` and what
it had; for an upload a bare `watchedS` adds nothing (its player always sends the parts it showed). What one report
adds is limited by the **watch credit** (below), so "watched" cannot be claimed with one request. `ended` puts the
resume position back to 0. `markWatched` is for links only (400 for an upload: "An uploaded video counts as watched
once you have seen 90% of it"). A video without a length takes `durationS` from a report by someone who may edit it
(and then everyone who has already seen 90% of it counts as watched); anyone else's reported length only limits their
own ranges, and decides their own "watched" for a link only — **an upload without a length of its own counts as
watched only once it has one**. A link watched to 90% of a length only the viewer's own player reported is stored as
**Marked** (their own word, like Mark as watched). Once the link has a length, a viewing measured at 90% of it becomes a
watch (last fix round). A report that makes a video watched clears the response cache itself. The others no longer
clear it either: the blanket "every write clears the cache" step in `app.ts` skips progress reports (the P5 merge
note, applied in the last fix round).

**Audit** (`lib/audit/videoSpecs.ts`): "Added video: “…” (YouTube link)" / "(upload, 312 MB)"; "Updated video “…”:
required no → yes" (nothing when nothing changed; a description is named, never quoted); "Deleted video “…”"; "Added a
still to video “…” (length 0:42)" / "Replaced the still of video “…”"; "Changed learning video settings: leaders can
add videos no → yes". Progress writes a row only when it makes the video watched for that person ("Watched “…”" or
"Marked “…” as watched"). The report every 15 s writes nothing. Last fix round: a report from an editor's player that
gives the video its length writes "Set the length of video “Team talk” to 1:04 (from Danil Varianyk’s player);
counted 1 person as watched". Edit video and the still step add "; counted N people as watched" when a new length
counts people. Snapshots never hold a file path.

## Logic

- **Tables** (`db/extensions/videos.ts`): the foundation's `learning_videos` and `video_views`, plus P5 columns added
  with `addColumnIfMissing` so a database made at the foundation commit upgrades: `learning_videos.poster_path` (the
  still, `videos/<uuid>.jpg`), `video_views.ranges` (JSON `[[from, to], …]` in whole seconds), `video_views.marked`
  (1 when **Mark as watched** made it watched; stored, so changing a length later never turns a real watch into
  "Marked"), and the watch credit `video_views.credit_s` / `credit_at` (real-clock milliseconds of the last report).
  Meta `ext:videos:leaders_can_add` ('1' / '0'). No core table is touched.
- **Files** (`lib/videos/files.ts`): the media folder sits next to the database file: `server/data/media` by default
  (git-ignored), `<folder of DB_PATH>/media` otherwise; uploads in `media/videos/`. The database stores the path
  relative to the media folder (`videos/<uuid>.mp4`), and only names matching `videos/<uuid>.(mp4|webm|mov|jpg)` are
  ever opened, so a row can never point outside the folder. Unfinished `*.upload` files older than a day (a server
  stopped mid-upload) are removed when the server starts. The nightly backup copies the database only.
- **Who sees what** (shared `videoAudiencesFor`): admins and leaders see every audience (leaders coach reps, so they
  see the reps' videos); reps see "everyone" and "reps"; recruiters "everyone". **Required for** (`videoRequiredFor`):
  "everyone" → every staff role (admins included); "leaders" → leaders; "reps" → reps.
- **Watched** (`isVideoComplete`): 90% of the length seen (598 s × 0.9 = 538.2 s), counted as merged ranges
  (`mergeWatchedRanges`, `watchedRangesSeconds`): replaying a minute counts it once, skipping ahead counts nothing
  (the player's `recordWatchSample` treats a forward step over 4 s, or any step back, as a seek). Ranges a second apart
  are one range; beyond 500 stored ranges the two closest are joined. An upload counts as watched only once it has a
  length of its own (from the file, the editor's browser, or Edit video); a link may use the length its player reports
  for that viewer. When a video gets a length, everyone who has already seen 90% of it is counted as watched in one
  statement (`completeViewsAtLength`). Once watched it stays watched (`completed_at` is never cleared).
- **Watch credit** (shared `watchCreditAt`, `creditedWatchSeconds`; `lib/videos/progress.ts`): the seconds counted may
  grow at most as fast as a player at double speed could show them — 2 s per second of the real clock (never the
  business clock), from a credit of up to 2 minutes that refills between reports and that each report spends. A first
  report starts with the full 2 minutes. Worked by hand: claiming all of a 10-minute upload in one report counts 120 s;
  claiming it again every 15 s adds 30 s each time, so it is watched (540 s) after 14 more reports, 3.5 minutes — no
  faster than playing it at double speed. **Last fix round:** a viewing starts with 40 s
  (`VIDEO_WATCH_CREDIT_START_S`: two reports at double speed plus a margin). That applies to the first report, and to
  the first after 10 minutes without one (`VIDEO_WATCH_SESSION_GAP_S`; a credit is never banked between viewings). The
  player reports as soon as it starts playing, so the clock runs from then. A 100 s upload claimed in one report now
  counts 40 s (it was 100 s, watched), and the 10-minute example needs 17 reports (4.25 minutes). The answer's `owedS`
  says what is over the credit, and the player sends again on its next tick until nothing is owed, even if nothing new
  was seen. A viewer at normal speed reporting every 15 s loses nothing; one whose
  reports were lost for two minutes gets the rest counted on the next reports (what is over the credit stays in the
  ranges). Reports every 100 ms gain nothing extra (the credit is per second, not per report).
- **The player** reports when it starts playing, then every 15 s while something new was seen or anything is still
  owed (`VIDEO_PROGRESS_INTERVAL_S`), on pause, at the end, and with `keepalive` when the page is hidden or closed. A
  failed report keeps its ranges for the next one, and a failed end report is repeated with the next report (so the
  resume point still goes back to the start). A report sent twice changes nothing. **Resume** (`videoResumeAt`): the saved position, except within 5 s of the start,
  within 10 s of the end, or once watched (then from the beginning).
- **Lengths**: an MP4 / MOV's own length is read on the server from its `moov → mvhd` box (wherever `moov` sits);
  a WebM's comes from the browser. Uploads: the first time someone who may edit it opens the video, their browser reads
  the server's copy in a hidden muted player, takes a 640 px still and the length, and sends them (`POST /:id/poster`)
  — the page's CSP (`media-src` falls back to `'self'`) lets the browser play Linear Hub's own stream but not a local
  file, so this cannot happen in the upload form. Once it has a still nothing is sent again. A length still unknown can
  be typed in Edit video. Links: the length is typed when adding (mm:ss or minutes) or reported by the admin's player.
- **Links** (`parseVideoLink`, `videoEmbedUrl`): YouTube (watch, youtu.be, shorts, live, embed; `t=`/`start=`) plays
  from youtube-nocookie.com with `rel=0`; Vimeo (incl. unlisted hashes, showcases, `#t=`) with `dnt=1`; Google Drive
  (`/file/d/<id>/…`, `open?id=`, `resourcekey`) from its `/preview` page. Stored with their scheme. CSP
  (`lib/videoEmbeds.ts`): `frame-src` youtube-nocookie.com, youtube.com, player.vimeo.com, drive.google.com;
  `img-src` i.ytimg.com, i.vimeocdn.com. No provider script is loaded: YouTube and Vimeo report their position by
  `postMessage` (`embedListenMessages`, `parseEmbedMessage`, origin-checked). A player counts as reporting only once it
  sends its time while it plays. Google Drive cannot report, so its page offers **Mark as watched**; so does a YouTube
  / Vimeo player that stays silent for 10 s, or that answers but sends no time within 10 s of saying it plays or of
  being tapped (a time arriving later hides the button again).
- **Team view** (`GET /videos/team`, cached; one grouped query for the views): the required videos as columns
  (newest first) and, per person, a cell for each one required for their role, "watched required" of "required
  total", and how many videos they have watched in all. Leader: active members of their own team; admin: every active
  member of staff. Client accounts never appear.
- **Demo seed** (fresh `npm run seed` only, its own random stream): three **example** LINK videos, public TED talks on
  YouTube marked `example = 1` (each card and page says **Example**; no file is uploaded): "How to speak so that people
  want to listen" (Pitching, required for everyone, 9:58), "Your body language may shape who you are" (Interviews,
  21:02), "How great leaders inspire action" (Leadership, required for leaders, 18:04), with viewing for the demo
  people (Jordan Lee: the first watched, the second a third of the way; Amelia Hart: the first watched, the leaders'
  one half way). An upgraded database gets none.

## User guide

**Learning → Videos** (everyone): under the pitches on the Learning page. Each video shows its still, length, topic
and badges: **Required** (for you), **In progress**, **Watched** (with the day) and **Example**. What is required of you
and not watched comes first, then what you are part way through. With more than four videos you can filter by topic.

**Add video** (administrators, and team leaders when an administrator allows it): choose **Upload a file** (MP4, WebM
or MOV up to 2 GB; a progress bar shows how far it is, **Cancel upload** stops it; keep the page open) or **Paste a
link** (YouTube, Vimeo or Google Drive; a Drive file must be shared with "Anyone with the link"). Then a title, what it
covers, the topic (Interviews, Pitching, Objections, Leadership, Other), who it is for (Everyone, Leaders, Reps) and
**Required**, which adds it to the Learning checklist of everyone it is for. For a link you can give the length
(mm:ss, e.g. 9:58): it counts as watched at 90% of it. After adding, the video's page opens. While a video uploads,
pressing Escape or Back asks **Stop the upload?** (**Keep uploading** / **Stop the upload**), and closing or reloading
the tab asks before leaving. Ctrl+K / ⌘K (the search) waits until the upload has finished ("Search opens once the
upload has finished"). **Cancel upload** stops it at once.

**The video's page**: the player, picking up where you left off ("Picked up where you left off, at 8:15." with
**Start from the beginning**). **Your progress** fills in as you watch and says **Watched** once you have seen 90%;
skipping ahead does not count, and watching a part twice counts once. An uploaded video whose length Linear Hub could
not read counts as watched once it knows the length (the office can type it in Edit video). A Google Drive video cannot tell Linear Hub how
much you watched: tap **Mark as watched** when you have. Administrators see **Who watched** (who has watched it and
when, and who is part way). Whoever may change a video sees **Edit** (title, description, topic, who it is for,
required, a link's length) and **Delete video** there.

**Learning → Progress**: **Required videos** lists the ones required of you, with a bar ("1 of 3 watched"); each
counts once you have seen 90% of it. Leaders on **My team**
(administrators on **Everyone**) see how many people have watched every required video and a row per person
("6 of 8 watched", a numbered dot per video, green once watched); a person's own page shows their required videos.

**Settings → Learning videos** (administrators): **Leaders can add videos** (off at first), and how many uploaded
videos the server holds, how big they are and the folder they are in.

## Owner notes

- **Back up the media folder yourself.** The nightly backup (and `npm run backup`) copies the database only, never the
  video files. Uploaded videos live in `server/data/media/videos/` (next to the database; Settings → Learning videos
  shows the exact folder and its size). Copy `server/data/media/` when you back up or move Linear Hub. After restoring
  an older database, videos uploaded since have no row (their files can be deleted); a video whose file is missing
  says so on its page — copy the folder back or upload it again.
- A fresh `npm run seed` starts a new database but leaves files already in `server/data/media/` on disk; delete the
  folder if you do not need them.
- **The three demo videos are examples**: public TED talks on YouTube, marked Example. Delete them (Edit → Delete video)
  once you have your own. Your own upgraded database has no videos until you add some.
- Leaders cannot add videos until you turn on **Settings → Learning videos → Leaders can add videos**; a leader can
  then change or delete only the videos they added (you can change any). Turning it off keeps their videos.
- Uploads are stored as sent: nothing is converted. MP4 (H.264) plays everywhere. A MOV from an iPhone recorded in
  HEVC ("High Efficiency") may play only in Safari; set the iPhone camera to **Most Compatible** or upload an MP4 for
  Android phones. A file of 2 GB over a phone hotspot can take hours — upload big files on Wi-Fi.
- **Mark as watched** (Google Drive, or a player that does not report) is trusted: Who watched shows "Marked" for those
  rows so you can tell them from videos watched to 90%. Prefer YouTube (unlisted), Vimeo or an upload for required
  videos you want measured. Watching itself is measured by the browser; the server counts it no faster than playing
  at double speed, so a required video cannot be ticked off in one go, but a determined person could still leave a
  video playing unwatched — the numbers say a video was played, not that it was understood.
- **Disk space on Fly.io or Render.** Uploads sit on the same volume as the database and its backups. Those plans
  start with a 1 GB volume: Linear Hub refuses an upload that would leave less than a tenth of the disk free (507 with
  a plain message), but one 800 MB video would still nearly fill it. Before uploading videos there, grow the volume
  (e.g. 10 GB), or use YouTube (unlisted), Vimeo or Google Drive links instead. On the MacBook the reserve is 500 MB.
- **Lead merge note (app.ts, foundation-owned): applied in the last fix round.** The blanket bump in `server/src/app.ts`
  skips progress reports (`isVideoProgressReport`), so people watching no longer keep the cached dashboards and team
  views cold. The team view's in-progress dots lag by up to the cache's 20 s, and "watched" shows at once (the route
  clears the cache itself). `videos-trust.test.ts` expects 0 and 1 bumps.
- **A short video:** a viewing starts with 40 s of credit, so a video up to about 44 s long can still be ticked off by
  one report. Watching is measured by the browser; this only stops one request from claiming a longer video.
- YouTube plays from youtube-nocookie.com (no YouTube cookies until someone presses play) and Vimeo with Do Not Track.
  Uploaded videos are served only to signed-in staff in the video's audience, never cached by the browser.
