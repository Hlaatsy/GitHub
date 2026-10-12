import { type ConversationHandlers } from '../bot/handlers';
import { resolveIntent } from '../bot/intents';
import { type Logger } from '../lib/logger';
import { maskMsisdn, normaliseWaId } from '../lib/msisdn';
import { type SlidingWindowLimiter } from '../lib/rateLimiter';
import { type CustomerRepository } from '../services/customers';
import { type InboundLedger } from '../services/inboundLedger';
import { type OutboundMessenger } from '../services/messenger';
import { type TenantDirectory, type TenantProfile } from '../services/tenants';
import { type InboundMessage, type WebhookPayload } from '../whatsapp/types';
import { type WhatsAppService } from '../whatsapp/WhatsAppService';
import { normaliseMessage, type MediaType } from './normalise';
import { parseFailedStatuses, parseMessagesValue, type FailedStatus } from './schema';

export interface WebhookSink {
  process(payload: WebhookPayload): Promise<void>;
}

/** Invoked only for tenants that opted in to media handling; heavy work belongs in a queue. */
export type MediaHook = (tenant: TenantProfile, mediaId: string, mediaType: MediaType) => Promise<void>;

/** Called for each delivery status Meta reports as failed (e.g. to fall back to SMS). */
export type FailedStatusHook = (tenant: TenantProfile, status: FailedStatus, now: Date) => Promise<unknown>;

/** Called with the WABA id and value of each `message_template_status_update` change. */
export type TemplateStatusHook = (wabaId: string, value: unknown) => Promise<unknown>;

export interface WebhookProcessorDeps {
  tenants: TenantDirectory;
  customers: CustomerRepository;
  ledger: InboundLedger;
  handlers: ConversationHandlers;
  messenger: OutboundMessenger;
  whatsapp: WhatsAppService;
  limiter: SlidingWindowLimiter;
  logger: Logger;
  markAsRead: boolean;
  staleAfterMs: number;
  onMediaRequested?: MediaHook;
  onFailedStatus?: FailedStatusHook;
  onTemplateStatus?: TemplateStatusHook;
  clock?: () => Date;
}

export class WebhookProcessor implements WebhookSink {
  private readonly clock: () => Date;

  constructor(private readonly deps: WebhookProcessorDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async process(payload: WebhookPayload): Promise<void> {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field === 'message_template_status_update') {
          // entry.id is the WABA; the hook only updates templates already on record for it.
          await this.deps.onTemplateStatus?.(entry.id, change.value).catch((err: unknown) => {
            this.deps.logger.error({ err, wabaId: entry.id }, 'failed to apply template status update');
          });
          continue;
        }
        if (change.field !== 'messages') continue;

        const value = parseMessagesValue(change.value);
        if (!value) {
          this.deps.logger.warn({ wabaId: entry.id }, 'malformed messages change skipped');
          continue;
        }
        // Sent/delivered/read statuses need nothing; only failures can trigger a fallback.
        const failed = this.deps.onFailedStatus ? parseFailedStatuses(value.statuses) : [];
        if (!value.messages?.length && failed.length === 0) continue;

        // Tenant isolation boundary: identity comes solely from the receiving
        // business number, resolved per change, so one batched webhook that
        // spans several numbers can never mix their data.
        const tenant = await this.deps.tenants.byPhoneNumberId(value.metadata.phone_number_id);
        if (!tenant) {
          this.deps.logger.warn({ phoneNumberId: value.metadata.phone_number_id }, 'webhook for unknown or inactive tenant');
          continue;
        }

        for (const status of failed) {
          try {
            const result = await this.deps.onFailedStatus?.(tenant, status, this.clock());
            this.deps.logger.info({ tenantId: tenant.id, wamid: status.id, codes: status.errors.map((e) => e.code), result }, 'failed delivery status handled');
          } catch (error) {
            this.deps.logger.error({ err: error, tenantId: tenant.id, wamid: status.id }, 'failed to handle delivery status');
          }
        }

        const profileNames = new Map(value.contacts?.map((contact) => [contact.wa_id, contact.profile?.name]) ?? []);
        for (const message of value.messages ?? []) {
          try {
            await this.handleMessage(tenant, message, profileNames.get(message.from));
          } catch (error) {
            this.deps.logger.error({ err: error, tenantId: tenant.id, wamid: message.id }, 'failed to handle inbound message');
          }
        }
      }
    }
  }

  private async handleMessage(tenant: TenantProfile, message: InboundMessage, profileName: string | undefined): Promise<void> {
    const { customers, ledger, handlers, messenger, whatsapp, limiter } = this.deps;
    const now = this.clock();

    let waId: string;
    try {
      waId = normaliseWaId(message.from);
    } catch {
      this.deps.logger.warn({ tenantId: tenant.id, wamid: message.id }, 'inbound message with invalid sender ignored');
      return;
    }
    const log = this.deps.logger.child({ tenantId: tenant.id, from: maskMsisdn(waId), wamid: message.id, type: message.type });

    if (!(await ledger.claim(tenant.id, message.id, message.type))) {
      log.debug('duplicate webhook delivery ignored');
      return;
    }
    if (now.getTime() - Number(message.timestamp) * 1000 > this.deps.staleAfterMs) {
      log.info('stale message (delayed delivery); not replying');
      return;
    }
    if (!limiter.allow(`${tenant.id}:${waId}`, now.getTime())) {
      log.warn('sender over rate limit; not replying');
      return;
    }

    const customer = await customers.touch(tenant.id, waId, profileName, now);
    if (this.deps.markAsRead) {
      whatsapp.markAsRead(tenant.waPhoneNumberId, message.id).catch((err) => log.debug({ err }, 'mark-as-read failed'));
    }

    const event = normaliseMessage(message);
    if (event.kind === 'media' && tenant.mediaDownloadEnabled && this.deps.onMediaRequested) {
      this.deps.onMediaRequested(tenant, event.mediaId, event.mediaType).catch((err) => log.error({ err }, 'media hook failed'));
    }

    const intent = resolveIntent(event);
    if (customer.optedOutAt) {
      // Opted-out customers get silence unless they explicitly start again.
      if (intent.name !== 'MENU') return;
      await customers.optBackIn(tenant.id, customer.id);
    }

    const reply = await handlers.handle(intent, { tenant, customer, now });
    if (!reply) return;

    const outcome = await messenger.reply(tenant, customer, reply.message, message.id, now);
    if (outcome.status !== 'sent') return;
    if (reply.kind === 'MENU') await customers.markMenuSent(tenant.id, customer.id, now);
    if (reply.afterSend) await reply.afterSend(outcome.wamid);
  }
}
