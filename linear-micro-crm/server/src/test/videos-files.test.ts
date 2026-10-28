/**
 * P5 learning-videos: the file helpers, worked by hand — HTTP Range offsets, the container check of an upload's first
 * bytes, an MP4 / MOV's own length from its mvhd box, the stored-path guard and the tidy-up of unfinished uploads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.ts';
import {
  configureMediaRoot,
  isJpeg,
  isQuickTime,
  mediaRootFor,
  mp4DurationFrom,
  mp4DurationSeconds,
  parseRangeHeader,
  removeStaleUploads,
  resolveStoredPath,
  sniffVideoContainer,
} from '../lib/videos/files.ts';
import { JPEG_BYTES, box, ftyp, largeBox, mvhdV0, mvhdV1, payload, sampleMp4, sampleWebm } from './videoFixtures.ts';

const reader = (buf: Uint8Array) => (offset: number, length: number) => buf.subarray(offset, Math.min(buf.length, offset + length));
const durationOf = (buf: Buffer) => mp4DurationFrom(reader(buf), buf.length);

test('Range header → inclusive byte offsets of a 1,000-byte file', () => {
  const size = 1000;
  assert.deepEqual(parseRangeHeader(undefined, size), { kind: 'full' });
  assert.deepEqual(parseRangeHeader('bytes=0-99', size), { kind: 'partial', start: 0, end: 99 }, 'the first 100 bytes');
  assert.deepEqual(parseRangeHeader('bytes=0-1', size), { kind: 'partial', start: 0, end: 1 }, "Safari's opening probe");
  assert.deepEqual(parseRangeHeader('bytes=900-', size), { kind: 'partial', start: 900, end: 999 }, 'from 900 to the end');
  assert.deepEqual(parseRangeHeader('bytes=-100', size), { kind: 'partial', start: 900, end: 999 }, 'the last 100 bytes');
  assert.deepEqual(parseRangeHeader('bytes=-5000', size), { kind: 'partial', start: 0, end: 999 }, 'a suffix longer than the file: all of it');
  assert.deepEqual(parseRangeHeader('bytes=500-5000', size), { kind: 'partial', start: 500, end: 999 }, 'an end past the file stops at the end');
  assert.deepEqual(parseRangeHeader('bytes=999-999', size), { kind: 'partial', start: 999, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=1000-', size), { kind: 'unsatisfiable' }, 'starts past the last byte');
  assert.deepEqual(parseRangeHeader('bytes=-0', size), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRangeHeader('bytes=0-', 0), { kind: 'unsatisfiable' }, 'an empty file has no bytes to give');
  // ignored (the whole file): backwards, several ranges, another unit, nothing given, junk
  for (const h of ['bytes=5-1', 'bytes=0-1,5-6', 'items=0-1', 'bytes=', 'bytes=-', 'bytes=a-b', '']) {
    assert.deepEqual(parseRangeHeader(h, size), { kind: 'full' }, h);
  }
});

test('the container check: MP4, MOV and WebM pass whatever they are called; anything else fails', () => {
  const mp4 = sampleMp4();
  const mov = sampleMp4({ brand: 'qt  ' });
  assert.equal(sniffVideoContainer(mp4), 'isobmff');
  assert.equal(isQuickTime(mp4), false);
  assert.equal(sniffVideoContainer(mov), 'isobmff');
  assert.equal(isQuickTime(mov), true);
  assert.equal(sniffVideoContainer(sampleWebm()), 'webm');
  assert.equal(sniffVideoContainer(Buffer.concat([box('mdat', payload(20))])), 'isobmff', 'an old file starting with mdat');
  assert.equal(sniffVideoContainer(Buffer.from('<html><body>not a video</body></html>')), null);
  assert.equal(sniffVideoContainer(Buffer.from([0x00, 0x00, 0x00, 0x04, 0x66, 0x74, 0x79, 0x70])), null, 'a 4-byte box cannot be');
  assert.equal(sniffVideoContainer(Buffer.from([0x1a, 0x45])), null, 'too short to tell');
  assert.equal(isJpeg(JPEG_BYTES), true);
  assert.equal(isJpeg(Buffer.from('GIF89a')), false);
});

test("an MP4's own length from mvhd, worked by hand", () => {
  // 12,345 / 1,000 = 12.345 s → 12
  assert.equal(durationOf(Buffer.concat([ftyp(), box('moov', mvhdV0(1000, 12_345))])), 12);
  // 358,800 / 600 = 598 s exactly, with moov after a 4 KB mdat (a phone file that is not fast-started)
  assert.equal(durationOf(sampleMp4({ timescale: 600, duration: 358_800, moovLast: true })), 598);
  // 359,100 / 600 = 598.5 s → rounds to 599
  assert.equal(durationOf(sampleMp4({ timescale: 600, duration: 359_100 })), 599);
  // a 64-bit mdat before moov, and other boxes inside moov before mvhd
  assert.equal(durationOf(Buffer.concat([ftyp(), largeBox('mdat', payload(100)), box('moov', box('udta', payload(10)), mvhdV0(90_000, 5_400_000))])), 60);
  // version 1: 5,400,000,000 / 90,000 = 60,000 s (a 64-bit duration over 2³²)
  assert.equal(durationOf(Buffer.concat([ftyp(), box('moov', mvhdV1(90_000, 5_400_000_000n))])), 60_000);
  // nothing to read: no moov, a moov without mvhd, an unknown duration, no timescale, a broken box
  assert.equal(durationOf(Buffer.concat([ftyp(), box('mdat', payload(10))])), null);
  assert.equal(durationOf(Buffer.concat([ftyp(), box('moov', box('trak', payload(10)))])), null);
  assert.equal(durationOf(Buffer.concat([ftyp(), box('moov', mvhdV0(1000, 0xffffffff))])), null);
  assert.equal(durationOf(Buffer.concat([ftyp(), box('moov', mvhdV0(0, 1000))])), null);
  const broken = Buffer.concat([ftyp(), box('moov', mvhdV0(1000, 5000))]);
  broken.writeUInt32BE(9999, ftyp().length); // moov claims more bytes than the file has
  assert.equal(durationOf(broken), null);
  assert.equal(durationOf(sampleWebm()), null, 'not ISO base media');
});

test('mp4DurationSeconds reads a file on disk; a missing file is null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-files-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    writeFileSync(file, sampleMp4({ timescale: 1000, duration: 95_000, moovLast: true, mdatBytes: 70_000 }));
    assert.equal(mp4DurationSeconds(file), 95);
    assert.equal(mp4DurationSeconds(path.join(dir, 'nope.mp4')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stored paths: only our own file names, never a way out of the media folder', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-media-'));
  configureMediaRoot(dir);
  const db = openDb(':memory:');
  try {
    assert.equal(mediaRootFor(db), dir);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(resolveStoredPath(db, `videos/${id}.mp4`), path.join(dir, 'videos', `${id}.mp4`));
    assert.equal(resolveStoredPath(db, `videos/${id}.jpg`), path.join(dir, 'videos', `${id}.jpg`));
    for (const bad of ['../app-secret', `videos/../../${id}.mp4`, `videos/${id}.exe`, `/etc/passwd`, `videos/${id}.mp4/..`, '', null, undefined]) {
      assert.equal(resolveStoredPath(db, bad), null, String(bad));
    }
  } finally {
    configureMediaRoot(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database file keeps its media next to it; unfinished uploads older than a day are tidied away', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-p5-db-'));
  const db = openDb(path.join(dir, 'linear.sqlite'));
  try {
    assert.equal(mediaRootFor(db), path.join(dir, 'media'));
    const old = path.join(dir, 'old.upload');
    const fresh = path.join(dir, 'fresh.upload');
    const kept = path.join(dir, 'kept.mp4');
    for (const f of [old, fresh, kept]) writeFileSync(f, 'x');
    // every file time is set on the test's own clock, not left to when the file was written
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    const justNow = Date.now() / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    utimesSync(kept, twoDaysAgo, twoDaysAgo);
    utimesSync(fresh, justNow, justNow);
    assert.equal(removeStaleUploads(dir), 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, 'an upload still arriving stays');
    assert.equal(existsSync(kept), true, 'only *.upload files');
    assert.equal(removeStaleUploads(path.join(dir, 'no-such-folder')), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
