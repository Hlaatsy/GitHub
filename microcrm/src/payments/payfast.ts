import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { type Logger } from '../lib/logger';
import { PaymentError } from './errors';
import {
  type CreatePaymentInput,
  type CreatedPayment,
  type NotificationContext,
  type PaymentGateway,
  type PaymentOutcome,
  type ProviderTransaction,
} from './gateway';
import { parseFormPairs, providerRequest } from './http';
import { centsToDecimal, decimalToCents } from './money';

// PayFast: hosted checkout reached by a signed browser form POST, settled by
// an ITN (Instant Transaction Notification) to our notify_url. Each ITN is
// accepted only after all four of PayFast's checks pass:
//   1. MD5 signature over the posted fields (in received order) + passphrase;
//   2. the request comes from one of PayFast's hosts (resolved via DNS);
//   3. the amount matches what we asked for (checked in PaymentService);
//   4. PayFast's validate endpoint confirms the exact ITN is genuine.
//
// The checkout field order below follows PayFast's documented attribute
// order; confirm it (and the ITN host list) against developers.payfast.co.za
// before go-live. A mistake fails closed: payments are refused, not accepted.

export const PAYFAST_CHECKOUT_FIELD_ORDER = [
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
] as const;

const HOSTS = {
  live: { process: 'https://www.payfast.co.za/eng/process', validate: 'https://www.payfast.co.za/eng/query/validate' },
  sandbox: { process: 'https://sandbox.payfast.co.za/eng/process', validate: 'https://sandbox.payfast.co.za/eng/query/validate' },
} as const;

export const PAYFAST_ITN_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'] as const;
const HOST_CACHE_MS = 10 * 60_000;
const ITEM_NAME_MAX = 100;

const STATUS_OUTCOMES: Record<string, PaymentOutcome> = {
  COMPLETE: 'SUCCESSFUL',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
};

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  sandbox: boolean;
  timeoutMs: number;
  /** Check that ITNs come from PayFast's hosts. Only disable for local testing. */
  verifySourceIp: boolean;
  logger: Logger;
  /** Overridable for tests. */
  resolveHosts?: () => Promise<string[]>;
  /** Tests only (not settable from the environment): stand-in process/validate endpoints. */
  endpoints?: { process: string; validate: string };
}

/** PHP's urlencode(): what PayFast hashes. Spaces become '+', and !'()*~ are percent-encoded. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function payfastSignature(pairs: ReadonlyArray<readonly [string, string]>, passphrase: string): string {
  const base = pairs.map(([key, value]) => `${key}=${phpUrlencode(value)}`).join('&');
  const withPassphrase = passphrase ? `${base}&passphrase=${phpUrlencode(passphrase.trim())}` : base;
  return createHash('md5').update(withPassphrase).digest('hex');
}

function normaliseIp(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:/, '');
}

export class PayFastGateway implements PaymentGateway {
  readonly provider = 'PAYFAST' as const;
  /** PayFast's query API needs separate credentials; missed ITNs are not reconciled. */
  readonly supportsLookup = false;
  private readonly hosts: { process: string; validate: string };
  private hostCache: { ips: Set<string>; expiresAt: number } | null = null;

  constructor(private readonly config: PayFastConfig) {
    this.hosts = config.endpoints ?? (config.sandbox ? HOSTS.sandbox : HOSTS.live);
  }

  /** No API call: the checkout is a form the customer's browser posts to PayFast. */
  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const values: Partial<Record<(typeof PAYFAST_CHECKOUT_FIELD_ORDER)[number], string>> = {
      merchant_id: this.config.merchantId,
      merchant_key: this.config.merchantKey,
      return_url: input.successUrl,
      cancel_url: input.cancelUrl,
      notify_url: input.notifyUrl,
      m_payment_id: input.reference,
      amount: centsToDecimal(input.amountCents),
      item_name: input.description.replace(/\s+/g, ' ').trim().slice(0, ITEM_NAME_MAX),
    };
    // Checkout signatures use trimmed, non-empty values in documented order.
    const pairs = PAYFAST_CHECKOUT_FIELD_ORDER.flatMap((key) => {
      const value = values[key]?.trim();
      return value ? [[key, value] as const] : [];
    });
    const fields = Object.fromEntries(pairs);
    return {
      providerPaymentId: null,
      checkout: { method: 'POST', url: this.hosts.process, fields: { ...fields, signature: payfastSignature(pairs, this.config.passphrase) } },
    };
  }

  async verifyNotification(context: NotificationContext): Promise<ProviderTransaction> {
    const pairs = parseFormPairs(context.rawBody, context.contentType);
    const fields = Object.fromEntries(pairs);

    for (const key of ['m_payment_id', 'pf_payment_id', 'payment_status', 'amount_gross', 'merchant_id', 'signature']) {
      if (!fields[key]) throw new PaymentError('PAYLOAD_INVALID', `PayFast ITN missing ${key}`);
    }
    const signature = fields.signature ?? '';
    if (!/^[0-9a-f]{32}$/i.test(signature)) throw new PaymentError('SIGNATURE_INVALID', 'PayFast ITN signature malformed');
    if (!/^[A-Za-z0-9-]{1,50}$/.test(fields.m_payment_id ?? '')) throw new PaymentError('PAYLOAD_INVALID', 'PayFast ITN reference malformed');

    // 1. Signature: every posted field except `signature`, in the order received.
    const signed = pairs.filter(([key]) => key !== 'signature');
    const expected = Buffer.from(payfastSignature(signed, this.config.passphrase), 'hex');
    const provided = Buffer.from(signature.toLowerCase(), 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new PaymentError('SIGNATURE_INVALID', 'PayFast ITN signature mismatch');
    }
    if (fields.merchant_id !== this.config.merchantId) {
      throw new PaymentError('PAYLOAD_INVALID', 'PayFast ITN is for a different merchant');
    }

    // 2. Source: one of PayFast's own hosts.
    if (this.config.verifySourceIp && !(await this.payfastIps()).has(normaliseIp(context.sourceIp))) {
      throw new PaymentError('SIGNATURE_INVALID', `PayFast ITN from unexpected address ${normaliseIp(context.sourceIp) || '(unknown)'}`);
    }

    const status = (fields.payment_status ?? '').toUpperCase();
    return {
      reference: fields.m_payment_id ?? '',
      providerTransactionId: fields.pf_payment_id ?? '',
      outcome: STATUS_OUTCOMES[status] ?? 'PENDING',
      rawStatus: status,
      amountCents: decimalToCents(fields.amount_gross ?? ''),
      currency: 'ZAR',
    };
  }

  /** 4. PayFast's validate endpoint must answer VALID for these exact fields. */
  async confirmTransaction(notification: ProviderTransaction, context: NotificationContext): Promise<ProviderTransaction | null> {
    const pairs = parseFormPairs(context.rawBody, context.contentType).filter(([key]) => key !== 'signature');
    const body = pairs.map(([key, value]) => `${key}=${phpUrlencode(value)}`).join('&');
    const response = await providerRequest(
      this.hosts.validate,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      { timeoutMs: this.config.timeoutMs, logger: this.config.logger, retryTransient: true },
    );
    if (response.status !== 200) throw new PaymentError('GATEWAY_REJECTED', `PayFast validate responded with HTTP ${response.status}`);
    return response.text.trim() === 'VALID' ? notification : null;
  }

  async fetchTransactions(): Promise<ProviderTransaction[]> {
    return [];
  }

  private async payfastIps(): Promise<Set<string>> {
    const now = Date.now();
    if (this.hostCache && this.hostCache.expiresAt > now) return this.hostCache.ips;
    try {
      const ips = this.config.resolveHosts
        ? await this.config.resolveHosts()
        : (await Promise.all(PAYFAST_ITN_HOSTS.map((host) => lookup(host, { all: true })))).flat().map((entry) => entry.address);
      this.hostCache = { ips: new Set(ips.map(normaliseIp)), expiresAt: now + HOST_CACHE_MS };
      return this.hostCache.ips;
    } catch (error) {
      // Cannot tell genuine from forged right now: defer, PayFast redelivers.
      throw new PaymentError('GATEWAY_UNAVAILABLE', 'Could not resolve PayFast hosts', { cause: error });
    }
  }
}
