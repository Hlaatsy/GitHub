import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

/** Verifies Meta's `X-Hub-Signature-256` HMAC over the exact raw request body. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Constant-time comparison for secrets of arbitrary length. */
export function secretsMatch(candidate: string, secret: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}
