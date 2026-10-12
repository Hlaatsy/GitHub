// GSM 03.38 default alphabet. Extension characters cost two septets each.
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENSION = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'GSM7' | 'UCS2';

export interface SmsSize {
  encoding: SmsEncoding;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  /** Billable parts: carriers charge per segment, not per message. */
  segments: number;
}

/**
 * One character outside the GSM alphabet (any emoji, "ê", curly quotes)
 * switches the whole message to UCS-2, cutting a segment from 160 to 70.
 */
export function measureSms(text: string): SmsSize {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENSION.has(char)) septets += 2;
    else {
      const units = text.length;
      return { encoding: 'UCS2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
    }
  }
  return { encoding: 'GSM7', units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}
