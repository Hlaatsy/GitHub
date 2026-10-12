import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkSmsProvider } from '../src/sms/bulksms';
import { measureSms } from '../src/sms/segments';

describe('measureSms', () => {
  it('counts GSM-7 messages in 160/153-septet segments', () => {
    expect(measureSms('a'.repeat(160))).toEqual({ encoding: 'GSM7', units: 160, segments: 1 });
    expect(measureSms('a'.repeat(161))).toEqual({ encoding: 'GSM7', units: 161, segments: 2 });
    expect(measureSms('a'.repeat(306)).segments).toBe(2);
    expect(measureSms('a'.repeat(307)).segments).toBe(3);
  });

  it('counts extension characters as two septets', () => {
    expect(measureSms('€'.repeat(80))).toEqual({ encoding: 'GSM7', units: 160, segments: 1 });
    expect(measureSms('€'.repeat(81)).segments).toBe(2);
  });

  it('switches the whole message to UCS-2 for one emoji', () => {
    const text = 'Hi Mandla 👋 your booking at Glow Studio is confirmed for Mon 12 Oct 09:00';
    expect(measureSms(text)).toEqual({ encoding: 'UCS2', units: 74, segments: 2 });
    expect(measureSms('ê'.repeat(70)).segments).toBe(1);
  });

  it('keeps a typical fallback message to one segment', () => {
    const body =
      'Glow Studio Soweto: pay R125.00 to confirm Wash & Blow Mon 12 Oct 08:00: https://yourdomain.co.za/pay/h1sqQBba0kSu2ElkZDoCEt5BMkBmPw7E (valid until 01:56)';
    expect(measureSms(body)).toMatchObject({ encoding: 'GSM7', segments: 1 });
  });
});

describe('BulkSmsProvider', () => {
  const provider = new BulkSmsProvider({
    tokenId: 'TOKENID',
    tokenSecret: 'SECRET',
    baseUrl: 'https://api.bulksms.com/v1/',
    timeoutMs: 1000,
    senderId: 'GlowStudio',
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts one message with basic auth and the right encoding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([{ id: '1234', type: 'SENT' }], { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.send('27821234567', 'hello 👋', 'UCS2')).resolves.toEqual({ providerMessageId: '1234' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bulksms.com/v1/messages');
    expect(init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('TOKENID:SECRET').toString('base64')}` });
    expect(JSON.parse(init.body as string)).toEqual({ to: '+27821234567', body: 'hello 👋', encoding: 'UNICODE', from: 'GlowStudio' });
  });

  it('reports HTTP errors and unexpected bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(provider.send('27821234567', 'x', 'GSM7')).rejects.toMatchObject({ name: 'SmsError', status: 401 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true }, { status: 201 })));
    await expect(provider.send('27821234567', 'x', 'GSM7')).rejects.toThrow(/unexpected response/);
  });
});
