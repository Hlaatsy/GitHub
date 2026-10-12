import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type Checklist } from '../src/onboarding/OnboardingService';
import { salonTenant } from './fixtures';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

function setup(checklist: Partial<Checklist> = {}) {
  const onboarding = {
    resolve: vi.fn(async (token: string) => (token === TOKEN ? salonTenant({ businessName: '<b>Glow</b>' }) : null)),
    checklist: vi.fn(async () => ({
      businessName: '<b>Glow</b>',
      steps: [
        { key: 'connect' as const, title: 'Connect your WhatsApp number', state: 'done' as const, detail: ['ok'] },
        { key: 'test_payment' as const, title: 'Make your first test payment', state: 'todo' as const, detail: ['<script>x</script>'] },
      ],
      canSendTestPayment: true,
      waiting: false,
      ...checklist,
    })),
    sendTestPayment: vi.fn(async () => 'sent' as const),
  };
  const app = createApp({ appSecret: 's', verifyToken: 'verify-token-0123456789', sink: { process: vi.fn() }, logger: pino({ level: 'silent' }), onboarding });
  return { app, onboarding };
}

describe('/onboarding/:token', () => {
  it('renders the checklist with escaped content and locked-down headers', async () => {
    const { app } = setup();
    const res = await request(app).get(`/onboarding/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('&#60;b&#62;Glow&#60;/b&#62;');
    expect(res.text).not.toContain('<script>x</script>');
    expect(res.text).toContain(`action="/onboarding/${TOKEN}/test-payment"`);
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('auto-refreshes only while a step is in progress', async () => {
    expect((await request(setup().app).get(`/onboarding/${TOKEN}`)).text).not.toContain('http-equiv="refresh"');
    expect((await request(setup({ waiting: true }).app).get(`/onboarding/${TOKEN}`)).text).toContain('http-equiv="refresh"');
  });

  it('shows only fixed notices, never the raw query string', async () => {
    const { app } = setup();
    expect((await request(app).get(`/onboarding/${TOKEN}?result=sent`)).text).toContain('Test payment link sent');
    expect((await request(app).get(`/onboarding/${TOKEN}?result=<img src=x>`)).text).not.toContain('<img');
  });

  it('returns 404 for unknown, expired or malformed tokens without a lookup for malformed ones', async () => {
    const { app, onboarding } = setup();
    expect((await request(app).get(`/onboarding/${'z'.repeat(32)}`)).status).toBe(404);
    expect((await request(app).get('/onboarding/short')).status).toBe(404);
    expect(onboarding.resolve).toHaveBeenCalledTimes(1);
  });

  it('sends the test payment then redirects (post/redirect/get)', async () => {
    const { app, onboarding } = setup();
    const res = await request(app).post(`/onboarding/${TOKEN}/test-payment`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/onboarding/${TOKEN}?result=sent`);
    expect(onboarding.sendTestPayment).toHaveBeenCalledOnce();
  });

  it('rate-limits repeated test sends per business', async () => {
    const { app, onboarding } = setup();
    for (let i = 0; i < 5; i++) await request(app).post(`/onboarding/${TOKEN}/test-payment`);
    expect(onboarding.sendTestPayment).toHaveBeenCalledTimes(3);
  });
});
