const WA_ID_PATTERN = /^[1-9]\d{7,14}$/;

/** Normalises a WhatsApp ID to E.164 digits without '+'. Throws on anything else. */
export function normaliseWaId(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!WA_ID_PATTERN.test(digits)) {
    throw new Error('Invalid WhatsApp ID');
  }
  return digits;
}

/** POPIA-safe representation for logs: 27821234567 -> 2782*****67. */
export function maskMsisdn(waId: string): string {
  if (waId.length <= 6) return '***';
  return `${waId.slice(0, 4)}${'*'.repeat(waId.length - 6)}${waId.slice(-2)}`;
}
