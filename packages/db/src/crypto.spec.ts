import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  isPlaceholderSecret,
  loadEncryptionKey,
  secretAad,
  secretLast4,
  SecretCryptoError,
} from './crypto';

/**
 * Seam A. This is the first symmetric crypto in the repo, and the property that
 * matters most is not "it round-trips" — it is that a ciphertext lifted out of
 * one account's row cannot be opened in another's. That is the whole reason the
 * envelope is bound to (account, provider) rather than to nothing.
 */
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'pat-test-0000-1111-2222-3333';

describe('secret envelope', () => {
  it('round-trips a credential under the same binding', () => {
    const key = loadEncryptionKey(KEY);
    const aad = secretAad('acct-1', 'hubspot');
    expect(decryptSecret(encryptSecret(TOKEN, key, aad), key, aad)).toBe(TOKEN);
  });

  it('produces a versioned four-part envelope that never contains the plaintext', () => {
    const key = loadEncryptionKey(KEY);
    const envelope = encryptSecret(TOKEN, key, secretAad('acct-1', 'hubspot'));
    expect(envelope.split('.')).toHaveLength(4);
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(envelope).not.toContain(TOKEN);
  });

  it('produces a different ciphertext each time (fresh iv)', () => {
    const key = loadEncryptionKey(KEY);
    const aad = secretAad('acct-1', 'hubspot');
    expect(encryptSecret(TOKEN, key, aad)).not.toBe(encryptSecret(TOKEN, key, aad));
  });

  // The binding, stated as a test. Without it, one account's stored credential
  // opens in another account's row and writes that account's bookings into
  // somebody else's CRM.
  it('refuses to decrypt under a DIFFERENT account', () => {
    const key = loadEncryptionKey(KEY);
    const envelope = encryptSecret(TOKEN, key, secretAad('acct-1', 'hubspot'));
    expect(() => decryptSecret(envelope, key, secretAad('acct-2', 'hubspot'))).toThrow(
      SecretCryptoError,
    );
  });

  it('refuses to decrypt under a different PROVIDER on the same account', () => {
    const key = loadEncryptionKey(KEY);
    const envelope = encryptSecret(TOKEN, key, secretAad('acct-1', 'hubspot'));
    expect(() => decryptSecret(envelope, key, secretAad('acct-1', 'other'))).toThrow(
      SecretCryptoError,
    );
  });

  it('refuses a wrong key', () => {
    const aad = secretAad('acct-1', 'hubspot');
    const envelope = encryptSecret(TOKEN, loadEncryptionKey(KEY), aad);
    const other = loadEncryptionKey(randomBytes(32).toString('base64'));
    expect(() => decryptSecret(envelope, other, aad)).toThrow(SecretCryptoError);
  });

  it('refuses a tampered ciphertext, tag, or iv', () => {
    const key = loadEncryptionKey(KEY);
    const aad = secretAad('acct-1', 'hubspot');
    const [v, iv, tag, ct] = encryptSecret(TOKEN, key, aad).split('.');
    const flip = (part: string) => {
      const b = Buffer.from(part, 'base64url');
      b[0] = b[0]! ^ 0xff;
      return b.toString('base64url');
    };
    for (const bad of [
      [v, flip(iv!), tag, ct].join('.'),
      [v, iv, flip(tag!), ct].join('.'),
      [v, iv, tag, flip(ct!)].join('.'),
    ]) {
      expect(() => decryptSecret(bad, key, aad)).toThrow(SecretCryptoError);
    }
  });

  it('refuses an unrecognized envelope shape or version', () => {
    const key = loadEncryptionKey(KEY);
    const aad = secretAad('acct-1', 'hubspot');
    for (const bad of ['', 'nonsense', 'v2.a.b.c', 'v1.a.b']) {
      expect(() => decryptSecret(bad, key, aad)).toThrow(SecretCryptoError);
    }
  });
});

describe('loadEncryptionKey', () => {
  it('accepts exactly 32 bytes of base64', () => {
    expect(loadEncryptionKey(KEY)).toHaveLength(32);
  });

  // Fails loud: a 16-byte key silently downgrading AES-256 is the class of bug
  // that surfaces only when it already matters.
  it('refuses a missing key, and says how to make one', () => {
    expect(() => loadEncryptionKey(undefined)).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    expect(() => loadEncryptionKey('')).toThrow(/openssl rand -base64 32/);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => loadEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => loadEncryptionKey(randomBytes(64).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('isPlaceholderSecret', () => {
  // An uncommented-but-unfilled .env line must read as UNSET. Treating it as a
  // real token means every booking burns its retries against a value that 401s
  // forever, and the operator sees failures rather than "not configured".
  it('treats the shipped placeholder shapes as unset', () => {
    for (const v of [
      undefined,
      null,
      '',
      '   ',
      'replace-with-your-private-app-token',
      'replace_with_a_token',
      'your-token-here',
      'changeme',
      'CHANGE_ME',
      'placeholder',
      'xxxxx',
      'TODO',
      '<paste-token>',
    ]) {
      expect(isPlaceholderSecret(v)).toBe(true);
    }
  });

  it('treats a real-looking token as set', () => {
    expect(isPlaceholderSecret(TOKEN)).toBe(false);
  });
});

describe('secretLast4', () => {
  it('returns only the last four characters', () => {
    expect(secretLast4(TOKEN)).toBe('3333');
  });
});
