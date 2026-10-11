import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Logger } from '../lib/logger';
import { PaymentError } from './errors';
import {
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentGateway,
  type PaymentOutcome,
  type ProviderTransaction,
} from './gateway';
import { centsToDecimal, decimalToCents } from './money';

// Ozow pay-by-bank (instant EFT). Authentication has two layers:
//  - outbound API calls carry the merchant ApiKey header and a SHA512 HashCheck;
//  - inbound notifications carry a SHA512 Hash over the posted fields.
// Both hashes are: concatenate field values in the documented order, append
// the merchant private key, lowercase the whole string, SHA512, hex.
//
// The field orders below must match Ozow's current request/notification
// variable tables exactly; confirm them against hub.ozow.com before go-live.
// A wrong order fails closed: every notification is rejected as unsigned.

export const OZOW_REQUEST_HASH_FIELDS = [
  'SiteCode',
  'CountryCode',
  'CurrencyCode',
  'Amount',
  'TransactionReference',
  'BankReference',
  'Optional1',
  'Optional2',
  'Optional3',
  'Optional4',
  'Optional5',
  'Customer',
  'CancelUrl',
  'ErrorUrl',
  'SuccessUrl',
  'NotifyUrl',
  'IsTest',
] as const;

export const OZOW_NOTIFICATION_HASH_FIELDS = [
  'SiteCode',
  'TransactionId',
  'TransactionReference',
  'Amount',
  'Status',
  'Optional1',
  'Optional2',
  'Optional3',
  'Optional4',
  'Optional5',
  'CurrencyCode',
  'IsTest',
  'StatusMessage',
] as const;

const STATUS_OUTCOMES: Record<string, PaymentOutcome> = {
  complete: 'SUCCESSFUL',
  cancelled: 'CANCELLED',
  abandoned: 'CANCELLED',
  error: 'FAILED',
  pending: 'PENDING',
  pendinginvestigation: 'PENDING',
};

const OZOW_CHECKOUT_HOST = /(^|\.)ozow\.com$/i;
const MAX_TRANSIENT_RETRIES = 1;
const RETRY_DELAY_MS = 300;

export interface OzowConfig {
  siteCode: string;
  apiKey: string;
  privateKey: string;
  /** https://api.ozow.com (live) or https://stagingapi.ozow.com (staging). */
  baseUrl: string;
  isTest: boolean;
  timeoutMs: number;
  logger: Logger;
}

export function ozowHash(values: Readonly<Record<string, string | undefined>>, fields: readonly string[], privateKey: string): string {
  const concatenated = fields.map((field) => values[field] ?? '').join('') + privateKey;
  return createHash('sha512').update(concatenated.toLowerCase(), 'utf8').digest('hex');
}

/** Unknown statuses are never treated as paid. */
export function mapOzowStatus(status: string): PaymentOutcome {
  return STATUS_OUTCOMES[status.replace(/\s+/g, '').toLowerCase()] ?? 'PENDING';
}

const optionalField = z.string().max(100).optional();

const NotificationSchema = z.object({
  SiteCode: z.string().min(1).max(50),
  TransactionId: z.string().min(1).max(100),
  TransactionReference: z.string().regex(/^[A-Za-z0-9-]{1,50}$/),
  Amount: z.string().min(1).max(15),
  Status: z.string().min(1).max(40),
  Optional1: optionalField,
  Optional2: optionalField,
  Optional3: optionalField,
  Optional4: optionalField,
  Optional5: optionalField,
  CurrencyCode: z.string().length(3),
  IsTest: z.string().regex(/^(true|false)$/i),
  StatusMessage: z.string().max(500).optional(),
  Hash: z.string().regex(/^[0-9a-f]{128}$/i),
});

const TransactionSchema = z.object({
  transactionId: z.string().min(1),
  transactionReference: z.string(),
  siteCode: z.string().optional(),
  currencyCode: z.string(),
  amount: z.number().nonnegative(),
  status: z.string(),
  isTest: z.boolean().optional(),
});

const PaymentRequestResponseSchema = z.object({
  paymentRequestId: z.string().nullish(),
  url: z.string().nullish(),
  errorMessage: z.string().nullish(),
});

export class OzowGateway implements PaymentGateway {
  readonly provider = 'OZOW' as const;
  private readonly baseUrl: string;

  constructor(private readonly config: OzowConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const fields: Record<string, string> = {
      SiteCode: this.config.siteCode,
      CountryCode: 'ZA',
      CurrencyCode: 'ZAR',
      Amount: centsToDecimal(input.amountCents),
      TransactionReference: input.reference,
      BankReference: input.bankReference,
      CancelUrl: input.cancelUrl,
      ErrorUrl: input.errorUrl,
      SuccessUrl: input.successUrl,
      NotifyUrl: input.notifyUrl,
      IsTest: String(this.config.isTest),
    };
    const body = { ...fields, HashCheck: ozowHash(fields, OZOW_REQUEST_HASH_FIELDS, this.config.privateKey) };

    // Retrying after a timeout may leave an orphaned Ozow payment request with
    // the same reference, but the customer only ever sees the URL we return,
    // and every notification resolves through the shared reference.
    const parsed = PaymentRequestResponseSchema.safeParse(await this.call('POST', '/PostPaymentRequest', body));
    if (!parsed.success || parsed.data.errorMessage || !parsed.data.url || !parsed.data.paymentRequestId) {
      throw new PaymentError('GATEWAY_REJECTED', `Ozow refused the payment request: ${parsed.success ? parsed.data.errorMessage ?? 'no checkout URL' : 'unexpected response'}`);
    }
    return { providerPaymentId: parsed.data.paymentRequestId, checkoutUrl: assertOzowCheckoutUrl(parsed.data.url) };
  }

  verifyNotification(rawBody: Buffer, contentType: string | undefined): ProviderTransaction {
    const parsed = NotificationSchema.safeParse(parseNotificationFields(rawBody, contentType));
    if (!parsed.success) {
      throw new PaymentError('PAYLOAD_INVALID', `Malformed Ozow notification: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    const fields = parsed.data;

    const expected = Buffer.from(ozowHash(fields, OZOW_NOTIFICATION_HASH_FIELDS, this.config.privateKey), 'hex');
    const provided = Buffer.from(fields.Hash.toLowerCase(), 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Ozow notification hash mismatch');
    }

    // Authentic, but meant for a different site or environment: never act on it.
    if (fields.SiteCode !== this.config.siteCode) {
      throw new PaymentError('PAYLOAD_INVALID', 'Notification is for a different Ozow site');
    }
    const isTest = fields.IsTest.toLowerCase() === 'true';
    if (isTest !== this.config.isTest) {
      throw new PaymentError('PAYLOAD_INVALID', `Received a ${isTest ? 'test' : 'live'} notification in ${this.config.isTest ? 'test' : 'live'} mode`);
    }

    return {
      reference: fields.TransactionReference,
      providerTransactionId: fields.TransactionId,
      outcome: mapOzowStatus(fields.Status),
      rawStatus: fields.Status,
      amountCents: decimalToCents(fields.Amount),
      currency: fields.CurrencyCode.toUpperCase(),
      isTest,
    };
  }

  async fetchTransactions(reference: string): Promise<ProviderTransaction[]> {
    const query = new URLSearchParams({
      siteCode: this.config.siteCode,
      transactionReference: reference,
      isTest: String(this.config.isTest),
    });
    const response = await this.call('GET', `/GetTransactionByReference?${query.toString()}`);
    const parsed = z.array(TransactionSchema).safeParse(response);
    if (!parsed.success) {
      throw new PaymentError('GATEWAY_REJECTED', 'Unexpected GetTransactionByReference response');
    }
    return parsed.data
      .filter((tx) => tx.transactionReference === reference && (!tx.siteCode || tx.siteCode === this.config.siteCode))
      .map((tx) => ({
        reference: tx.transactionReference,
        providerTransactionId: tx.transactionId,
        outcome: mapOzowStatus(tx.status),
        rawStatus: tx.status,
        amountCents: Math.round(tx.amount * 100),
        currency: tx.currencyCode.toUpperCase(),
        isTest: tx.isTest ?? this.config.isTest,
      }));
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(method, path, body);
      } catch (error) {
        if (!(error instanceof PaymentError) || !error.transient || attempt >= MAX_TRANSIENT_RETRIES) throw error;
        this.config.logger.warn({ path: path.split('?')[0], code: error.code, attempt }, 'ozow call failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  private async callOnce(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ApiKey: this.config.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new PaymentError(
        timedOut ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE',
        timedOut ? `Ozow did not respond within ${this.config.timeoutMs} ms` : 'Could not reach Ozow',
        { cause: error },
      );
    }

    if (response.status >= 500) {
      throw new PaymentError('GATEWAY_UNAVAILABLE', `Ozow responded with HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new PaymentError('GATEWAY_REJECTED', `Ozow responded with HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new PaymentError('GATEWAY_REJECTED', 'Ozow returned a non-JSON response', { cause: error });
    }
  }
}

/** Never relay a checkout URL we did not expect: it ends up in front of the customer. */
function assertOzowCheckoutUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentError('GATEWAY_REJECTED', 'Ozow returned an invalid checkout URL');
  }
  if (url.protocol !== 'https:' || !OZOW_CHECKOUT_HOST.test(url.hostname) || url.username || url.password) {
    throw new PaymentError('GATEWAY_REJECTED', `Unexpected checkout host ${url.hostname}`);
  }
  return url.toString();
}

/** Accepts form-encoded (Ozow's default) or JSON; rejects repeated keys to block parameter pollution. */
function parseNotificationFields(rawBody: Buffer, contentType: string | undefined): Record<string, string> {
  const type = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  const fields: Record<string, string> = {};

  if (type === 'application/x-www-form-urlencoded') {
    for (const [key, value] of new URLSearchParams(rawBody.toString('utf8'))) {
      if (key in fields) throw new PaymentError('PAYLOAD_INVALID', `Duplicate field ${key}`);
      fields[key] = value;
    }
    return fields;
  }

  if (type === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new PaymentError('PAYLOAD_INVALID', 'Notification body is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PaymentError('PAYLOAD_INVALID', 'Notification body must be a JSON object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new PaymentError('PAYLOAD_INVALID', `Field ${key} must be a scalar`);
      }
      fields[key] = String(value);
    }
    return fields;
  }

  throw new PaymentError('PAYLOAD_INVALID', `Unsupported content type ${type || '(none)'}`);
}
