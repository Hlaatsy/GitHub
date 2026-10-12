import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
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
import { assertCheckoutHost, parseJson, providerRequest } from './http';

// Paystack: hosted checkout from POST /transaction/initialize, settled by a
// webhook signed with HMAC-SHA512 of the raw body (x-paystack-signature,
// keyed with the secret key). Every webhook is confirmed with
// GET /transaction/verify/:reference before anything is marked paid.

const STATUS_OUTCOMES: Record<string, PaymentOutcome> = {
  success: 'SUCCESSFUL',
  failed: 'FAILED',
  reversed: 'FAILED',
  abandoned: 'CANCELLED',
};

const CHECKOUT_HOST = /(^|\.)paystack\.(com|co)$/i;

export interface PaystackConfig {
  /** sk_live_… or sk_test_…; also the webhook signing key. */
  secretKey: string;
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  /**
   * Paystack requires a customer email, which WhatsApp customers don't give.
   * Returns a placeholder for a payment reference (see PaymentService).
   */
  placeholderEmail: (reference: string) => string;
}

const TransactionSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  reference: z.string(),
  status: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  domain: z.enum(['live', 'test']).optional(),
});

const WebhookSchema = z.object({ event: z.string(), data: z.unknown() });

export class PaystackGateway implements PaymentGateway {
  readonly provider = 'PAYSTACK' as const;
  readonly supportsLookup = true;
  private readonly baseUrl: string;
  private readonly mode: 'live' | 'test';

  constructor(private readonly config: PaystackConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.mode = config.secretKey.startsWith('sk_live_') ? 'live' : 'test';
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    // Not retried: a lost response could leave the reference used, and
    // Paystack refuses a duplicate reference anyway.
    const response = await providerRequest(
      `${this.baseUrl}/transaction/initialize`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.config.placeholderEmail(input.reference),
          amount: input.amountCents,
          currency: 'ZAR',
          reference: input.reference,
          callback_url: input.successUrl,
          metadata: { cancel_action: input.cancelUrl, description: input.description },
        }),
      },
      { timeoutMs: this.config.timeoutMs, logger: this.config.logger },
    );
    const body = parseJson(response.text) as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string } } | undefined;
    if (response.status !== 200 || !body?.status || !body.data?.authorization_url) {
      throw new PaymentError('GATEWAY_REJECTED', `Paystack refused the payment: ${body?.message ?? `HTTP ${response.status}`}`);
    }
    return {
      providerPaymentId: body.data.access_code ?? null,
      checkout: { method: 'GET', url: assertCheckoutHost(body.data.authorization_url, CHECKOUT_HOST, 'Paystack') },
    };
  }

  async verifyNotification({ rawBody, header }: NotificationContext): Promise<ProviderTransaction | null> {
    const signature = header('x-paystack-signature') ?? '';
    if (!/^[0-9a-f]{128}$/i.test(signature)) throw new PaymentError('SIGNATURE_INVALID', 'Paystack signature missing or malformed');
    const expected = createHmac('sha512', this.config.secretKey).update(rawBody).digest();
    const provided = Buffer.from(signature.toLowerCase(), 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Paystack signature mismatch');
    }

    const event = WebhookSchema.safeParse(parseJson(rawBody.toString('utf8')));
    if (!event.success) throw new PaymentError('PAYLOAD_INVALID', 'Paystack webhook is not a JSON event');
    // Authentic, but only charge outcomes concern us (transfers, subscriptions… are ignored).
    if (!event.data.event.startsWith('charge.')) return null;

    const tx = TransactionSchema.safeParse(event.data.data);
    if (!tx.success) throw new PaymentError('PAYLOAD_INVALID', 'Paystack charge event malformed');
    return this.toTransaction(tx.data);
  }

  async confirmTransaction(notification: ProviderTransaction): Promise<ProviderTransaction | null> {
    const [verified] = await this.fetchTransactions(notification.reference);
    return verified && verified.providerTransactionId === notification.providerTransactionId ? verified : null;
  }

  async fetchTransactions(reference: string): Promise<ProviderTransaction[]> {
    const response = await providerRequest(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.config.secretKey}` } },
      { timeoutMs: this.config.timeoutMs, logger: this.config.logger, retryTransient: true },
    );
    if (response.status === 400 || response.status === 404) return [];
    const body = parseJson(response.text) as { status?: boolean; data?: unknown } | undefined;
    const tx = TransactionSchema.safeParse(body?.data);
    if (response.status !== 200 || !body?.status || !tx.success) {
      throw new PaymentError('GATEWAY_REJECTED', `Unexpected Paystack verify response (HTTP ${response.status})`);
    }
    // A test-mode transaction must never confirm a live booking (or vice versa).
    if (tx.data.domain && tx.data.domain !== this.mode) return [];
    return [this.toTransaction(tx.data)];
  }

  private toTransaction(tx: z.infer<typeof TransactionSchema>): ProviderTransaction {
    return {
      reference: tx.reference,
      providerTransactionId: tx.id,
      outcome: STATUS_OUTCOMES[tx.status.toLowerCase()] ?? 'PENDING',
      rawStatus: tx.status,
      amountCents: tx.amount,
      currency: tx.currency.toUpperCase(),
    };
  }
}
