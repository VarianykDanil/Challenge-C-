import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, generateSecret, hotp, normaliseCode, otpauthUrl, totp, verifyTotp } from './totp.ts';

/** The RFC 4226 / RFC 6238 reference secret (ASCII "12345678901234567890"). */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET); // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ

describe('base32', () => {
  it('encodes the RFC 4648 test vectors without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, expected] of vectors) assert.equal(base32Encode(Buffer.from(plain, 'ascii')), expected);
  });

  it('decodes padded, lower-case and spaced input', () => {
    assert.equal(base32Decode('MZXW6YTBOI======').toString('ascii'), 'foobar');
    assert.equal(base32Decode('mzxw 6ytb-oi').toString('ascii'), 'foobar');
    assert.equal(base32Decode(RFC_SECRET_B32).toString('ascii'), '12345678901234567890');
  });

  it('round-trips random byte strings of every length', () => {
    for (let len = 0; len <= 40; len++) {
      for (let n = 0; n < 5; n++) {
        const bytes = randomBytes(len);
        assert.deepEqual(base32Decode(base32Encode(bytes)), Buffer.from(bytes), `length ${len}`);
      }
    }
  });

  it('rejects characters outside the alphabet', () => {
    assert.throws(() => base32Decode('MZXW6YTB0I'), /Invalid base32/); // zero is not in the alphabet
    assert.throws(() => base32Decode('MZXW!'), /Invalid base32/);
  });

  it('generateSecret gives 20 random bytes as 32 base32 characters', () => {
    const a = generateSecret();
    const b = generateSecret();
    assert.match(a, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(a).length, 20);
    assert.notEqual(a, b);
  });
});

describe('hotp (RFC 4226 appendix D)', () => {
  it('matches the ten reference values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code, `counter ${counter}`));
  });

  it('supports 8 digits and bigint counters', () => {
    assert.equal(hotp(RFC_SECRET, 1n, 8), '94287082');
  });
});

describe('totp (RFC 6238 appendix B, SHA-1)', () => {
  const vectors: [number, string, string][] = [
    // [unix seconds, 8-digit reference, 6-digit truncation]
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];

  it('produces the reference 8-digit codes', () => {
    for (const [t, eight] of vectors) assert.equal(totp(RFC_SECRET, { timeMs: t * 1000, digits: 8 }), eight, `T=${t}`);
  });

  it('produces the 6-digit truncations from a base32 secret', () => {
    for (const [t, , six] of vectors) assert.equal(totp(RFC_SECRET_B32, { timeMs: t * 1000 }), six, `T=${t}`);
  });

  it('is stable inside a step and changes at the boundary', () => {
    assert.equal(totp(RFC_SECRET, { timeMs: 59_000 }), totp(RFC_SECRET, { timeMs: 30_000 }));
    assert.notEqual(totp(RFC_SECRET, { timeMs: 59_000 }), totp(RFC_SECRET, { timeMs: 60_000 }));
  });
});

describe('verifyTotp', () => {
  const now = 1234567890 * 1000;

  it('accepts the current code and the neighbouring steps, rejects two steps away', () => {
    const current = totp(RFC_SECRET_B32, { timeMs: now });
    const previous = totp(RFC_SECRET_B32, { timeMs: now - 30_000 });
    const next = totp(RFC_SECRET_B32, { timeMs: now + 30_000 });
    const far = totp(RFC_SECRET_B32, { timeMs: now + 60_000 });
    assert.equal(verifyTotp(RFC_SECRET_B32, current, { timeMs: now }), true);
    assert.equal(verifyTotp(RFC_SECRET_B32, previous, { timeMs: now }), true);
    assert.equal(verifyTotp(RFC_SECRET_B32, next, { timeMs: now }), true);
    assert.equal(verifyTotp(RFC_SECRET_B32, far, { timeMs: now }), false);
    assert.equal(verifyTotp(RFC_SECRET_B32, far, { timeMs: now, window: 2 }), true);
  });

  it('tolerates spaces in the typed code and rejects malformed input', () => {
    const current = totp(RFC_SECRET_B32, { timeMs: now });
    assert.equal(verifyTotp(RFC_SECRET_B32, `${current.slice(0, 3)} ${current.slice(3)}`, { timeMs: now }), true);
    assert.equal(verifyTotp(RFC_SECRET_B32, '', { timeMs: now }), false);
    assert.equal(verifyTotp(RFC_SECRET_B32, '12345', { timeMs: now }), false);
    assert.equal(verifyTotp(RFC_SECRET_B32, 'abcdef', { timeMs: now }), false);
    assert.equal(verifyTotp(RFC_SECRET_B32, `${current}7`, { timeMs: now }), false);
  });

  it('rejects codes from another secret', () => {
    const other = generateSecret();
    assert.equal(verifyTotp(other, totp(RFC_SECRET_B32, { timeMs: now }), { timeMs: now }), false);
  });

  it('normaliseCode keeps only well-formed six-digit codes', () => {
    assert.equal(normaliseCode(' 123 456 '), '123456');
    assert.equal(normaliseCode('12345'), null);
    assert.equal(normaliseCode('1234567'), null);
    assert.equal(normaliseCode('12a456'), null);
  });
});

describe('otpauthUrl', () => {
  it('builds the key URI authenticator apps expect', () => {
    const url = otpauthUrl({ issuer: 'Linear Hub', label: 'Linear Hub:jane.doe@linear-mcr.co.uk', secret: 'JBSWY3DPEHPK3PXP' });
    assert.equal(url, 'otpauth://totp/Linear%20Hub:jane.doe%40linear-mcr.co.uk?secret=JBSWY3DPEHPK3PXP&issuer=Linear%20Hub&algorithm=SHA1&digits=6&period=30');
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'otpauth:');
    assert.equal(parsed.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
    assert.equal(parsed.searchParams.get('issuer'), 'Linear Hub');
  });
});
