import { describe, expect, it } from 'vitest';
import { formatPaymentConfirmedTemplate, formatPaymentLinkMessage, templateParam } from '../src/payments/messages';
import { centsToDecimal, decimalToCents, zarToCents } from '../src/payments/money';

const link = {
  amountCents: 15000,
  shortUrl: 'https://crm.example.co.za/pay/abcdefghijklmnopqrstuvwxyz012345',
  linkToken: 'abcdefghijklmnopqrstuvwxyz012345',
  expiresAt: new Date('2026-10-12T07:30:00Z'),
};
const ctx = {
  businessName: 'Glow Studio',
  timeZone: 'Africa/Johannesburg',
  summary: '📅 Wash & Blow on Mon 12 Oct at 09:00',
  templateLanguage: 'en',
  requestTemplate: 'payment_request',
};

describe('formatPaymentLinkMessage', () => {
  it('uses a cta_url button inside the service window', () => {
    expect(formatPaymentLinkMessage(link, ctx, { inServiceWindow: true })).toEqual({
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: '📅 Wash & Blow on Mon 12 Oct at 09:00\nPay R150.00 securely to lock it in.' },
        footer: { text: 'Link valid until 09:30' },
        action: { name: 'cta_url', parameters: { display_text: 'Pay R150.00', url: link.shortUrl } },
      },
    });
  });

  it('falls back to a template with the token as the URL-button suffix', () => {
    expect(formatPaymentLinkMessage(link, ctx, { inServiceWindow: false })).toEqual({
      type: 'template',
      template: {
        name: 'payment_request',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: ['Glow Studio', '📅 Wash & Blow on Mon 12 Oct at 09:00', 'R150.00', '09:30'].map((text) => ({ type: 'text', text })),
          },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: link.linkToken }] },
        ],
      },
    });
  });
});

describe('formatPaymentConfirmedTemplate', () => {
  it('strips newlines from parameters, which Meta rejects', () => {
    const message = formatPaymentConfirmedTemplate('payment_confirmed', 'en', {
      businessName: 'Glow\nStudio',
      summary: 'Box Braids   on Mon',
      amountCents: 85000,
      reference: 'WA1234',
    });
    expect(message).toMatchObject({
      template: { components: [{ parameters: [{ text: 'Glow Studio' }, { text: 'Box Braids on Mon' }, { text: 'R850.00' }, { text: 'WA1234' }] }] },
    });
    expect(templateParam('a\tb')).toBe('a b');
  });
});

describe('money', () => {
  it('converts rand to cents exactly', () => {
    expect(zarToCents(150.5)).toBe(15050);
    expect(zarToCents(0.1 + 0.2)).toBe(30);
    expect(() => zarToCents(10.005)).toThrow(/two decimal places/);
    expect(() => zarToCents(-1)).toThrow();
    expect(() => zarToCents(Number.NaN)).toThrow();
  });

  it('round-trips decimal strings without floats', () => {
    expect(centsToDecimal(15050)).toBe('150.50');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(decimalToCents('150.5')).toBe(15050);
    expect(decimalToCents('150')).toBe(15000);
    expect(() => decimalToCents('1e3')).toThrow();
    expect(() => decimalToCents('-5.00')).toThrow();
  });
});
