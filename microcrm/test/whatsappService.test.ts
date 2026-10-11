import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppApiError, WhatsAppService } from '../src/whatsapp/WhatsAppService';

const service = new WhatsAppService({
  accessToken: 'token',
  graphVersion: 'v20.0',
  baseUrl: 'https://graph.facebook.com/',
  timeoutMs: 1000,
  logger: pino({ level: 'silent' }),
});

const ok = () =>
  new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: '27821234567', wa_id: '27821234567' }], messages: [{ id: 'wamid.OUT' }] }), {
    status: 200,
  });
const graphError = (status: number, code: number) =>
  new Response(JSON.stringify({ error: { message: 'nope', code, fbtrace_id: 'trace' } }), { status, headers: { 'retry-after': '0' } });

afterEach(() => vi.unstubAllGlobals());

describe('WhatsAppService', () => {
  it('posts an interactive message to the versioned messages endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const sent = await service.sendInteractive('PHONE_ID', '27821234567', {
      type: 'button',
      body: { text: 'Hi' },
      action: { buttons: [{ type: 'reply', reply: { id: 'menu:book', title: 'Book' } }] },
    });

    expect(sent).toEqual({ wamid: 'wamid.OUT', waId: '27821234567' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v20.0/PHONE_ID/messages');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '27821234567',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Hi' },
        action: { buttons: [{ type: 'reply', reply: { id: 'menu:book', title: 'Book' } }] },
      },
    });
  });

  it('sends text with link previews disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    await service.sendText('PHONE_ID', '27821234567', 'See https://example.com');
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.text).toEqual({ body: 'See https://example.com', preview_url: false });
  });

  it('retries once when throttled, since nothing was sent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(graphError(429, 130429)).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.sendText('PHONE_ID', '27821234567', 'hi')).resolves.toMatchObject({ wamid: 'wamid.OUT' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry server errors, which may already have been delivered', async () => {
    const fetchMock = vi.fn().mockResolvedValue(graphError(500, 1));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.sendText('PHONE_ID', '27821234567', 'hi')).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
