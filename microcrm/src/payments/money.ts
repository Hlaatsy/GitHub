import { PaymentError } from './errors';

const DECIMAL_ZAR = /^\d{1,9}(\.\d{1,2})?$/;

/** Converts a rand amount such as 150.5 to 15050 cents, refusing fractions of a cent. */
export function zarToCents(amountZAR: number): number {
  if (!Number.isFinite(amountZAR) || amountZAR <= 0) {
    throw new PaymentError('REQUEST_INVALID', 'Amount must be a positive number of rand');
  }
  const cents = Math.round(amountZAR * 100);
  if (Math.abs(amountZAR * 100 - cents) > 1e-6) {
    throw new PaymentError('REQUEST_INVALID', 'Amount cannot have more than two decimal places');
  }
  return cents;
}

/** 15050 -> "150.50": the decimal string format payment APIs expect. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Parses "150.5" or "150.50" to 15050 without floating-point arithmetic. */
export function decimalToCents(value: string): number {
  const trimmed = value.trim();
  if (!DECIMAL_ZAR.test(trimmed)) {
    throw new PaymentError('PAYLOAD_INVALID', 'Amount is not a valid decimal');
  }
  const [rands = '0', fraction = ''] = trimmed.split('.');
  return Number(rands) * 100 + Number(fraction.padEnd(2, '0'));
}
