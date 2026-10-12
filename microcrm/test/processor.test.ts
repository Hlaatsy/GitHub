import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ConversationHandlers } from '../src/bot/handlers';
import { SlidingWindowLimiter } from '../src/lib/rateLimiter';
import { type CustomerContext, type CustomerRepository } from '../src/services/customers';
import { type InboundLedger } from '../src/services/inboundLedger';
import { type OutboundMessenger } from '../src/services/messenger';
import { type TenantDirectory } from '../src/services/tenants';
import { WebhookProcessor } from '../src/webhooks/processor';
import { type InboundMessage, type WebhookPayload } from '../src/whatsapp/types';
import { type WhatsAppService } from '../src/whatsapp/WhatsAppService';
import { salonTenant } from './fixtures';

const NOW = new Date('2026-10-12T08:00:00Z');
const PHONE_ID = '100000000000001';

function payload(messages: InboundMessage[], phoneNumberId = PHONE_ID, statuses: unknown[] = []): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '27110000001', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '27821234567', profile: { name: 'Thandi' } }],
              messages,
              statuses: statuses as never,
            },
          },
        ],
      },
    ],
  };
}

const text = (body: string, id = 'wamid.1'): InboundMessage => ({
  from: '27821234567',
  id,
  timestamp: String(NOW.getTime() / 1000 - 5),
  type: 'text',
  text: { body },
});

function setup(customer: Partial<CustomerContext> = {}, onFailedStatus?: (...args: unknown[]) => Promise<unknown>) {
  const claimed = new Set<string>();
  const ledger = { claim: vi.fn(async (_t: string, wamid: string) => !claimed.has(wamid) && Boolean(claimed.add(wamid))) };
  const customers = {
    touch: vi.fn(async (): Promise<CustomerContext> => ({
      id: 'c1',
      waId: '27821234567',
      displayName: 'Thandi',
      optedOutAt: null,
      lastMenuSentAt: null,
      ...customer,
    })),
    optOut: vi.fn(),
    optBackIn: vi.fn(),
    markMenuSent: vi.fn(),
  };
  const messenger = { reply: vi.fn().mockResolvedValue({ status: 'sent', wamid: 'wamid.out', billing: {} }) };
  const tenants = { byPhoneNumberId: vi.fn(async (id: string) => (id === PHONE_ID ? salonTenant() : null)) };

  const processor = new WebhookProcessor({
    tenants: tenants as unknown as TenantDirectory,
    customers: customers as unknown as CustomerRepository,
    ledger: ledger as unknown as InboundLedger,
    // MENU/opt-out paths never touch the database.
    handlers: new ConversationHandlers({} as never, customers as unknown as CustomerRepository, { menuCooldownMs: 300_000 }),
    messenger: messenger as unknown as OutboundMessenger,
    whatsapp: { markAsRead: vi.fn() } as unknown as WhatsAppService,
    limiter: new SlidingWindowLimiter(6, 60_000),
    logger: pino({ level: 'silent' }),
    markAsRead: false,
    staleAfterMs: 3_600_000,
    clock: () => NOW,
    ...(onFailedStatus ? { onFailedStatus } : {}),
  });
  return { processor, messenger, customers, tenants };
}

describe('WebhookProcessor', () => {
  it('replies to a trigger phrase with exactly one menu message', async () => {
    const { processor, messenger, customers } = setup();
    await processor.process(payload([text('Hi')]));
    expect(messenger.reply).toHaveBeenCalledOnce();
    expect(messenger.reply.mock.calls[0]?.[2]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    expect(customers.markMenuSent).toHaveBeenCalledOnce();
  });

  it('never replies twice to a redelivered message', async () => {
    const { processor, messenger } = setup();
    await processor.process(payload([text('Hi')]));
    await processor.process(payload([text('Hi')]));
    expect(messenger.reply).toHaveBeenCalledOnce();
  });

  it('drops webhooks for numbers that belong to no active tenant', async () => {
    const { processor, messenger, customers } = setup();
    await processor.process(payload([text('Hi')], '999'));
    expect(customers.touch).not.toHaveBeenCalled();
    expect(messenger.reply).not.toHaveBeenCalled();
  });

  it('does not repeat the menu for free text inside the cooldown', async () => {
    const { processor, messenger } = setup({ lastMenuSentAt: new Date(NOW.getTime() - 60_000) });
    await processor.process(payload([text('is anyone there?')]));
    expect(messenger.reply).not.toHaveBeenCalled();
  });

  it('stays silent to opted-out customers until they send a trigger word', async () => {
    const { processor, messenger, customers } = setup({ optedOutAt: new Date('2026-10-01T00:00:00Z') });
    await processor.process(payload([text('hello??', 'wamid.a'), text('ok', 'wamid.b')]));
    expect(messenger.reply).toHaveBeenCalledOnce();
    expect(customers.optBackIn).toHaveBeenCalledOnce();
  });

  it('skips stale messages from delayed deliveries', async () => {
    const { processor, messenger } = setup();
    await processor.process(payload([{ ...text('Hi'), timestamp: String(NOW.getTime() / 1000 - 7200) }]));
    expect(messenger.reply).not.toHaveBeenCalled();
  });

  it('routes only well-formed failed statuses to the failure hook', async () => {
    const hook = vi.fn().mockResolvedValue({ status: 'sent' });
    const { processor, messenger } = setup({}, hook);
    const status = (id: string, value: string, extra: object = {}) => ({
      id,
      status: value,
      recipient_id: '27821234567',
      timestamp: '1792000000',
      ...extra,
    });
    await processor.process(
      payload([], PHONE_ID, [
        status('wamid.sent', 'sent'),
        status('wamid.read', 'read'),
        status('wamid.fail', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] }),
        { id: 'wamid.bad', status: 'failed' },
      ]),
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[1]).toMatchObject({ id: 'wamid.fail', errors: [{ code: 131026 }] });
    expect(messenger.reply).not.toHaveBeenCalled();
  });

  it('ignores failed statuses for unknown tenants', async () => {
    const hook = vi.fn();
    const { processor } = setup({}, hook);
    await processor.process(payload([], '999', [{ id: 'w', status: 'failed', recipient_id: '27821234567', timestamp: '1', errors: [] }]));
    expect(hook).not.toHaveBeenCalled();
  });
});
