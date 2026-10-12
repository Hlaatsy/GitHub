import { type PaymentProvider } from '@prisma/client';

/** Provider-neutral result. Anything a provider reports that is not clearly success maps away from SUCCESSFUL. */
export type PaymentOutcome = 'SUCCESSFUL' | 'FAILED' | 'CANCELLED' | 'PENDING';

export interface CreatePaymentInput {
  /** Our merchant reference; the provider echoes it back in every notification. */
  reference: string;
  amountCents: number;
  /** Shown on the customer's bank statement or the checkout page. */
  description: string;
  notifyUrl: string;
  successUrl: string;
  cancelUrl: string;
  errorUrl: string;
}

/** How the customer's browser reaches the provider's checkout. */
export type Checkout =
  | { method: 'GET'; url: string }
  /** A signed form the browser must POST (PayFast has no create-payment API). */
  | { method: 'POST'; url: string; fields: Record<string, string> };

export interface CreatedPayment {
  providerPaymentId: string | null;
  checkout: Checkout;
}

export interface ProviderTransaction {
  reference: string;
  providerTransactionId: string;
  outcome: PaymentOutcome;
  rawStatus: string;
  amountCents: number;
  currency: string;
}

export interface NotificationContext {
  rawBody: Buffer;
  contentType: string | undefined;
  /** Caller IP as seen behind the trusted proxy. */
  sourceIp: string | undefined;
  /** Header lookup (case-insensitive), for providers that sign in a header. */
  header: (name: string) => string | undefined;
}

export interface PaymentGateway {
  readonly provider: PaymentProvider;

  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;

  /**
   * Authenticates and parses a settlement notification. Throws PaymentError
   * (SIGNATURE_INVALID / PAYLOAD_INVALID) on anything untrustworthy. Returns
   * null for authentic events that are not about a payment outcome.
   */
  verifyNotification(context: NotificationContext): Promise<ProviderTransaction | null>;

  /**
   * Asks the provider, server to server, for its own record of a notified
   * transaction. The result, not the notification, decides the outcome.
   * Null means the provider does not confirm it.
   */
  confirmTransaction(notification: ProviderTransaction, context: NotificationContext): Promise<ProviderTransaction | null>;

  /** Whether `fetchTransactions` works; reconciliation of missed notifications needs it. */
  readonly supportsLookup: boolean;

  /** Server-to-server lookup by our reference, for reconciliation. */
  fetchTransactions(reference: string): Promise<ProviderTransaction[]>;
}
