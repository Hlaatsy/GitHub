import { z } from 'zod';
import { type SmsEncoding } from './segments';
import { SmsError, type SmsProvider } from './provider';

// BulkSMS JSON REST API v1: POST {base}/messages with HTTP Basic auth using an
// API token id and secret. Responds 201 with an array of created message
// objects. Confirm the auth scheme and response shape against
// developer.bulksms.com before go-live.

export interface BulkSmsConfig {
  tokenId: string;
  tokenSecret: string;
  baseUrl: string;
  timeoutMs: number;
  /** Registered alphanumeric sender ID; omit to use BulkSMS's default route. */
  senderId?: string;
}

const CreatedMessagesSchema = z.array(z.object({ id: z.union([z.string(), z.number()]) }).passthrough()).min(1);

export class BulkSmsProvider implements SmsProvider {
  readonly name = 'bulksms';
  private readonly endpoint: string;
  private readonly authorization: string;

  constructor(private readonly config: BulkSmsConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/messages`;
    this.authorization = `Basic ${Buffer.from(`${config.tokenId}:${config.tokenSecret}`).toString('base64')}`;
  }

  async send(to: string, body: string, encoding: SmsEncoding): Promise<{ providerMessageId: string }> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: `+${to}`,
          body,
          encoding: encoding === 'UCS2' ? 'UNICODE' : 'TEXT',
          ...(this.config.senderId ? { from: this.config.senderId } : {}),
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      // A timeout may still have been delivered; the caller does not retry.
      throw new SmsError(`BulkSMS request failed: ${(error as Error).message}`, 0, { cause: error });
    }

    if (!response.ok) {
      throw new SmsError(`BulkSMS responded with HTTP ${response.status}`, response.status);
    }
    const parsed = CreatedMessagesSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new SmsError('BulkSMS returned an unexpected response', response.status);
    }
    return { providerMessageId: String(parsed.data[0]?.id) };
  }
}
