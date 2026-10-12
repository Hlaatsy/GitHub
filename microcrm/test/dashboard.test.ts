import { readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TenantFileSchema } from '../src/admin/tenantConfig';
import { createApp } from '../src/app';
import { ConversationHandlers } from '../src/bot/handlers';
import { resolveIntent } from '../src/bot/intents';
import { createDashboardRouters, readCookie, SESSION_COOKIE } from '../src/dashboard/dashboard.router';
import { type CustomerRepository } from '../src/services/customers';
import { salonTenant } from './fixtures';

const ORIGIN = 'https://crm.example.co.za';
const SESSION = 'S'.repeat(43);
const LOGIN = 'L'.repeat(43);
const BOOKING_ID = '11111111-2222-4333-8444-555555555555';
const tenant = salonTenant();

function setup() {
  const auth = {
    origin: ORIGIN,
    sessionMaxAgeSeconds: 43_200,
    isLoginTokenUsable: vi.fn(async (token: string) => token === LOGIN),
    consumeLoginToken: vi.fn(async (token: string) => (token === LOGIN ? { sessionToken: SESSION, tenantId: tenant.id } : null)),
    authenticate: vi.fn(async (token: string | undefined) => (token === SESSION ? { sessionId: 'sess-1', tenantId: tenant.id } : null)),
    revoke: vi.fn(async () => undefined),
  };
  const service = {
    me: vi.fn(() => ({ businessName: tenant.businessName })),
    summary: vi.fn(async () => ({ ok: true })),
    bookings: vi.fn(async () => []),
    orders: vi.fn(async () => []),
    payments: vi.fn(async () => []),
    wallet: vi.fn(async () => ({})),
    setAppointmentStatus: vi.fn(async () => ({ ok: true as const, status: 'CONFIRMED', customerNotified: true, refundRequired: false })),
    setOrderStatus: vi.fn(async () => ({ ok: true as const, status: 'CONFIRMED', customerNotified: true, refundRequired: false })),
  };
  const tenants = { byId: vi.fn(async (id: string) => (id === tenant.id ? tenant : null)) };
  const dashboard = createDashboardRouters({ auth, service: service as never, tenants, logger: pino({ level: 'silent' }), staticDir: path.resolve(__dirname, '..', 'public', 'dashboard') });
  const app = createApp({ appSecret: 's', verifyToken: 'verify-token-0123456789', sink: { process: vi.fn() }, logger: pino({ level: 'silent' }), dashboard });
  return { app, auth, service };
}

const cookie = `${SESSION_COOKIE}=${SESSION}`;

describe('dashboard API authentication', () => {
  it.each(['/me', '/summary', '/bookings', '/orders', '/payments', '/wallet'])('GET %s needs a session', async (route) => {
    const { app, service } = setup();
    expect((await request(app).get(`/api/dashboard${route}`)).status).toBe(401);
    expect((await request(app).get(`/api/dashboard${route}`).set('Cookie', `${SESSION_COOKIE}=${'x'.repeat(43)}`)).status).toBe(401);
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('serves data for the session tenant only, with no-store caching', async () => {
    const { app, service } = setup();
    const res = await request(app).get('/api/dashboard/bookings?range=past').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(service.bookings).toHaveBeenCalledWith(tenant, 'past');
  });

  it('refuses state changes from another origin', async () => {
    const { app, service } = setup();
    const res = await request(app)
      .post(`/api/dashboard/bookings/${BOOKING_ID}/status`)
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ status: 'CANCELLED' });
    expect(res.status).toBe(403);
    expect(service.setAppointmentStatus).not.toHaveBeenCalled();
  });

  it('accepts JSON only, so a cross-site HTML form cannot act', async () => {
    const { app, service } = setup();
    const res = await request(app)
      .post(`/api/dashboard/bookings/${BOOKING_ID}/status`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .type('form')
      .send('status=CANCELLED');
    expect(res.status).toBe(400);
    expect(service.setAppointmentStatus).not.toHaveBeenCalled();
  });

  it('validates ids and target statuses before touching data', async () => {
    const { app, service } = setup();
    const post = (url: string, body: object) => request(app).post(url).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
    expect((await post('/api/dashboard/bookings/not-a-uuid/status', { status: 'CONFIRMED' })).status).toBe(400);
    expect((await post(`/api/dashboard/bookings/${BOOKING_ID}/status`, { status: 'PENDING' })).status).toBe(400);
    expect((await post(`/api/dashboard/orders/${BOOKING_ID}/status`, { status: 'NO_SHOW' })).status).toBe(400);
    expect(service.setAppointmentStatus).not.toHaveBeenCalled();
    const ok = await post(`/api/dashboard/bookings/${BOOKING_ID}/status`, { status: 'CONFIRMED' });
    expect(ok.status).toBe(200);
    expect(service.setAppointmentStatus).toHaveBeenCalledWith(tenant, BOOKING_ID, 'CONFIRMED');
  });

  it('logout revokes the session and clears the cookie', async () => {
    const { app, auth } = setup();
    const res = await request(app).post('/api/dashboard/logout').set('Cookie', cookie).set('Origin', ORIGIN);
    expect(res.status).toBe(200);
    expect(auth.revoke).toHaveBeenCalledWith('sess-1');
    expect(res.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/);
  });
});

describe('dashboard login link', () => {
  it('GET only shows a button, so link scanners cannot use up the token', async () => {
    const { app, auth } = setup();
    const res = await request(app).get(`/dashboard/login/${LOGIN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post">');
    // no-referrer would make browsers send Origin: null on this form, failing the same-origin check.
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(auth.consumeLoginToken).not.toHaveBeenCalled();
  });

  it('POST exchanges the token for a locked-down session cookie', async () => {
    const { app } = setup();
    const res = await request(app).post(`/dashboard/login/${LOGIN}`).set('Origin', ORIGIN);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard/');
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=${SESSION}`);
    for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) expect(setCookie).toContain(flag);
  });

  it('refuses cross-site login posts (login CSRF) and spent or expired tokens', async () => {
    const { app } = setup();
    expect((await request(app).post(`/dashboard/login/${LOGIN}`).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).post(`/dashboard/login/${'X'.repeat(43)}`).set('Origin', ORIGIN)).status).toBe(410);
    expect((await request(app).get('/dashboard/login/short')).status).toBe(410);
  });

  it('serves the app shell with a script-src self CSP and no inline script', async () => {
    const { app } = setup();
    const bare = await request(app).get('/dashboard');
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe('/dashboard/');
    const res = await request(app).get('/dashboard/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.text).not.toMatch(/<script>(?!<)/);
    expect((await request(app).get('/dashboard/app.js')).status).toBe(200);
  });
});

describe('readCookie', () => {
  it('finds a cookie among others and ignores look-alikes', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE)).toBe('abc');
    expect(readCookie(`x${SESSION_COOKIE}=evil`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('LOGIN over WhatsApp', () => {
  const ctxFor = (waId: string) => ({
    tenant,
    customer: { id: 'c1', waId, displayName: null, optedOutAt: null, lastMenuSentAt: null },
    now: new Date('2026-10-12T08:00:00Z'),
  });
  const handlersWith = (recent = 0) => {
    const auth = {
      countRecentLinks: vi.fn(async () => recent),
      issueLoginLink: vi.fn(async () => ({ url: `${ORIGIN}/dashboard/login/${LOGIN}`, expiresAt: new Date('2026-10-12T08:10:00Z') })),
    };
    return { auth, handlers: new ConversationHandlers({} as never, {} as CustomerRepository, { menuCooldownMs: 0, dashboard: { auth, maxLinksPerHour: 5 } }) };
  };

  it('resolves LOGIN and DASHBOARD to the login intent', () => {
    expect(resolveIntent({ kind: 'text', text: 'Login' })).toEqual({ name: 'DASHBOARD_LOGIN' });
    expect(resolveIntent({ kind: 'text', text: 'dashboard!' })).toEqual({ name: 'DASHBOARD_LOGIN' });
  });

  it('sends the owner a one-time link button', async () => {
    const { handlers, auth } = handlersWith();
    const reply = await handlers.handle({ name: 'DASHBOARD_LOGIN' }, ctxFor(tenant.ownerWaId!));
    expect(auth.issueLoginLink).toHaveBeenCalledOnce();
    expect(reply?.message).toMatchObject({
      type: 'interactive',
      interactive: { type: 'cta_url', action: { parameters: { display_text: 'Open dashboard', url: `${ORIGIN}/dashboard/login/${LOGIN}` } } },
    });
    expect(JSON.stringify(reply?.message)).toContain('for 10 minutes');
  });

  it('never issues a link to anyone but the owner', async () => {
    const { handlers, auth } = handlersWith();
    const reply = await handlers.handle({ name: 'DASHBOARD_LOGIN' }, ctxFor('27829999999'));
    expect(auth.issueLoginLink).not.toHaveBeenCalled();
    expect(reply?.kind).toBe('MENU');
  });

  it('rate-limits link requests', async () => {
    const { handlers, auth } = handlersWith(5);
    const reply = await handlers.handle({ name: 'DASHBOARD_LOGIN' }, ctxFor(tenant.ownerWaId!));
    expect(auth.issueLoginLink).not.toHaveBeenCalled();
    expect(JSON.stringify(reply?.message)).toContain('Too many login links');
  });
});

describe('business config file', () => {
  it('accepts the documented example', () => {
    const example = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'docs', 'example-business.json'), 'utf8'));
    const parsed = TenantFileSchema.parse(example);
    expect(parsed.services[0]).toMatchObject({ name: 'Wash & Blow', price: 25000 });
    expect(parsed.depositPercent).toBe(50);
  });

  const issues = (patch: object) => {
    const example = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'docs', 'example-business.json'), 'utf8'));
    const result = TenantFileSchema.safeParse({ ...example, ...patch });
    return result.success ? '' : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  };

  it('reports local-format phone numbers and fractional cents', () => {
    const messages = issues({ ownerWaId: '082 123 4567', services: [{ name: 'A', durationMinutes: 30, price: 10.005 }] });
    expect(messages).toMatch(/ownerWaId/);
    expect(messages).toMatch(/two decimal places/);
  });

  it('reports duplicate catalog names and unknown time zones', () => {
    const messages = issues({ timezone: 'Mars/Olympus', services: [{ name: 'A', durationMinutes: 30, price: 10 }, { name: 'A', durationMinutes: 30, price: 10 }] });
    expect(messages).toMatch(/duplicate service "A"/);
    expect(messages).toMatch(/unknown time zone/);
  });
});
