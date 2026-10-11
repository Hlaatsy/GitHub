export type PaymentErrorCode =
  /** Notification hash/signature did not verify. */
  | 'SIGNATURE_INVALID'
  /** Notification body is malformed or contradicts our configuration. */
  | 'PAYLOAD_INVALID'
  /** Caller asked for something we will not charge: bad amount, wrong status, foreign callback URL. */
  | 'REQUEST_INVALID'
  /** Provider did not answer within the timeout. */
  | 'GATEWAY_TIMEOUT'
  /** Network failure or provider 5xx. */
  | 'GATEWAY_UNAVAILABLE'
  /** Provider answered and refused the request. */
  | 'GATEWAY_REJECTED'
  /** Settlement transaction lost a race or hit its timeout; safe to retry. */
  | 'SETTLEMENT_CONFLICT';

const TRANSIENT: ReadonlySet<PaymentErrorCode> = new Set(['GATEWAY_TIMEOUT', 'GATEWAY_UNAVAILABLE', 'SETTLEMENT_CONFLICT']);

export class PaymentError extends Error {
  override readonly name = 'PaymentError';

  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** The same request may succeed if retried later. */
  get transient(): boolean {
    return TRANSIENT.has(this.code);
  }
}
