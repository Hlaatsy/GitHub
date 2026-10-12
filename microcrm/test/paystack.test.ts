import { createHmac } from 'node:crypto';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaystackGateway } from '../src/payments/paystack';

const SECRET = 'sk_live_abc123';
const gateway = new PaystackGateway({
  secretKey: SECRET,
  baseUrl: 'https://api.paystack.co',
  timeoutMs: 1000,
  logger: pino({ level: 'silent' }),
  placeholderEmail: (ref) => `pay-${ref.toLowerCase()}@crm.example.co.za`,
});

const charge = (overrides: object = {}) => ({ id: 302961, reference: 'WAABC234DEFG', status: 'success', amount: 12500, currency: 'ZAR', domain: 'live', ...overrides });
const webhook = (event: object) => {
  const body = Buffer.from(JSON.stringify(event));
  return { body, signature: createHmac('sha512', SECRET).update(body).digest('hex') };
};
const ctx = (body: Buffer, signature?: string) => ({
  rawBody: body,
  contentType: 'application/json',
  sourceIp: '52.31.139.75',
  header: (name: string) => (name === 'x-paystack-signature' ? signature : undefined),
});

afterEach(() => vi.unstubAllGlobals());

describe('Paystack checkout', () => {
  it('initialises with cents, ZAR, our reference and a placeholder email', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/0peioxfhpn', access_code: '0peioxfhpn' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const created = await gateway.createPayment({
      reference: 'WAABC234DEFG', amountCents: 12500, description: 'd', notifyUrl: 'n', successUrl: 'https://s', cancelUrl: 'https://c', errorUrl: 'https://e',
    });
    expect(created).toEqual({ providerPaymentId: '0peioxfhpn', checkout: { method: 'GET', url: 'https://checkout.paystack.com/0peioxfhpn' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
    expect(JSON.parse(String(init.body))).toMatchObject({ email: 'pay-waabc234defg@crm.example.co.za', amount: 12500, currency: 'ZAR', reference: 'WAABC234DEFG' });
  });

  it('refuses unexpected checkout hosts and provider errors, without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: true, data: { authorization_url: 'https://evil.example/pay' } }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { reference: 'R', amountCents: 1, description: 'd', notifyUrl: 'n', successUrl: 's', cancelUrl: 'c', errorUrl: 'e' };
    await expect(gateway.createPayment(input)).rejects.toMatchObject({ code: 'GATEWAY_REJECTED' });
    fetchMock.mockResolvedValue(Response.json({ status: false, message: 'Duplicate Transaction Reference' }, { status: 400 }));
    await expect(gateway.createPayment(input)).rejects.toThrow(/Duplicate Transaction Reference/);
    fetchMock.mockResolvedValue(new Response('', { status: 502 }));
    await expect(gateway.createPayment(input)).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Paystack webhook verification', () => {
  it('accepts a charge.success signed with the secret key', async () => {
    const { body, signature } = webhook({ event: 'charge.success', data: charge() });
    await expect(gateway.verifyNotification(ctx(body, signature))).resolves.toEqual({
      reference: 'WAABC234DEFG', providerTransactionId: '302961', outcome: 'SUCCESSFUL', rawStatus: 'success', amountCents: 12500, currency: 'ZAR',
    });
  });

  it('rejects tampered bodies, wrong keys and missing signatures', async () => {
    const { body, signature } = webhook({ event: 'charge.success', data: charge() });
    const tampered = Buffer.from(body.toString().replace('12500', '1'));
    await expect(gateway.verifyNotification(ctx(tampered, signature))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    const forged = createHmac('sha512', 'sk_live_guess').update(body).digest('hex');
    await expect(gateway.verifyNotification(ctx(body, forged))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gateway.verifyNotification(ctx(body))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('ignores authentic non-charge events', async () => {
    const { body, signature } = webhook({ event: 'transfer.success', data: { id: 1 } });
    await expect(gateway.verifyNotification(ctx(body, signature))).resolves.toBeNull();
  });
});

describe('Paystack verify', () => {
  const notified = { reference: 'WAABC234DEFG', providerTransactionId: '302961', outcome: 'SUCCESSFUL' as const, rawStatus: 'success', amountCents: 12500, currency: 'ZAR' };

  it('confirms the same transaction id via /transaction/verify', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: true, data: charge() }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.confirmTransaction(notified)).resolves.toMatchObject({ outcome: 'SUCCESSFUL', amountCents: 12500 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.paystack.co/transaction/verify/WAABC234DEFG');
  });

  it('does not confirm a different transaction, a test-mode one, or an unknown reference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: true, data: charge({ id: 999 }) })));
    await expect(gateway.confirmTransaction(notified)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: true, data: charge({ domain: 'test' }) })));
    await expect(gateway.confirmTransaction(notified)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: false, message: 'Transaction reference not found' }, { status: 400 })));
    await expect(gateway.fetchTransactions('NOPE')).resolves.toEqual([]);
  });

  it.each([['failed', 'FAILED'], ['abandoned', 'CANCELLED'], ['reversed', 'FAILED'], ['ongoing', 'PENDING']])('maps %s to %s', async (status, outcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: true, data: charge({ status }) })));
    await expect(gateway.fetchTransactions('WAABC234DEFG')).resolves.toMatchObject([{ outcome }]);
  });
});
