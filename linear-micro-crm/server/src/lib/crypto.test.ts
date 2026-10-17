import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decrypt, encrypt } from './crypto.ts';

describe('crypto (AES-256-GCM at rest)', () => {
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
