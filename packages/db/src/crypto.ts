/**
 * Symmetric encryption at rest for third-party credentials (H1a / #63).
 *
 * This repo had NO symmetric crypto before this module: API keys are hashed and
 * webhook secrets are stored in plaintext. Hashing is the right answer when a
 * secret only ever has to be *compared*; it is the wrong answer when the secret
 * has to be *used*, which is exactly what an integration token is. So the layer
 * that owns the row owns the secret at rest — this module lives in `@slate/db`,
 * beside the table, and the adapter never sees the key.
 *
 * ENVELOPE: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version
 * prefix is what makes a future key rotation or algorithm change a readable
 * migration rather than an archaeology exercise.
 *
 * BINDING: AES-256-GCM takes additional authenticated data, and we bind every
 * envelope to `${accountId}:${provider}`. That is what "enveloped per (account,
 * provider)" buys: a ciphertext lifted out of one account's row and pasted into
 * another's fails to decrypt rather than quietly handing account B a working
 * credential belonging to account A.
 *
 * The key (`INTEGRATION_ENCRYPTION_KEY`) is 32 raw bytes, base64. It is read
 * only when a credential is written or read — a deployment that never connects
 * an integration never needs one, so boot is unaffected and a bare fork stays
 * clone-and-run.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

const b64url = (b: Buffer): string => b.toString('base64url');

/** Thrown for every crypto misconfiguration or tampering failure. */
export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/**
 * Decode and validate the configured key. Fails LOUD on absent/short/long —
 * a 16-byte key silently downgrading AES-256 to something else is precisely the
 * class of bug that never surfaces until it matters.
 */
export function loadEncryptionKey(configured: string | undefined | null): Buffer {
  if (!configured) {
    throw new SecretCryptoError(
      'INTEGRATION_ENCRYPTION_KEY is not set — refusing to store an integration credential in plaintext. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }
  // Node's base64 decoder never throws — it silently drops invalid characters —
  // so the length check below is what actually catches a malformed key, and it
  // is the check that matters: a short key would quietly stop being AES-256.
  const key = Buffer.from(configured, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

/** The GCM additional-authenticated-data: the row's identity, not its content. */
export function secretAad(accountId: string, provider: string): string {
  return `${accountId}:${provider}`;
}

/** Encrypt a credential into the versioned envelope, bound to `aad`. */
export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretCryptoError('encryption key must be 32 bytes.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join('.');
}

/**
 * Decrypt an envelope. THROWS on a tampered ciphertext, a tampered tag, a
 * wrong key, or an `aad` that does not match the one it was sealed with —
 * GCM authenticates, so "decrypted to garbage" is not a reachable outcome.
 */
export function decryptSecret(envelope: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretCryptoError('encryption key must be 32 bytes.');
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError('unrecognized secret envelope (expected `v1.<iv>.<tag>.<ciphertext>`).');
  }
  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretCryptoError('secret envelope has a malformed iv or auth tag.');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque: the caller learns it failed, never which part failed.
    throw new SecretCryptoError('failed to decrypt the stored credential (wrong key, or the value was altered).');
  }
}

/**
 * Placeholder detection for the env fallback.
 *
 * `.env.example` ships every knob commented out with a descriptive placeholder,
 * and someone will uncomment one without filling it in. Treating that as a real
 * token means every booking burns its retries against a value that 401s
 * forever; treating it as UNSET means the integration is simply off, which is
 * both true and the state the operator can actually see and fix.
 */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  if (!value) return true;
  const v = value.trim();
  if (v === '') return true;
  return /^(replace[-_ ]?with|your[-_ ]|changeme|change[-_ ]?me|placeholder|xxx+|todo|<.*>)/i.test(v);
}

/** Last four characters of a credential — the only part ever shown to a client. */
export function secretLast4(secret: string): string {
  return secret.slice(-4);
}
