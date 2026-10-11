import { createHash } from 'node:crypto';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../src/payments/errors';
import { OZOW_NOTIFICATION_HASH_FIELDS, OzowGateway, mapOzowStatus, ozowHash } from '../src/payments/ozow';

const config = {
  siteCode: 'TST-TST-001',
  apiKey: 'api-key',
  privateKey: 'PrivateKey123',
  baseUrl: 'https://stagingapi.ozow.com/',
  isTest: true,
  timeoutMs: 50,
  logger: pino({ level: 'silent' }),
};
const gateway = new OzowGateway(config);

const createInput = {
  reference: 'WAABC234DEFG',
  amountCents: 15050,
  bankReference: 'WAABC234DEFG',
  notifyUrl: 'https://crm.example.co.za/webhooks/payments',
  successUrl: 'https://crm.example.co.za/pay/t/return?result=success',
  cancelUrl: 'https://crm.example.co.za/pay/t/return?result=cancelled',
  errorUrl: 'https://crm.example.co.za/pay/t/return?result=error',
};

function notification(overrides: Record<string, string> = {}, privateKey = config.privateKey): Record<string, string> {
  const fields: Record<string, string> = {
    SiteCode: config.siteCode,
    TransactionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    TransactionReference: 'WAABC234DEFG',
    Amount: '150.50',
    Status: 'Complete',
    CurrencyCode: 'ZAR',
    IsTest: 'true',
    StatusMessage: 'Test transaction completed',
    ...overrides,
  };
  return { ...fields, Hash: overrides.Hash ?? ozowHash(fields, OZOW_NOTIFICATION_HASH_FIELDS, privateKey) };
}

const form = (fields: Record<string, string>) => Buffer.from(new URLSearchParams(fields).toString());
const FORM = 'application/x-www-form-urlencoded';

afterEach(() => vi.unstubAllGlobals());

describe('ozowHash', () => {
  it('is SHA512 of the ordered values plus private key, lowercased', () => {
    const expected = createHash('sha512').update('abcprivatekey').digest('hex');
    expect(ozowHash({ A: 'A', B: 'b', C: 'C' }, ['A', 'B', 'C'], 'PrivateKey')).toBe(expected);
  });
});

describe('mapOzowStatus', () => {
  it.each([
    ['Complete', 'SUCCESSFUL'],
    ['Cancelled', 'CANCELLED'],
    ['Abandoned', 'CANCELLED'],
    ['Error', 'FAILED'],
    ['PendingInvestigation', 'PENDING'],
    ['SomethingNew', 'PENDING'],
  ])('%s -> %s', (status, outcome) => {
    expect(mapOzowStatus(status)).toBe(outcome);
  });
});

describe('createPayment', () => {
  it('posts a hashed request and returns the checkout URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ paymentRequestId: 'pr-1', url: 'https://pay.ozow.com/pr-1/Secure', errorMessage: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.createPayment(createInput)).resolves.toEqual({ providerPaymentId: 'pr-1', checkoutUrl: 'https://pay.ozow.com/pr-1/Secure' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stagingapi.ozow.com/PostPaymentRequest');
    expect(init.headers).toMatchObject({ ApiKey: 'api-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ SiteCode: 'TST-TST-001', CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: '150.50', IsTest: 'true' });
    const concatenated = [
      'TST-TST-001', 'ZA', 'ZAR', '150.50', createInput.reference, createInput.bankReference,
      createInput.cancelUrl, createInput.errorUrl, createInput.successUrl, createInput.notifyUrl, 'true',
    ].join('') + config.privateKey;
    expect(body.HashCheck).toBe(createHash('sha512').update(concatenated.toLowerCase()).digest('hex'));
  });

  it('refuses checkout URLs outside ozow.com', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ paymentRequestId: 'pr-1', url: 'https://evil.example/pay' })));
    await expect(gateway.createPayment(createInput)).rejects.toMatchObject({ code: 'GATEWAY_REJECTED' });
  });

  it('surfaces provider error messages as rejections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ errorMessage: 'Invalid site code' })));
    await expect(gateway.createPayment(createInput)).rejects.toThrow(/Invalid site code/);
  });

  it('retries a timeout once, then reports GATEWAY_TIMEOUT', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await gateway.createPayment(createInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentError);
    expect(error).toMatchObject({ code: 'GATEWAY_TIMEOUT', transient: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.createPayment(createInput)).rejects.toMatchObject({ code: 'GATEWAY_REJECTED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('verifyNotification', () => {
  it('accepts a correctly hashed form notification', () => {
    expect(gateway.verifyNotification(form(notification()), FORM)).toEqual({
      reference: 'WAABC234DEFG',
      providerTransactionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      outcome: 'SUCCESSFUL',
      rawStatus: 'Complete',
      amountCents: 15050,
      currency: 'ZAR',
      isTest: true,
    });
  });

  it('accepts an uppercase hash', () => {
    const fields = notification();
    fields.Hash = fields.Hash!.toUpperCase();
    expect(gateway.verifyNotification(form(fields), FORM).outcome).toBe('SUCCESSFUL');
  });

  it('rejects a tampered amount', () => {
    const fields = { ...notification(), Amount: '1.00' };
    expect(() => gateway.verifyNotification(form(fields), FORM)).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });

  it('rejects a hash made with the wrong key', () => {
    expect(() => gateway.verifyNotification(form(notification({}, 'wrong')), FORM)).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });

  it('rejects duplicate fields (parameter pollution)', () => {
    const body = Buffer.from(`${new URLSearchParams(notification()).toString()}&Status=Complete`);
    expect(() => gateway.verifyNotification(body, FORM)).toThrow(expect.objectContaining({ code: 'PAYLOAD_INVALID' }));
  });

  it('rejects authentic notifications for another site or environment', () => {
    expect(() => gateway.verifyNotification(form(notification({ SiteCode: 'OTHER-SITE' })), FORM)).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_INVALID' }),
    );
    expect(() => gateway.verifyNotification(form(notification({ IsTest: 'false' })), FORM)).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_INVALID' }),
    );
  });

  it('rejects malformed fields and unsupported content types', () => {
    expect(() => gateway.verifyNotification(form(notification({ TransactionReference: "x' OR 1=1" })), FORM)).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_INVALID' }),
    );
    expect(() => gateway.verifyNotification(form(notification()), 'text/plain')).toThrow(expect.objectContaining({ code: 'PAYLOAD_INVALID' }));
  });
});

describe('fetchTransactions', () => {
  it('queries by reference and keeps only matching rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { transactionId: 't1', transactionReference: 'WAABC234DEFG', siteCode: 'TST-TST-001', currencyCode: 'ZAR', amount: 150.5, status: 'Complete' },
        { transactionId: 't2', transactionReference: 'WAABC234DEFG', siteCode: 'OTHER', currencyCode: 'ZAR', amount: 150.5, status: 'Complete' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await gateway.fetchTransactions('WAABC234DEFG');
    expect(result).toEqual([
      expect.objectContaining({ providerTransactionId: 't1', outcome: 'SUCCESSFUL', amountCents: 15050 }),
    ]);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://stagingapi.ozow.com/GetTransactionByReference?siteCode=TST-TST-001&transactionReference=WAABC234DEFG&isTest=true',
    );
  });
});
