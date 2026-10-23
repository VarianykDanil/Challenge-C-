import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_APP_SECRET_FILE, appSecretFile, configureAppSecret, decrypt, encrypt } from './crypto.ts';

describe('crypto (AES-256-GCM at rest)', () => {
  // Release 1.3.1 fix: the generated key goes to a temporary folder, so npm test never reads the owner's
  // server/data/app-secret, nor creates one in a fresh clone that a later npm start would then use.
  let dir = '';
  let previousFile = '';
  before(() => {
    previousFile = appSecretFile();
    dir = mkdtempSync(path.join(os.tmpdir(), 'linear-crypto-test-'));
    configureAppSecret(path.join(dir, 'app-secret'));
  });
  after(() => {
    configureAppSecret(previousFile);
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses a key file in a temporary folder, never server/data/app-secret (LOGIC §16.0: tests write only to a temp dir)', () => {
    assert.notEqual(appSecretFile(), DEFAULT_APP_SECRET_FILE);
    assert.ok(appSecretFile().startsWith(os.tmpdir()), appSecretFile());
  });

  it('round-trips text and never repeats a ciphertext', () => {
    const a = encrypt('JBSWY3DPEHPK3PXP');
    const b = encrypt('JBSWY3DPEHPK3PXP');
    assert.match(a, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.notEqual(a, b, 'random IV per call');
    assert.equal(decrypt(a), 'JBSWY3DPEHPK3PXP');
    assert.equal(decrypt(b), 'JBSWY3DPEHPK3PXP');
    assert.equal(decrypt(encrypt('')), '');
  });

  it('is bound to LM_APP_SECRET and detects tampering', () => {
    const previous = process.env.LM_APP_SECRET;
    try {
      process.env.LM_APP_SECRET = 'first-secret';
      const payload = encrypt('hello');
      process.env.LM_APP_SECRET = 'second-secret';
      assert.throws(() => decrypt(payload));
      process.env.LM_APP_SECRET = 'first-secret';
      assert.equal(decrypt(payload), 'hello');
      const [v, iv, tag, ct] = payload.split(':') as [string, string, string, string];
      const flipped = Buffer.from(ct, 'base64');
      flipped[0] = flipped[0]! ^ 0xff;
      assert.throws(() => decrypt(`${v}:${iv}:${tag}:${flipped.toString('base64')}`));
      assert.throws(() => decrypt('v0:a:b:c'), /Unsupported/);
      assert.throws(() => decrypt('nonsense'), /Unsupported/);
    } finally {
      if (previous === undefined) delete process.env.LM_APP_SECRET;
      else process.env.LM_APP_SECRET = previous;
    }
  });
});
