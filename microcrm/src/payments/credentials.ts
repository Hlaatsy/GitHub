import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Per-business provider credentials are stored encrypted (AES-256-GCM). The
// tenant and provider are bound in as associated data, so a ciphertext copied
// onto another business's row, or another provider's, fails to decrypt.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parses CREDENTIALS_ENCRYPTION_KEY: 32 random bytes, base64 encoded (`openssl rand -base64 32`). */
export function parseCredentialsKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value.trim()) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  }
  return key;
}

function associatedData(tenantId: string, provider: string): Buffer {
  return Buffer.from(`${tenantId}:${provider}`, 'utf8');
}

export function encryptCredentials(key: Buffer, tenantId: string, provider: string, credentials: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(tenantId, provider));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

/** Throws on a wrong key, a tampered value, or a value moved from another row. */
export function decryptCredentials(key: Buffer, tenantId: string, provider: string, sealed: string): unknown {
  const [version, payload] = sealed.split(':', 2);
  if (version !== VERSION || !payload) throw new Error('Unsupported credentials format');
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Credentials value is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(associatedData(tenantId, provider));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as unknown;
}
