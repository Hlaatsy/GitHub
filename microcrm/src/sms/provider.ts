import { type SmsEncoding } from './segments';

export interface SmsProvider {
  readonly name: string;
  /** `to` is E.164 digits without '+', as stored for customers. */
  send(to: string, body: string, encoding: SmsEncoding): Promise<{ providerMessageId: string }>;
}

export class SmsError extends Error {
  override readonly name = 'SmsError';

  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
