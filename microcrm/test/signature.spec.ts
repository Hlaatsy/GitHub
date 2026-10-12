import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app';
import { OZOW_NOTIFICATION_HASH_FIELDS, OzowGateway } from '../src/payments/ozow';
import { verifyMetaSignature } from '../src/webhooks/signature';
import { type WebhookPayload } from '../src/whatsapp/types';

// Security suite: every forged or altered webhook must be refused before any
// business logic runs, and a refusal must never surface as a 500.

const APP_SECRET = 'za_test_app_secret_2026';
const VERIFY_TOKEN = 'verify-token-0123456789';

const metaPayload = JSON.stringify({
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
            contacts: [{ wa_id: '27821234567', profile: { name: 'Mandla Khumalo' } }],
            messages: [{ from: '27821234567', id: 'wamid.TEST', timestamp: '1792000000', type: 'text', text: { body: 'Hi 👋' } }],
          },
        },
      ],
    },
  ],
});

const hmacHex = (secret: string, body: string | Buffer) => createHmac('sha256', secret).update(body).digest('hex');
const metaSignature = (body: string | Buffer, secret = APP_SECRET) => `sha256=${hmacHex(secret, body)}`;

function appWithSpySink() {
  const process = jest.fn(async (_payload: WebhookPayload) => undefined);
  const app = createApp({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, sink: { process }, logger: pino({ level: 'silent' }) });
  return { app, process };
}

/** Lets the router's post-ack setImmediate run before asserting on the sink. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('verifyMetaSignature (X-Hub-Signature-256)', () => {
  const body = Buffer.from(metaPayload, 'utf8');

  it('accepts the exact bytes Meta signed', () => {
    expect(verifyMetaSignature(body, metaSignature(body), APP_SECRET)).toBe(true);
  });

  it('accepts multi-byte UTF-8 (emoji) because it hashes bytes, not a re-decoded string', () => {
    expect(metaPayload).toContain('👋');
    expect(verifyMetaSignature(body, metaSignature(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body altered by one character', () => {
    const tampered = Buffer.from(metaPayload.replace('27821234567', '27829999999'));
    expect(verifyMetaSignature(tampered, metaSignature(body), APP_SECRET)).toBe(false);
  });

  it('rejects a body re-serialised by a JSON parser (whitespace changes the bytes)', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(metaPayload), null, 2));
    expect(verifyMetaSignature(reserialised, metaSignature(body), APP_SECRET)).toBe(false);
  });

  it('rejects a signature made with a different app secret', () => {
    expect(verifyMetaSignature(body, metaSignature(body, 'attacker_guess'), APP_SECRET)).toBe(false);
  });

  it('rejects a genuine signature replayed onto a different body', () => {
    const otherBody = Buffer.from(metaPayload.replace('Hi', 'Book'));
    expect(verifyMetaSignature(otherBody, metaSignature(body), APP_SECRET)).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['without the sha256= prefix', hmacHex(APP_SECRET, body)],
    ['with an uppercase prefix', `SHA256=${hmacHex(APP_SECRET, body)}`],
    ['using the legacy sha1= header format', `sha1=${createHmac('sha1', APP_SECRET).update(body).digest('hex')}`],
    ['truncated', 'sha256=abc123'],
    ['non-hex', `sha256=${'zz'.repeat(32)}`],
    ['over-long', `${metaSignature(body)}00`],
    ['all zeros', `sha256=${'0'.repeat(64)}`],
  ])('returns false, never throws, for header: %s', (_case, header) => {
    expect(() => verifyMetaSignature(body, header, APP_SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, header, APP_SECRET)).toBe(false);
  });
});

describe('POST /webhooks/whatsapp blocks fake network payloads', () => {
  it('acknowledges a genuine payload and hands it to the processor once', async () => {
    const { app, process } = appWithSpySink();
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', metaSignature(metaPayload))
      .send(metaPayload);

    expect(res.status).toBe(200);
    await flush();
    expect(process).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no signature', undefined, metaPayload],
    ['a forged signature', metaSignature(metaPayload, 'attacker_guess'), metaPayload],
    ['a tampered body', metaSignature(metaPayload), metaPayload.replace('Hi', 'STOP')],
    ['a truncated signature', 'sha256=abc', metaPayload],
    ['a non-hex signature', `sha256=${'zz'.repeat(32)}`, metaPayload],
  ])('answers a bare 401 for %s and never reaches the processor', async (_case, header, body) => {
    const { app, process } = appWithSpySink();
    const req = request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json');
    const res = await (header === undefined ? req : req.set('X-Hub-Signature-256', header)).send(body);

    expect(res.status).toBe(401);
    expect(res.text).toBe('Unauthorized');
    await flush();
    expect(process).not.toHaveBeenCalled();
  });

  it('refuses a correctly signed body that is not a WhatsApp webhook', async () => {
    const { app, process } = appWithSpySink();
    const body = JSON.stringify({ object: 'page', entry: [] });
    const res = await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', metaSignature(body)).send(body);

    expect(res.status).toBe(400);
    await flush();
    expect(process).not.toHaveBeenCalled();
  });

  it('refuses a correctly signed body that is not JSON', async () => {
    const { app, process } = appWithSpySink();
    const body = '<xml>not json</xml>';
    const res = await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', metaSignature(body)).send(body);

    expect(res.status).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });
});

describe('Ozow settlement notification hash', () => {
  const config = {
    siteCode: 'TST-SITE-01',
    apiKey: 'api-key',
    privateKey: 'PrivKey-test',
    baseUrl: 'https://stagingapi.ozow.com',
    isTest: true,
    timeoutMs: 1000,
    logger: pino({ level: 'silent' }),
  };
  const gateway = new OzowGateway(config);
  const FORM = 'application/x-www-form-urlencoded';

  function notification(overrides: Record<string, string> = {}, privateKey = config.privateKey) {
    const fields: Record<string, string> = {
      SiteCode: config.siteCode,
      TransactionId: 'tx-1',
      TransactionReference: 'WAABC234DEFG',
      Amount: '125.00',
      Status: 'Complete',
      CurrencyCode: 'ZAR',
      IsTest: 'true',
      StatusMessage: 'ok',
      ...overrides,
    };
    const concatenated = OZOW_NOTIFICATION_HASH_FIELDS.map((field) => fields[field] ?? '').join('') + privateKey;
    return { ...fields, Hash: createHash('sha512').update(concatenated.toLowerCase()).digest('hex') };
  }
  const form = (fields: Record<string, string>) => Buffer.from(new URLSearchParams(fields).toString());

  it('accepts a genuine notification', () => {
    expect(gateway.verifyNotificationBody(form(notification()), FORM).outcome).toBe('SUCCESSFUL');
  });

  it('rejects an amount changed after signing', () => {
    expect(() => gateway.verifyNotificationBody(form({ ...notification(), Amount: '1.00' }), FORM)).toThrow(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );
  });

  it('rejects a "Complete" status forged onto a cancelled payment', () => {
    const cancelled = notification({ Status: 'Cancelled' });
    expect(() => gateway.verifyNotificationBody(form({ ...cancelled, Status: 'Complete' }), FORM)).toThrow(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );
  });

  it('rejects a hash made without the merchant private key', () => {
    expect(() => gateway.verifyNotificationBody(form(notification({}, 'guessed-key')), FORM)).toThrow(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );
  });

  it('rejects a smuggled duplicate Status field', () => {
    const body = Buffer.from(`${new URLSearchParams(notification({ Status: 'Cancelled' })).toString()}&Status=Complete`);
    expect(() => gateway.verifyNotificationBody(body, FORM)).toThrow(expect.objectContaining({ code: 'PAYLOAD_INVALID' }));
  });
});
