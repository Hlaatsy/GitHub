import { createHash } from 'node:crypto';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayFastGateway, phpUrlencode } from '../src/payments/payfast';

const PASSPHRASE = 'jt7NOE43FZPn';
const config = {
  merchantId: '10000100',
  merchantKey: '46f0cd694581a',
  passphrase: PASSPHRASE,
  sandbox: true,
  timeoutMs: 1000,
  verifySourceIp: true,
  logger: pino({ level: 'silent' }),
  resolveHosts: async () => ['197.97.145.144', '41.74.179.194'],
};
const gateway = new PayFastGateway(config);
const FORM = 'application/x-www-form-urlencoded';

/** Independent re-implementation of PayFast's documented signature, for cross-checking. */
function md5Sign(pairs: Array<[string, string]>, passphrase = PASSPHRASE): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
  return createHash('md5').update(`${pairs.map(([k, v]) => `${k}=${enc(v)}`).join('&')}&passphrase=${enc(passphrase)}`).digest('hex');
}

function itn(overrides: Record<string, string> = {}, order?: string[]): { body: Buffer; pairs: Array<[string, string]> } {
  const fields: Record<string, string> = {
    m_payment_id: 'WAABC234DEFG',
    pf_payment_id: '1089250',
    payment_status: 'COMPLETE',
    item_name: 'Glow Studio booking deposit WAABC234DEFG',
    item_description: '',
    amount_gross: '125.00',
    amount_fee: '-2.88',
    amount_net: '122.12',
    custom_str1: '',
    name_first: '',
    name_last: '',
    email_address: '',
    merchant_id: config.merchantId,
    ...overrides,
  };
  const keys = order ?? Object.keys(fields);
  const pairs = keys.map((k) => [k, fields[k] ?? ''] as [string, string]);
  const signature = overrides.signature ?? md5Sign(pairs);
  const all: Array<[string, string]> = [...pairs.filter(([k]) => k !== 'signature'), ['signature', signature]];
  return { body: Buffer.from(new URLSearchParams(all).toString()), pairs: all };
}

const ctx = (body: Buffer, sourceIp = '197.97.145.144') => ({ rawBody: body, contentType: FORM, sourceIp, header: () => undefined });

afterEach(() => vi.unstubAllGlobals());

describe('phpUrlencode', () => {
  it('matches PHP urlencode for the characters encodeURIComponent leaves alone', () => {
    expect(phpUrlencode("Glow & Co's (best) deal!*~")).toBe('Glow+%26+Co%27s+%28best%29+deal%21%2A%7E');
    expect(phpUrlencode('https://x.co.za/pay?a=1')).toBe('https%3A%2F%2Fx.co.za%2Fpay%3Fa%3D1');
  });
});

describe('PayFast checkout', () => {
  it('produces a signed form in documented field order, posted to the sandbox', async () => {
    const created = await gateway.createPayment({
      reference: 'WAABC234DEFG',
      amountCents: 12500,
      description: '  Glow Studio   booking deposit WAABC234DEFG ',
      notifyUrl: 'https://crm.example.co.za/api/payments/payfast-itn',
      successUrl: 'https://crm.example.co.za/pay/t/return?result=success',
      cancelUrl: 'https://crm.example.co.za/pay/t/return?result=cancelled',
      errorUrl: 'https://crm.example.co.za/pay/t/return?result=error',
    });
    if (created.checkout.method !== 'POST') throw new Error('expected a form');
    expect(created.checkout.url).toBe('https://sandbox.payfast.co.za/eng/process');
    const { signature, ...fields } = created.checkout.fields;
    expect(Object.keys(fields)).toEqual(['merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url', 'm_payment_id', 'amount', 'item_name']);
    expect(fields.amount).toBe('125.00');
    expect(fields.item_name).toBe('Glow Studio booking deposit WAABC234DEFG');
    expect(signature).toBe(md5Sign(Object.entries(fields)));
  });
});

describe('PayFast ITN verification', () => {
  it('accepts a correctly signed ITN from a PayFast address', async () => {
    await expect(gateway.verifyNotification(ctx(itn().body))).resolves.toEqual({
      reference: 'WAABC234DEFG',
      providerTransactionId: '1089250',
      outcome: 'SUCCESSFUL',
      rawStatus: 'COMPLETE',
      amountCents: 12500,
      currency: 'ZAR',
    });
  });

  it('verifies in the order received, including empty fields', async () => {
    const reordered = itn({}, ['merchant_id', 'amount_gross', 'm_payment_id', 'pf_payment_id', 'payment_status', 'custom_str1', 'item_name']);
    await expect(gateway.verifyNotification(ctx(reordered.body))).resolves.toMatchObject({ outcome: 'SUCCESSFUL' });
  });

  it('rejects an amount changed after signing', async () => {
    const { pairs } = itn();
    const tampered = Buffer.from(new URLSearchParams(pairs.map(([k, v]): [string, string] => [k, k === 'amount_gross' ? '1.00' : v])).toString());
    await expect(gateway.verifyNotification(ctx(tampered))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('rejects a signature made without the passphrase', async () => {
    const { pairs } = itn();
    const unsigned = pairs.filter(([k]) => k !== 'signature');
    const body = Buffer.from(new URLSearchParams([...unsigned, ['signature', md5Sign(unsigned, '')]]).toString());
    await expect(gateway.verifyNotification(ctx(body))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('rejects a genuine ITN replayed from a non-PayFast address', async () => {
    await expect(gateway.verifyNotification(ctx(itn().body, '203.0.113.9'))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('defers (transient) when PayFast hosts cannot be resolved', async () => {
    const failing = new PayFastGateway({ ...config, resolveHosts: async () => { throw new Error('ENOTFOUND'); } });
    await expect(failing.verifyNotification(ctx(itn().body))).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE', transient: true });
  });

  it('rejects other merchants, duplicate fields and JSON bodies', async () => {
    await expect(gateway.verifyNotification(ctx(itn({ merchant_id: '99999' }).body))).rejects.toMatchObject({ code: 'PAYLOAD_INVALID' });
    const dup = Buffer.from(`${itn().body.toString()}&payment_status=COMPLETE`);
    await expect(gateway.verifyNotification(ctx(dup))).rejects.toMatchObject({ code: 'PAYLOAD_INVALID' });
    await expect(gateway.verifyNotification({ ...ctx(itn().body), contentType: 'application/json' })).rejects.toMatchObject({ code: 'PAYLOAD_INVALID' });
  });

  it('confirms with PayFast validate, posting the fields without the signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('VALID'));
    vi.stubGlobal('fetch', fetchMock);
    const { body } = itn();
    const tx = await gateway.verifyNotification(ctx(body));
    await expect(gateway.confirmTransaction(tx!, ctx(body))).resolves.toBe(tx);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.payfast.co.za/eng/query/validate');
    expect(String(init.body)).not.toContain('signature=');
    expect(String(init.body)).toContain('amount_gross=125.00');

    fetchMock.mockResolvedValue(new Response('INVALID'));
    await expect(gateway.confirmTransaction(tx!, ctx(body))).resolves.toBeNull();
  });
});
