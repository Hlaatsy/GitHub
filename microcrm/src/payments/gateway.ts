import { type PaymentProvider } from '@prisma/client';

/** Provider-neutral result. Anything a provider reports that is not clearly success maps away from SUCCESSFUL. */
export type PaymentOutcome = 'SUCCESSFUL' | 'FAILED' | 'CANCELLED' | 'PENDING';

export interface CreatePaymentInput {
  /** Our merchant reference; the provider echoes it back in every notification. */
  reference: string;
  amountCents: number;
  /** Shown on the customer's bank statement. */
  bankReference: string;
  notifyUrl: string;
  successUrl: string;
  cancelUrl: string;
  errorUrl: string;
}

export interface CreatedPayment {
  providerPaymentId: string;
  /** Provider-hosted checkout (bank selection / PayShap) page. */
  checkoutUrl: string;
}

export interface ProviderTransaction {
  reference: string;
  providerTransactionId: string;
  outcome: PaymentOutcome;
  rawStatus: string;
  amountCents: number;
  currency: string;
  isTest: boolean;
}

export interface PaymentGateway {
  readonly provider: PaymentProvider;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** Authenticates and parses a settlement notification. Throws PaymentError on any failure. */
  verifyNotification(rawBody: Buffer, contentType: string | undefined): ProviderTransaction;
  /** Server-to-server status lookup: the source of truth before any order is confirmed. */
  fetchTransactions(reference: string): Promise<ProviderTransaction[]>;
}
