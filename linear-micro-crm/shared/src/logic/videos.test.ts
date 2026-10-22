/**
 * P5 learning-videos: links and embeds, audiences, watched ranges (worked by hand), lengths, player messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_LIMITS } from '../types/videos.ts';
import {
  VIDEO_WATCH_CREDIT_MAX_S,
  VIDEO_WATCH_RATE,
  breakWatchSession,
  createWatchSession,
  creditedWatchSeconds,
  embedListenMessages,
  formatVideoLength,
  isVideoComplete,
  normaliseVideoUrl,
  mergeWatchedRanges,
  normaliseWatchedRanges,
  parseEmbedMessage,
  parseTimeParam,
  parseVideoLength,
  parseVideoLink,
  recordWatchSample,
  videoAudiencesFor,
  videoEmbedUrl,
  videoLengthLabel,
  videoLinkKey,
  videoProviderOf,
  videoRequiredFor,
  videoResumeAt,
  videoThumbnailUrl,
  videoVisibleTo,
  watchCreditAt,
  VIDEO_WATCH_CREDIT_START_S,
  VIDEO_WATCH_SESSION_GAP_S,
  watchedRangesSeconds,
  watchSessionRanges,
} from './videos.ts';

test('YouTube links in every common form become one nocookie embed', () => {
  const id = 'eIho2S0ZahI';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&feature=share`,
    `https://m.youtube.com/watch?v=${id}`,
    `youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) {
    assert.equal(videoEmbedUrl(url), `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1&modestbranding=1`, url);
    assert.equal(videoProviderOf(url), 'youtube', url);
    assert.equal(videoLinkKey(url), `youtube:${id}`, url);
  }
  assert.equal(videoThumbnailUrl(`https://youtu.be/${id}`), `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
});

test('YouTube start times and the tracking options', () => {
  assert.equal(parseVideoLink('https://youtu.be/eIho2S0ZahI?t=90')?.startS, 90);
  assert.equal(parseVideoLink('https://www.youtube.com/watch?v=eIho2S0ZahI&t=1m30s')?.startS, 90);
  assert.equal(parseVideoLink('https://www.youtube.com/watch?v=eIho2S0ZahI&t=0')?.startS, undefined);
  // the link's own start, unless the page asks for another one (resume); the origin turns the progress messages on
  assert.equal(
    videoEmbedUrl('https://youtu.be/eIho2S0ZahI?t=90'),
    'https://www.youtube-nocookie.com/embed/eIho2S0ZahI?rel=0&playsinline=1&modestbranding=1&start=90',
  );
  assert.equal(
    videoEmbedUrl('https://youtu.be/eIho2S0ZahI?t=90', { startS: 125.7, origin: 'https://hub.example' }),
    'https://www.youtube-nocookie.com/embed/eIho2S0ZahI?rel=0&playsinline=1&modestbranding=1&enablejsapi=1&origin=https%3A%2F%2Fhub.example&start=125',
  );
});

test('Vimeo links, unlisted hashes and start times', () => {
  assert.equal(videoEmbedUrl('https://vimeo.com/76979871'), 'https://player.vimeo.com/video/76979871?dnt=1');
  assert.equal(videoEmbedUrl('https://vimeo.com/76979871/8a1b2c3d4e'), 'https://player.vimeo.com/video/76979871?dnt=1&h=8a1b2c3d4e');
  assert.equal(videoEmbedUrl('https://player.vimeo.com/video/76979871?h=8a1b2c3d4e&badge=0'), 'https://player.vimeo.com/video/76979871?dnt=1&h=8a1b2c3d4e');
  assert.equal(videoEmbedUrl('https://vimeo.com/channels/staffpicks/76979871'), 'https://player.vimeo.com/video/76979871?dnt=1');
  assert.equal(videoEmbedUrl('https://vimeo.com/showcase/123456/video/76979871'), 'https://player.vimeo.com/video/76979871?dnt=1');
  assert.equal(videoEmbedUrl('https://vimeo.com/76979871#t=2m5s'), 'https://player.vimeo.com/video/76979871?dnt=1#t=125s');
  assert.equal(videoEmbedUrl('https://vimeo.com/76979871', { startS: 61 }), 'https://player.vimeo.com/video/76979871?dnt=1#t=61s');
  assert.equal(videoThumbnailUrl('https://vimeo.com/76979871'), null, 'Vimeo has no public still URL');
});

test('Google Drive file links play from the preview page', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const url of [
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/file/d/${id}/view`,
    `https://drive.google.com/file/d/${id}`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?id=${id}&export=download`,
  ]) {
    assert.equal(videoEmbedUrl(url), `https://drive.google.com/file/d/${id}/preview`, url);
  }
  assert.equal(videoEmbedUrl(`https://drive.google.com/file/d/${id}/view?resourcekey=0-abcDEF`), `https://drive.google.com/file/d/${id}/preview?resourcekey=0-abcDEF`);
  assert.equal(videoEmbedUrl(`https://drive.google.com/file/d/${id}/view`, { startS: 30, origin: 'https://x' }), `https://drive.google.com/file/d/${id}/preview`, 'Drive ignores both');
});

test('anything else is not a video link', () => {
  for (const url of [
    '',
    'not a link',
    'https://example.com/video.mp4',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@ted',
    'javascript:alert(1)',
    'ftp://youtu.be/eIho2S0ZahI',
    'https://user:pass@youtu.be/eIho2S0ZahI',
    'https://youtu.be.evil.example/eIho2S0ZahI',
    'https://vimeo.com/channels/staffpicks',
    'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'https://drive.google.com/file/d/short/view',
    `https://youtu.be/eIho2S0ZahI?x=${'a'.repeat(VIDEO_LIMITS.urlMax)}`,
  ]) {
    assert.equal(videoEmbedUrl(url), null, url);
    assert.equal(videoProviderOf(url), null, url);
  }
});

test('links are stored with their scheme, so they open as links', () => {
  assert.equal(normaliseVideoUrl('youtube.com/watch?v=eIho2S0ZahI'), 'https://youtube.com/watch?v=eIho2S0ZahI');
  assert.equal(normaliseVideoUrl('  https://vimeo.com/76979871  '), 'https://vimeo.com/76979871');
  assert.equal(normaliseVideoUrl('http://youtu.be/eIho2S0ZahI'), 'http://youtu.be/eIho2S0ZahI');
  assert.equal(normaliseVideoUrl('https://example.com/x.mp4'), null);
});

test('parseTimeParam', () => {
  assert.equal(parseTimeParam('90'), 90);
  assert.equal(parseTimeParam('90s'), 90);
  assert.equal(parseTimeParam('1m30s'), 90);
  assert.equal(parseTimeParam('1h2m3s'), 3723);
  assert.equal(parseTimeParam('2m'), 120);
  assert.equal(parseTimeParam('abc'), null);
  assert.equal(parseTimeParam(''), null);
  assert.equal(parseTimeParam(null), null);
});

test('audiences: who sees a video, and whom a required one is required for', () => {
  assert.deepEqual(videoAudiencesFor('admin'), ['everyone', 'leaders', 'reps']);
  assert.deepEqual(videoAudiencesFor('leader'), ['everyone', 'leaders', 'reps']);
  assert.deepEqual(videoAudiencesFor('rep'), ['everyone', 'reps']);
  assert.deepEqual(videoAudiencesFor('recruiter'), ['everyone']);
  assert.deepEqual(videoAudiencesFor('client'), [], 'a client portal account sees no video');
  assert.equal(videoVisibleTo('leaders', 'rep'), false);
  assert.equal(videoVisibleTo('reps', 'leader'), true, 'leaders coach reps');
  assert.equal(videoVisibleTo('everyone', 'client'), false);

  const everyone = { required: true, audience: 'everyone' as const };
  const leaders = { required: true, audience: 'leaders' as const };
  const reps = { required: true, audience: 'reps' as const };
  assert.deepEqual((['admin', 'leader', 'recruiter', 'rep', 'client'] as const).map((r) => videoRequiredFor(everyone, r)), [true, true, true, true, false]);
  assert.deepEqual((['admin', 'leader', 'recruiter', 'rep'] as const).map((r) => videoRequiredFor(leaders, r)), [false, true, false, false]);
  assert.deepEqual((['admin', 'leader', 'recruiter', 'rep'] as const).map((r) => videoRequiredFor(reps, r)), [false, false, false, true]);
  assert.equal(videoRequiredFor({ required: false, audience: 'everyone' }, 'rep'), false);
});

test('watched ranges: overlaps and touching ranges join, gaps stay, everything is clamped and rounded', () => {
  // [10.4, 20] and [15, 30.6] overlap → [10, 31]; [31.8, 40] starts 0.8 s later → joined → [10, 40]; [50, 60] is apart.
  assert.deepEqual(normaliseWatchedRanges([[50, 60], [15, 30.6], [10.4, 20], [31.8, 40]]), [[10, 40], [50, 60]]);
  assert.equal(watchedRangesSeconds([[10, 40], [50, 60]]), 40);
  // backwards pairs are turned round, empty and invalid ones dropped, and the length caps the end
  assert.deepEqual(normaliseWatchedRanges([[30, 20], [5, 5], [-10, 3], [Number.NaN, 4], [580, 700]], 598), [[0, 3], [20, 30], [580, 598]]);
  // the same minute watched twice counts once
  const twice = mergeWatchedRanges([[0, 60]], [[0, 60]]);
  assert.deepEqual(twice, [[0, 60]]);
  assert.equal(watchedRangesSeconds(twice), 60);
  // seen before 0–120 and 300–360; now 100–310 → one range 0–360 = 360 s
  const merged = mergeWatchedRanges([[0, 120], [300, 360]], [[100, 310]], 598);
  assert.deepEqual(merged, [[0, 360]]);
  assert.equal(watchedRangesSeconds(merged), 360);
});

test('watched ranges: beyond the cap the two closest ranges are joined', () => {
  // gaps: 10–20 is 10 s, 25–28 is 3 s, 30–60 is 30 s → with room for 3, the 3 s gap goes first
  assert.deepEqual(normaliseWatchedRanges([[0, 10], [20, 25], [28, 30], [60, 70]], 1000, 3), [[0, 10], [20, 30], [60, 70]]);
  // with room for 2: then the 10 s gap → [0, 30]
  assert.deepEqual(normaliseWatchedRanges([[0, 10], [20, 25], [28, 30], [60, 70]], 1000, 2), [[0, 30], [60, 70]]);
  assert.deepEqual(normaliseWatchedRanges([[0, 10], [20, 25], [28, 30], [60, 70]], 1000, 1), [[0, 70]]);
});

test('watched at 90 % of the length, worked by hand: 598 s × 0.9 = 538.2 s', () => {
  // 598 × 0.9 = 538.2 → 538 s is short, 539 s counts
  assert.equal(isVideoComplete(538, 598), false);
  assert.equal(isVideoComplete(539, 598), true);
  assert.equal(isVideoComplete(10_000, null), false, 'unknown length: never by time alone');
  assert.equal(isVideoComplete(10, 0), false);
});

test('watch credit, worked by hand: double speed from a two-minute credit; waiting refills it, never past two minutes', () => {
  assert.equal(VIDEO_WATCH_RATE, 2);
  assert.equal(VIDEO_WATCH_CREDIT_MAX_S, 120);
  assert.equal(VIDEO_WATCH_CREDIT_START_S, 40);
  assert.equal(VIDEO_WATCH_SESSION_GAP_S, 600);
  // a first report starts a viewing with 40 s (re-review fix: it was the full 120 s)
  assert.equal(watchCreditAt(null, 1_000_000), 40);
  // 30 s left, 15 s later: 30 + 2 × 15 = 60 s
  assert.equal(watchCreditAt({ creditS: 30, atMs: 1_000_000 }, 1_015_000), 60);
  // 0 left, 5 minutes later: capped at 120 s (waiting never saves up more)
  assert.equal(watchCreditAt({ creditS: 0, atMs: 0 }, 300_000), 120);
  // 0 left, an hour later: a new viewing, 40 s again (a credit is never banked between viewings)
  assert.equal(watchCreditAt({ creditS: 0, atMs: 0 }, 3_600_000), 40);
  // a clock set back: nothing added, nothing taken
  assert.equal(watchCreditAt({ creditS: 40, atMs: 2_000_000 }, 1_000_000), 40);
  // 100 counted, the report claims 600, 120 s of credit: 220 counted, 0 left
  assert.deepEqual(creditedWatchSeconds(100, 600, 120), { watchedS: 220, creditS: 0 });
  // claims 15 s more with 60 s of credit: all of it, 45 left
  assert.deepEqual(creditedWatchSeconds(100, 115, 60), { watchedS: 115, creditS: 45 });
  // a claim below what was counted: nothing lost, no credit spent
  assert.deepEqual(creditedWatchSeconds(100, 40, 60), { watchedS: 100, creditS: 60 });
  // whole seconds only: 30.5 s of credit adds 30
  assert.deepEqual(creditedWatchSeconds(0, 50, 30.5), { watchedS: 30, creditS: 0.5 });
});

test('watch credit: honest viewers never run short; a report every 100 ms gains no more than double speed', () => {
  // normal speed, a report every 15 s for 10 minutes: every second counted
  let credit: { creditS: number; atMs: number } | null = null;
  let watched = 0;
  for (let t = 15; t <= 600; t += 15) {
    const c = watchCreditAt(credit, t * 1000);
    const r = creditedWatchSeconds(watched, t, c);
    watched = r.watchedS;
    credit = { creditS: r.creditS, atMs: t * 1000 };
  }
  assert.equal(watched, 600);
  // double speed: 30 s of video per 15 s report, 600 s in 300 s of clock
  credit = null;
  watched = 0;
  for (let t = 15; t <= 300; t += 15) {
    const r = creditedWatchSeconds(watched, t * 2, watchCreditAt(credit, t * 1000));
    watched = r.watchedS;
    credit = { creditS: r.creditS, atMs: t * 1000 };
  }
  assert.equal(watched, 600);
  // someone claiming the whole 600 s every 100 ms for 60 s: 40 s at the start + 2 × 60 s = 160 s, not 600
  credit = null;
  watched = 0;
  for (let ms = 0; ms <= 60_000; ms += 100) {
    const r = creditedWatchSeconds(watched, 600, watchCreditAt(credit, ms));
    watched = r.watchedS;
    credit = { creditS: r.creditS, atMs: ms };
  }
  assert.ok(watched <= 160 && watched >= 158, String(watched));
});

test('the player session: playing extends a range, a seek starts a new one, skipping ahead counts nothing', () => {
  let s = createWatchSession();
  for (const t of [0, 0.25, 0.5, 1, 2, 3, 10]) s = recordWatchSample(s, t);
  // 0 → 3 is playing; 3 → 10 is a 7 s jump (a seek), so 10 opens a new (still empty) range
  assert.deepEqual(watchSessionRanges(s), [[0, 3]]);
  for (const t of [11, 12, 13]) s = recordWatchSample(s, t);
  assert.deepEqual(watchSessionRanges(s), [[0, 3], [10, 13]]);
  // seeking back to 1 and playing to 5 overlaps 0–3: merged as 0–5
  s = breakWatchSession(s);
  for (const t of [1, 2, 3, 4, 5]) s = recordWatchSample(s, t);
  assert.deepEqual(watchSessionRanges(s), [[0, 5], [10, 13]]);
  assert.equal(watchedRangesSeconds(watchSessionRanges(s)), 8);
  // double speed with a late sample (a 4 s step) is still playing
  s = recordWatchSample(createWatchSession(), 100);
  s = recordWatchSample(s, 104);
  assert.deepEqual(watchSessionRanges(s), [[100, 104]]);
  // garbage never changes anything
  assert.equal(recordWatchSample(s, Number.NaN), s);
  assert.equal(recordWatchSample(s, -1), s);
});

test('resume: the saved position, except near the start, near the end, or once watched', () => {
  assert.equal(videoResumeAt({ positionS: 192.6, completedAt: null }, 598), 192);
  assert.equal(videoResumeAt({ positionS: 3, completedAt: null }, 598), 0);
  assert.equal(videoResumeAt({ positionS: 590, completedAt: null }, 598), 0);
  assert.equal(videoResumeAt({ positionS: 300, completedAt: '2026-10-20T10:00:00' }, 598), 0);
  assert.equal(videoResumeAt(null, 598), 0);
  assert.equal(videoResumeAt({ positionS: 400, completedAt: null }, null), 400);
});

test('lengths as words and from words', () => {
  assert.equal(formatVideoLength(598), '9:58');
  assert.equal(formatVideoLength(3723), '1:02:03');
  assert.equal(formatVideoLength(0), '0:00');
  assert.equal(formatVideoLength(null), '0:00');
  assert.equal(videoLengthLabel(45), '45 s');
  assert.equal(videoLengthLabel(598), '10 min');
  assert.equal(videoLengthLabel(1263), '21 min');
  assert.equal(videoLengthLabel(3600), '1 h');
  assert.equal(videoLengthLabel(3900), '1 h 5 min');
  assert.equal(parseVideoLength('9:58'), 598);
  assert.equal(parseVideoLength('1:02:03'), 3723);
  assert.equal(parseVideoLength('18'), 1080, 'whole minutes');
  assert.equal(parseVideoLength(' '), null);
  assert.ok(Number.isNaN(parseVideoLength('9:75')));
  assert.ok(Number.isNaN(parseVideoLength('1:75:00')));
  assert.ok(Number.isNaN(parseVideoLength('0')));
  assert.ok(Number.isNaN(parseVideoLength('7:00:01')), 'over six hours');
  assert.ok(Number.isNaN(parseVideoLength('ten minutes')));
});

test('YouTube player messages', () => {
  assert.deepEqual(JSON.parse(embedListenMessages('youtube', 7)[0]!), { event: 'listening', id: 7, channel: 'widget' });
  assert.deepEqual(parseEmbedMessage('youtube', '{"event":"onReady","id":1}'), { ready: true });
  assert.deepEqual(
    parseEmbedMessage('youtube', JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5, playerState: 1, duration: 598.1 } })),
    { currentTime: 12.5, duration: 598.1, state: 'playing' },
  );
  assert.deepEqual(parseEmbedMessage('youtube', { event: 'infoDelivery', info: { playerState: 0 } }), { state: 'ended' });
  assert.deepEqual(parseEmbedMessage('youtube', { event: 'onStateChange', info: 2 }), { state: 'paused' });
  assert.equal(parseEmbedMessage('youtube', { event: 'infoDelivery', info: { volume: 100 } }), null, 'nothing we use');
  assert.equal(parseEmbedMessage('youtube', 'not json'), null);
  assert.equal(parseEmbedMessage('youtube', { event: 'infoDelivery', info: { currentTime: -4 } }), null);
});

test('Vimeo player messages', () => {
  assert.deepEqual(embedListenMessages('vimeo').map((m) => JSON.parse(m).value), ['ready', 'play', 'pause', 'ended', 'timeupdate', 'seeked']);
  assert.deepEqual(parseEmbedMessage('vimeo', '{"event":"ready","player_id":"x"}'), { ready: true });
  assert.deepEqual(parseEmbedMessage('vimeo', { event: 'timeupdate', data: { seconds: 61.2, percent: 0.1, duration: 612 } }), { currentTime: 61.2, duration: 612 });
  assert.deepEqual(parseEmbedMessage('vimeo', { event: 'pause', data: { seconds: 70 } }), { currentTime: 70, state: 'paused' });
  assert.deepEqual(parseEmbedMessage('vimeo', { event: 'ended', data: {} }), { state: 'ended' });
  assert.equal(parseEmbedMessage('vimeo', { method: 'getVolume', value: 1 }), null);
  assert.equal(parseEmbedMessage('vimeo', 42), null);
});
