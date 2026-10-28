// The documents Linear MCR reads must stay true: who built Linear Hub, what the offer is, how it goes online, and
// what the maintainers' guide points at. Also runs the VPS installer's own checks (deploy/tests/run.sh) on Linux, so
// a change that breaks the installer fails `npm test` like any other bug.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..'); // linear-micro-crm/
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

/** People who never existed: earlier versions of the docs and the About page named them as the team. */
const INVENTED_TEAM = ['Tomasz Nowak', 'Aisha Rahman', 'Callum Reid', 'Mei-Ling Chen', 'Sophie Whitfield'];
/** Files that say who built Linear Hub. (README.md joins this list once its "Built by" section is replaced.) */
const SAYS_WHO_BUILT_IT = [
  'docs/TEAM.md',
  'docs/TEAM_CONTRACT.md',
  'docs/PITCH.md',
  'docs/MAINTAINERS.md',
  'client/src/content/team.ts',
  'client/src/content/copy.ts',
  'client/src/pages/About.tsx',
];

/** A markdown section: from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && heading.test(l));
  assert.ok(start >= 0, `no heading matching ${heading}`);
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l) && l.match(/^#+/)![0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('who built it', () => {
  it('names no invented people', () => {
    for (const file of SAYS_WHO_BUILT_IT) {
      const text = read(file);
      for (const name of INVENTED_TEAM) assert.ok(!text.includes(name), `${file} still names ${name}`);
      assert.ok(!/\bsquad\b/i.test(text), `${file} still talks about a squad`);
    }
  });

  it('says it was built by one developer at Noryn System Ltd with AI coding agents, tests and reviews', () => {
    const team = read('docs/TEAM.md');
    assert.match(team, /Noryn System Ltd/);
    assert.match(team, /One developer/i);
    assert.match(team, /AI coding agents/);
    assert.match(team, /tests/i);
    assert.match(team, /review/i);
    assert.ok(!/14-day/.test(team), 'sessions end 14 hours after signing in, not 14 days');
  });
});

describe('the licence', () => {
  it('is a proprietary notice: Noryn System Ltd owns it, Linear MCR Limited is licensed under the agreement, nobody else', () => {
    assert.ok(existsSync(path.join(root, 'LICENSE')), 'linear-micro-crm/LICENSE is missing');
    const licence = read('LICENSE');
    assert.match(licence, /Copyright \(c\) \d{4} Noryn System Ltd/);
    assert.match(licence, /licenses the Software to Linear MCR Limited under the written agreement/);
    assert.match(licence, /No other person or organisation is granted any right/);
  });
});

describe('the pitch', () => {
  const pitch = () => read('docs/PITCH.md');

  it('drops the claims that stopped being true', () => {
    const text = pitch();
    for (const stale of [/nothing to subscribe/i, /no external services/i, /no data sent anywhere/i, /fourteen days/i, /v1\.1\.0/, /no password/i]) {
      assert.ok(!stale.test(text), `PITCH.md still says ${stale}`);
    }
  });

  it('describes the actual offer: a licence with a monthly service, the outside services, HTTPS hosting and 14-hour sessions', () => {
    const text = pitch();
    assert.match(text, /licensed system with a monthly service/i);
    for (const service of ['Revolut', 'Wise', 'TrueLayer', 'Gmail']) assert.match(text, new RegExp(service));
    assert.match(text, /HTTPS/);
    assert.match(text, /14 hours after signing in/);
  });
});

describe('the owner notes for 1.3', () => {
  it('hold no notes between the people (or agents) who built it', () => {
    const text = read('docs/OWNER_NOTES_1.3.md');
    for (const internal of [/For the lead/i, /\bP[1-9]\b/, /integration-trial/i, /\bflake\b/i, /other packages/i, /\bagent/i]) {
      assert.ok(!internal.test(text), `OWNER_NOTES_1.3.md still has an internal note matching ${internal}`);
    }
  });
});

describe('going online', () => {
  it('ROADMAP: the next step is a small server with Caddy and HTTPS; a different database is only a later option, with the reason', () => {
    const roadmap = read('docs/ROADMAP.md');
    const now = section(roadmap, /^## Now/);
    assert.match(now, /Caddy/);
    assert.match(now, /HTTPS/);
    assert.match(now, /SQLite stays/);
    assert.ok(!/Supabase|Postgres/i.test(now), 'Supabase/Postgres must not be a "Now" item');
    assert.ok(!/Supabase|Postgres/i.test(section(roadmap, /^## Next/)), 'Supabase/Postgres must not be a "Next" item');
    const later = section(roadmap, /^## Later/);
    assert.match(later, /Postgres/);
    assert.match(later, /several offices/);
    assert.match(later, /Not needed for going online/);
  });

  // The signed agreement covers Linear Hub on the office Mac. Going online is outside it (Schedule 1, Part 2, 2.1(a)),
  // and clause 9.3 says Schedules 3 and 4 are varied under clause 26.2 when it happens. The pitch and the runbook must
  // not present the server, or looking after it, as already part of the deal.
  it('PITCH and DEPLOY: going online is quoted separately and needs a signed variation of the agreement first', () => {
    const pitch = read('docs/PITCH.md');
    const deploy = read('docs/DEPLOY.md');
    for (const [name, text] of [['PITCH.md', pitch], ['DEPLOY.md', deploy]] as const) {
      assert.match(text, /variation/i, `${name} does not say the agreement is varied`);
      assert.match(text, /clause 26\.2/, `${name} does not name clause 26.2 (variation)`);
      assert.match(text, /clause 9\.3/, `${name} does not name clause 9.3 (going online)`);
      assert.match(text, /Schedules? 3 and 4/, `${name} does not say Schedules 3 and 4 change`);
      assert.match(text, /fixed[- ]price/i, `${name} does not say the go-live is quoted at a fixed price`);
    }
    // Any promise to look after the server (or its off-site copies) is tied to the variation.
    for (const sentence of pitch.split(/(?<=\.)\s+/)) {
      if (/looking after the server|looks after the server/i.test(sentence)) {
        assert.match(sentence, /once the agreement is varied|variation/i, `PITCH.md promises server care outside the agreement: "${sentence.trim()}"`);
      }
    }
    const buy = section(deploy, /^## 1\. /);
    assert.match(buy, /variation/i, 'DEPLOY.md §1 (what to buy) must start from the agreement variation');
    assert.match(section(deploy, /^## 4\. Go-live checklist/), /variation/i, 'the go-live checklist must tick off the signed variation');
    assert.match(section(pitch, /^## Rollout plan/), /variation/i, 'the rollout plan must put the variation before go-live day');
  });

  it('DEPLOY: the runbook is built on the installer, uses the shared setting names, and marks the Mac as trial only', () => {
    const deploy = read('docs/DEPLOY.md');
    for (const must of ['deploy/install.sh', 'HOST=127.0.0.1', 'TRUST_PROXY=1', 'COOKIE_SECURE=1', 'LM_APP_SECRET_FILE',
      'LM_OFFSITE_DIR', 'LM_BACKUP_PASSPHRASE_FILE', 'LM_TLS_CERT_FILE', 'LM_TLS_KEY_FILE', 'npm run golive',
      'recovery sheet', 'restore-test', '/api/health', 'PAY FOR REAL']) {
      assert.ok(deploy.includes(must), `DEPLOY.md does not mention ${must}`);
    }
    assert.match(section(deploy, /Trial only/), /For the trial week only/);
  });
});

describe('links and paths in the docs', () => {
  const DOCS = ['docs/TEAM.md', 'docs/PITCH.md', 'docs/ROADMAP.md', 'docs/DEPLOY.md', 'docs/MAINTAINERS.md', 'docs/TEAM_CONTRACT.md', 'docs/OWNER_NOTES_1.3.md'];

  it('every relative link points at a file that exists', () => {
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z]+:/i.test(target)) continue; // https:, mailto:
        assert.ok(existsSync(path.resolve(root, path.dirname(doc), target)), `${doc} links to ${target}, which does not exist`);
      }
    }
  });

  it('every file path the maintainers’ guide names exists', () => {
    // A path in backticks with a folder and an extension; placeholders (<area>) and globs are skipped. Paths are read
    // from the app folder, or from server/src, shared/src or client/src for the short forms (lib/…, routes/…).
    const bases = ['', 'server/src', 'server/src/lib', 'shared/src', 'client/src', 'docs'];
    // Added in the same release by the sign-in work, which is merged with this one; drop it from here once merged.
    const comingInThisRelease = new Set(['server/src/lib/secureRequest.ts']);
    const missing: string[] = [];
    for (const m of read('docs/MAINTAINERS.md').matchAll(/`([A-Za-z0-9_./-]+\/[A-Za-z0-9_.-]+\.(?:ts|tsx|md|json|sh|css|mjs))`/g)) {
      const p = m[1]!;
      if (comingInThisRelease.has(p)) continue;
      if (!bases.some((b) => existsSync(path.join(root, b, p)))) missing.push(p);
    }
    assert.deepEqual(missing, [], `MAINTAINERS.md names files that do not exist: ${missing.join(', ')}`);
  });
});

describe('the VPS installer', () => {
  const bashMajor = Number(spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).stdout.trim() || 0);
  // The installer is for Ubuntu; its checks use GNU tools and bash 4+ (macOS ships bash 3.2 and BSD stat).
  const skip = process.platform !== 'linux' || bashMajor < 4 ? 'needs Linux with bash 4 or newer' : false;

  it('passes deploy/tests/run.sh (shellcheck when installed, the helpers, and a full dry run)', { skip }, () => {
    const r = spawnSync('bash', [path.join(root, 'deploy/tests/run.sh')], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `deploy/tests/run.sh failed:\n${r.stdout.split('\n').filter((l) => /FAIL|passed/.test(l)).join('\n')}\n${r.stderr}`);
    assert.match(r.stdout, /\d+ passed, 0 failed/);
  });
});
