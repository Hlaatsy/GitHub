import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { PaymentError } from '../src/payments/errors';

function setup(handle: () => Promise<unknown>, allowedIps?: ReadonlySet<string>) {
  const service = {
    handleNotification: vi.fn(handle),
    providers: ['OZOW', 'PAYFAST', 'PAYSTACK'] as const,
    resolveLink: vi.fn(async () => ({ action: 'redirect' as const, url: 'https://pay.ozow.com/pr-1/Secure' })),
    describeReturn: vi.fn(async () => ({ action: 'show' as const, state: 'processing' as const, businessName: '<b>Glow</b>', waDisplayPhone: '+27 11 000 0001' })),
  };
  const app = createApp({
    appSecret: 's',
    verifyToken: 'verify-token-0123456789',
    sink: { process: vi.fn() },
    logger: pino({ level: 'silent' }),
    payments: { service: service as never, ...(allowedIps ? { allowedIps: { OZOW: allowedIps } } : {}) },
  });
  return { app, service };
}

const post = (app: ReturnType<typeof setup>['app'], body = 'SiteCode=X', type = 'application/x-www-form-urlencoded') =>
  request(app).post('/webhooks/payments').set('Content-Type', type).send(body);

describe('POST /webhooks/payments', () => {
  it('acknowledges a processed notification', async () => {
    const { app, service } = setup(async () => ({ status: 'settled' }));
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(service.handleNotification).toHaveBeenCalledWith(
      'OZOW',
      expect.objectContaining({ rawBody: expect.any(Buffer), contentType: 'application/x-www-form-urlencoded' }),
      expect.any(Date),
    );
  });

  it.each([
    ['SIGNATURE_INVALID', 401],
    ['PAYLOAD_INVALID', 400],
    ['GATEWAY_TIMEOUT', 503],
    ['SETTLEMENT_CONFLICT', 503],
  ] as const)('maps %s to %i', async (code, status) => {
    const { app } = setup(async () => {
      throw new PaymentError(code, 'x');
    });
    const res = await post(app);
    expect(res.status).toBe(status);
    if (status === 503) expect(res.headers['retry-after']).toBe('30');
  });

  it('hides unexpected errors behind a bare 500', async () => {
    const { app } = setup(async () => {
      throw new Error('db exploded: password=hunter2');
    });
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('hunter2');
  });

  it('rejects unsupported content types and oversized bodies before processing', async () => {
    const { app, service } = setup(async () => ({}));
    expect((await post(app, 'x', 'text/plain')).status).toBe(415);
    expect((await post(app, `a=${'x'.repeat(40_000)}`)).status).toBe(413);
    expect(service.handleNotification).not.toHaveBeenCalled();
  });

  it('enforces the source IP allowlist when configured', async () => {
    const { app, service } = setup(async () => ({}), new Set(['203.0.113.10']));
    expect((await post(app)).status).toBe(403);
    expect(service.handleNotification).not.toHaveBeenCalled();
  });
});

describe('per-provider settlement routes', () => {
  it('routes each path to its own provider', async () => {
    const { app, service } = setup(async () => ({ status: 'settled' }));
    await request(app).post('/api/payments/callback').set('Content-Type', 'application/json').send('{"event":"charge.success"}');
    await request(app).post('/api/payments/payfast-itn').set('Content-Type', 'application/x-www-form-urlencoded').send('m_payment_id=X');
    expect(service.handleNotification.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['PAYSTACK', 'PAYFAST']);
  });

  it('does not mount routes for providers that are not configured', async () => {
    const handleNotification = vi.fn();
    const app = createApp({
      appSecret: 's',
      verifyToken: 'verify-token-0123456789',
      sink: { process: vi.fn() },
      logger: pino({ level: 'silent' }),
      payments: { service: { handleNotification, providers: ['OZOW'], resolveLink: vi.fn(), describeReturn: vi.fn() } as never },
    });
    expect((await request(app).post('/api/payments/callback').set('Content-Type', 'application/json').send('{}')).status).toBe(404);
    expect((await request(app).post('/api/payments/payfast-itn').type('form').send('a=1')).status).toBe(404);
    expect(handleNotification).not.toHaveBeenCalled();
  });
});

describe('GET /pay/:token', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz012345';

  it('redirects a live link to the checkout page without leaking a referrer', async () => {
    const { app } = setup(async () => ({}));
    const res = await request(app).get(`/pay/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://pay.ozow.com/pr-1/Secure');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects malformed tokens without a lookup', async () => {
    const { app, service } = setup(async () => ({}));
    expect((await request(app).get('/pay/short')).status).toBe(404);
    expect(service.resolveLink).not.toHaveBeenCalled();
  });

  it('renders the return page from our record, escaping tenant data', async () => {
    const { app } = setup(async () => ({}));
    const res = await request(app).get(`/pay/${token}/return?result=success`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Confirming your payment');
    expect(res.text).toContain('&#60;b&#62;Glow&#60;/b&#62;');
    expect(res.text).toContain('https://wa.me/27110000001');
  });

  it('renders a self-submitting form for PayFast, with a CSP that only allows posting to PayFast', async () => {
    const { app, service } = setup(async () => ({}));
    service.resolveLink.mockResolvedValueOnce({
      action: 'form',
      url: 'https://www.payfast.co.za/eng/process',
      fields: { merchant_id: '10000100', item_name: 'Glow "Studio" <deposit>', signature: 'abc' },
    } as never);
    const res = await request(app).get(`/pay/${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('action="https://www.payfast.co.za/eng/process"');
    expect(res.text).toContain('value="Glow &#34;Studio&#34; &#60;deposit&#62;"');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('form-action https://www.payfast.co.za');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.text).toContain(`<script nonce="${nonce}">`);
  });
});

