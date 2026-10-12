import { type Logger } from '../lib/logger';
import { maskMsisdn } from '../lib/msisdn';
import {
  type GraphErrorBody,
  type InteractiveObject,
  type MediaMetadata,
  type OutboundMessage,
  type SendMessageResponse,
} from './types';
import { asText } from './interactive';

export interface WhatsAppServiceOptions {
  accessToken: string;
  graphVersion: string;
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

export interface GraphTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejected_reason?: string;
}

export interface SentMessage {
  wamid: string;
  waId: string;
}

/** Graph API codes that mean "throttled, nothing was sent". */
const THROTTLE_CODES = new Set([4, 80007, 130429, 131056]);
const MAX_THROTTLE_RETRY_MS = 5_000;

export class WhatsAppApiError extends Error {
  override readonly name = 'WhatsAppApiError';

  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
  ) {
    super(message);
  }

  get throttled(): boolean {
    return this.status === 429 || (this.code !== undefined && THROTTLE_CODES.has(this.code));
  }
}

/** Thin, typed client for the WhatsApp Business Cloud API messaging endpoints. */
export class WhatsAppService {
  private readonly endpoint: string;

  constructor(private readonly options: WhatsAppServiceOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/${options.graphVersion}`;
  }

  sendInteractive(phoneNumberId: string, to: string, interactive: InteractiveObject): Promise<SentMessage> {
    return this.sendMessage(phoneNumberId, to, { type: 'interactive', interactive });
  }

  sendText(phoneNumberId: string, to: string, body: string): Promise<SentMessage> {
    return this.sendMessage(phoneNumberId, to, asText(body));
  }

  sendTemplate(
    phoneNumberId: string,
    to: string,
    name: string,
    languageCode: string,
    bodyParameters: readonly string[] = [],
  ): Promise<SentMessage> {
    return this.sendMessage(phoneNumberId, to, {
      type: 'template',
      template: {
        name,
        language: { code: languageCode },
        ...(bodyParameters.length > 0
          ? { components: [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    });
  }

  async sendMessage(phoneNumberId: string, to: string, message: OutboundMessage): Promise<SentMessage> {
    const response = await this.request<SendMessageResponse>('POST', `${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...message,
    });
    const wamid = response.messages?.[0]?.id;
    if (!wamid) {
      throw new WhatsAppApiError('Graph API returned no message id', 502);
    }
    this.options.logger.debug({ to: maskMsisdn(to), wamid, type: message.type }, 'whatsapp message sent');
    return { wamid, waId: response.contacts?.[0]?.wa_id ?? to };
  }

  /** Blue ticks. Not billed by Meta, but still one extra round trip per message. */
  async markAsRead(phoneNumberId: string, messageId: string): Promise<void> {
    await this.request('POST', `${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  /** Submits a template for Meta review. Returns Meta's id, initial status and assigned category. */
  createTemplate(wabaId: string, template: unknown): Promise<{ id: string; status: string; category: string }> {
    return this.request('POST', `${encodeURIComponent(wabaId)}/message_templates`, template);
  }

  /** All templates in a WABA, following Graph pagination. */
  async listTemplates(wabaId: string): Promise<GraphTemplate[]> {
    const templates: GraphTemplate[] = [];
    let path: string | null =
      `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=100`;
    for (let page = 0; path && page < 50; page++) {
      const response: { data?: GraphTemplate[]; paging?: { cursors?: { after?: string }; next?: string } } =
        await this.request('GET', path);
      templates.push(...(response.data ?? []));
      const after = response.paging?.next ? response.paging.cursors?.after : undefined;
      path = after
        ? `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=100&after=${encodeURIComponent(after)}`
        : null;
    }
    return templates;
  }

  getMediaMetadata(mediaId: string): Promise<MediaMetadata> {
    return this.request<MediaMetadata>('GET', encodeURIComponent(mediaId));
  }

  /** Only called when a tenant has opted in to media handling; refuses oversized files before downloading. */
  async downloadMedia(mediaId: string, maxBytes: number): Promise<{ mimeType: string; data: Buffer }> {
    const meta = await this.getMediaMetadata(mediaId);
    if (meta.file_size > maxBytes) {
      throw new WhatsAppApiError(`Media ${mediaId} is ${meta.file_size} bytes, over the ${maxBytes} byte limit`, 413);
    }
    const response = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new WhatsAppApiError(`Media download failed with HTTP ${response.status}`, response.status);
    }
    return { mimeType: meta.mime_type, data: Buffer.from(await response.arrayBuffer()) };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.endpoint}/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        throw new WhatsAppApiError(`Graph API request failed: ${(error as Error).message}`, 0);
      }

      const raw = await response.text();
      const json = parseJson(raw);
      if (response.ok) return json as T;

      const graphError = (json as GraphErrorBody | undefined)?.error;
      const error = new WhatsAppApiError(
        graphError?.message ?? `Graph API responded with HTTP ${response.status}`,
        response.status,
        graphError?.code,
        graphError?.error_subcode,
        graphError?.fbtrace_id,
      );

      // Only throttling is retried: Meta guarantees nothing was sent, so the
      // retry can never produce (and bill) a duplicate message. A 5xx or a
      // timeout may have been delivered, so those fail fast instead.
      if (error.throttled && attempt === 0) {
        await delay(retryAfterMs(response.headers.get('retry-after')));
        continue;
      }
      throw error;
    }
  }
}

function parseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_THROTTLE_RETRY_MS) : 1_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
