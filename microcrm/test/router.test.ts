import { createHmac } from 'node:crypto';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { type WebhookPayload } from '../src/whatsapp/types';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'verify-token-0123456789';

function setup() {
  const process = vi.fn<(payload: WebhookPayload) => Promise<void>>().mockResolvedValue();
  const app = createApp({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, sink: { process }, logger: pino({ level: 'silent' }) });
  return { app, process };
}

const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '27110000001', phone_number_id: '100000000000001' },
            contacts: [{ wa_id: '27821234567', profile: { name: 'Thandi' } }],
            messages: [{ from: '27821234567', id: 'wamid.ABC', timestamp: '1792000000', type: 'text', text: { body: 'Hi' } }],
          },
        },
      ],
    },
  ],
});

describe('GET /webhooks/whatsapp', () => {
  it('echoes the challenge for the right verify token', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('1158201444');
  });

  it('returns the challenge as text/plain, not HTML', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '42' });
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('refuses challenges that are not plain tokens (reflected XSS)', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '<script>alert(1)</script>' });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('<script>');
  });

  it('refuses repeated or nested query parameters', async () => {
    const { app } = setup();
    const base = `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`;
    expect((await request(app).get(`/webhooks/whatsapp?${base}&hub.challenge=1&hub.challenge=2`)).status).toBe(403);
    expect((await request(app).get(`/webhooks/whatsapp?${base}&hub.verify_token=x&hub.challenge=1`)).status).toBe(403);
    expect((await request(app).get(`/webhooks/whatsapp?${base}&hub.challenge[a]=1`)).status).toBe(403);
  });

  it('refuses a wrong verify token', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(res.status).toBe(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('acks a correctly signed payload and hands it to the processor', async () => {
    const { app, process } = setup();
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[0].entry[0]?.changes[0]?.field).toBe('messages');
  });

  it('rejects a bad signature without processing', async () => {
    const { app, process } = setup();
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(`${payload} `))
      .send(payload);
    expect(res.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['without the sha256= prefix', createHmac('sha256', APP_SECRET).update(payload).digest('hex')],
    ['truncated', 'sha256=abc'],
    ['non-hex', `sha256=${'zz'.repeat(32)}`],
    ['over-long', `${sign(payload)}00`],
  ])('answers 401, never 500, for a %s signature header', async (_case, header) => {
    const { app, process } = setup();
    const req = request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json');
    const res = await (header === undefined ? req : req.set('X-Hub-Signature-256', header)).send(payload);
    expect(res.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
  });

  it('verifies the raw bytes whatever the content type', async () => {
    const { app, process } = setup();
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'text/plain')
      .set('X-Hub-Signature-256', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(process).toHaveBeenCalledOnce();
  });

  it('rejects signed bodies that are not WhatsApp webhooks', async () => {
    const { app, process } = setup();
    const body = JSON.stringify({ object: 'page', entry: [] });
    const res = await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(body)).send(body);
    expect(res.status).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });
});
