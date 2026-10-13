import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { formatPaymentConfirmedTemplate, formatPaymentLinkMessage } from '../src/payments/messages';
import { OutboundMessenger } from '../src/services/messenger';
import { coreTemplates, type TemplateDefinition } from '../src/whatsapp/templates/definitions';
import { toGraphTemplate, validateTemplate } from '../src/whatsapp/templates/validate';
import { type OutboundMessage } from '../src/whatsapp/types';
import { salonTenant } from './fixtures';

const ORIGIN = 'https://crm.example.co.za';
const core = coreTemplates(ORIGIN, 'en');
const byName = (name: string) => core.find((t) => t.name === name)!;

function bodyParamCount(message: OutboundMessage): number {
  if (message.type !== 'template') throw new Error('expected a template');
  const body = message.template.components?.find((c) => c.type === 'body');
  return body?.parameters.length ?? 0;
}

describe('core templates', () => {
  it.each(core.map((t) => [t.name, t] as const))('%s passes every local Meta rule', (_name, template) => {
    expect(validateTemplate(template)).toEqual([]);
  });

  it('payment_request matches what formatPaymentLinkMessage sends outside the service window', () => {
    const message = formatPaymentLinkMessage(
      { amountCents: 12500, shortUrl: `${ORIGIN}/pay/${'a'.repeat(32)}`, linkToken: 'a'.repeat(32), expiresAt: new Date() },
      { businessName: 'Glow', timeZone: 'Africa/Johannesburg', summary: 'x', templateLanguage: 'en', requestTemplate: 'payment_request' },
      { inServiceWindow: false },
    );
    const def = byName('payment_request');
    expect(bodyParamCount(message)).toBe(def.body.params.length);
    // The URL button's dynamic suffix is the token, appended to the approved base URL.
    const button = def.buttons?.[0];
    expect(button?.type === 'URL' && button.url).toBe(`${ORIGIN}/pay/{{1}}`);
    if (message.type !== 'template') throw new Error();
    expect(message.template.components?.find((c) => c.type === 'button')?.parameters[0]?.text).toBe('a'.repeat(32));
  });

  it('payment_confirmed matches formatPaymentConfirmedTemplate', () => {
    const message = formatPaymentConfirmedTemplate('payment_confirmed', 'en', { businessName: 'G', summary: 's', amountCents: 1, reference: 'r' });
    expect(bodyParamCount(message)).toBe(byName('payment_confirmed').body.params.length);
  });

  it('wallet_low_balance matches what the messenger sends the owner', async () => {
    const sendTemplate = vi.fn().mockResolvedValue({ wamid: 'w', waId: 'x' });
    const messenger = new OutboundMessenger({
      prisma: { outboundMessage: { create: vi.fn() } } as never,
      whatsapp: { sendTemplate } as never,
      wallet: {} as never,
      logger: pino({ level: 'silent' }),
      costs: { serviceCents: 0, utilityTemplateCents: 0 },
      lowBalanceTemplate: 'wallet_low_balance',
      templateLanguage: 'en',
    });
    await messenger.notifyLowBalance(salonTenant(), {
      code: 'WALLET_LOW_BALANCE', tenantId: 't', balanceCents: 1, thresholdCents: 2, balance: 'R0.01', threshold: 'R0.02', notifyOwner: true,
    });
    expect(sendTemplate.mock.calls[0]?.[4]).toHaveLength(byName('wallet_low_balance').body.params.length);
  });
});

describe('validateTemplate', () => {
  const base: TemplateDefinition = {
    name: 'booking_reminder',
    language: 'en',
    category: 'UTILITY',
    body: { text: 'Reminder: {{1}} at {{2}}. See you soon!', params: ['service', 'time'], examples: ['Wash', '09:00'] },
  };
  const problems = (patch: Partial<TemplateDefinition>) => validateTemplate({ ...base, ...patch });

  it('accepts a well-formed custom template', () => {
    expect(problems({})).toEqual([]);
  });

  it.each<[string, Partial<TemplateDefinition>, RegExp]>([
    ['uppercase name', { name: 'BookingReminder' }, /name/],
    ['bad locale', { language: 'english' }, /language/],
    ['body starting with a placeholder', { body: { text: '{{1}} is booked.', params: ['a'], examples: ['x'] } }, /start/],
    ['body ending with a placeholder', { body: { text: 'Booked for {{1}}', params: ['a'], examples: ['x'] } }, /end/],
    ['skipped placeholder number', { body: { text: 'Hi {{1}} and {{3}}.', params: ['a', 'b'], examples: ['x', 'y'] } }, /in order/],
    ['adjacent placeholders', { body: { text: 'Hi {{1}} {{2}} ok.', params: ['a', 'b'], examples: ['x', 'y'] } }, /text between/],
    ['missing example', { body: { text: 'Hi {{1}} ok.', params: ['a'], examples: [] } }, /examples/],
    ['multi-line example', { body: { text: 'Hi {{1}} ok.', params: ['a'], examples: ['x\ny'] } }, /one line/],
    ['param map out of step', { body: { text: 'Hi {{1}} ok.', params: [], examples: ['x'] } }, /params mapped/],
    ['malformed braces', { body: { text: 'Hi {{name}} ok.', params: [], examples: [] } }, /malformed/],
    ['footer placeholder', { footer: 'Ref {{1}}' }, /footer/],
    ['long button text', { buttons: [{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }] }, /1-25/],
    ['http URL', { buttons: [{ type: 'URL', text: 'Pay', url: 'http://x.co.za/pay' }] }, /https/],
    ['placeholder mid-URL', { buttons: [{ type: 'URL', text: 'Pay', url: 'https://x.co.za/{{1}}/pay', example: 'https://x.co.za/a/pay' }] }, /very end/],
    ['URL example not on the base', { buttons: [{ type: 'URL', text: 'Pay', url: 'https://x.co.za/pay/{{1}}', example: 'https://evil.example/pay/a' }] }, /example/],
    ['phone not E.164', { buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '0821234567' }] }, /E\.164/],
  ])('rejects %s', (_case, patch, expected) => {
    expect(problems(patch).join('\n')).toMatch(expected);
  });
});

describe('toGraphTemplate', () => {
  it('builds the message_templates request body', () => {
    expect(toGraphTemplate(byName('payment_request'))).toEqual({
      name: 'payment_request',
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hi! {{1}} is holding {{2}} for you. Pay {{3}} to confirm it. This link is valid until {{4}}.',
          example: { body_text: [['Glow Studio', 'Wash & Blow on Mon 12 Oct at 09:00', 'R125.00', '09:30']] },
        },
        { type: 'FOOTER', text: 'Secure online payment' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Pay now', url: `${ORIGIN}/pay/{{1}}`, example: [`${ORIGIN}/pay/h1sqQBba0kSu2ElkZDoCEt5BMkBmPw7E`] }],
        },
      ],
    });
  });
});
