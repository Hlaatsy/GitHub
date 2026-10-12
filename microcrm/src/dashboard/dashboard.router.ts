import path from 'node:path';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { type TenantDirectory, type TenantProfile } from '../services/tenants';
import { type DashboardAuth } from './DashboardAuth';
import { type DashboardService } from './DashboardService';

export interface DashboardRouterOptions {
  auth: Pick<DashboardAuth, 'origin' | 'sessionMaxAgeSeconds' | 'isLoginTokenUsable' | 'consumeLoginToken' | 'authenticate' | 'revoke'>;
  service: Pick<
    DashboardService,
    'me' | 'summary' | 'bookings' | 'orders' | 'payments' | 'wallet' | 'setAppointmentStatus' | 'setOrderStatus'
  >;
  tenants: Pick<TenantDirectory, 'byId'>;
  logger: Logger;
  /** Directory holding index.html, app.js and app.css. */
  staticDir?: string;
}

/** __Host- prefix: browsers only accept it with Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-crm_session';
const LOGIN_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPOINTMENT_TARGETS = new Set(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']);
const ORDER_TARGETS = new Set(['CONFIRMED', 'FULFILLED', 'CANCELLED']);

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function baseHeaders(res: Response, csp: string): void {
  res.set({
    'Cache-Control': 'no-store',
    // Not no-referrer: under that policy browsers send `Origin: null` on our own
    // form posts and fetches, which the same-origin check rightly refuses.
    // same-origin still sends nothing to other sites.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': csp,
  });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function simplePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 16px;color:#1d2329;background:#f6f7f9}@media (prefers-color-scheme:dark){body{color:#e8edf1;background:#0f1418}}button{background:#128c7e;color:#fff;border:0;border-radius:8px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer}</style></head><body>${body}</body></html>`;
}

const EXPIRED = simplePage(
  'Link expired',
  '<h1>This login link has expired</h1><p>Login links work once and only for a few minutes. Send <strong>LOGIN</strong> to your business WhatsApp number from your own phone to get a new one.</p>',
);

export function createDashboardRouters(options: DashboardRouterOptions): { pages: Router; api: Router } {
  const { auth, service, tenants, logger } = options;

  /** Browsers send Origin on every cross-site POST; anything but our own origin is refused. */
  const sameOrigin = (req: Request): boolean => {
    const origin = req.get('origin');
    return origin === undefined ? req.get('sec-fetch-site') !== 'cross-site' : origin === auth.origin;
  };

  // ---------------------------------------------------------------- pages
  const pages = Router();

  // GET only renders a button: link scanners and previews must not use up the single-use token.
  pages.get('/login/:token', async (req, res) => {
    baseHeaders(res, PAGE_CSP);
    const token = req.params.token ?? '';
    try {
      if (!LOGIN_TOKEN.test(token) || !(await auth.isLoginTokenUsable(token))) return res.status(410).type('html').send(EXPIRED);
      return res.type('html').send(
        simplePage(
          'Log in',
          `<h1>Open your dashboard</h1><p>This link was sent to your WhatsApp. It works once.</p><form method="post"><button type="submit">Continue to dashboard</button></form>`,
        ),
      );
    } catch (error) {
      logger.error({ err: error }, 'dashboard login page failed');
      return res.sendStatus(500);
    }
  });

  pages.post('/login/:token', async (req, res) => {
    baseHeaders(res, PAGE_CSP);
    const token = req.params.token ?? '';
    if (!sameOrigin(req)) return res.sendStatus(403);
    try {
      const session = LOGIN_TOKEN.test(token) ? await auth.consumeLoginToken(token) : null;
      if (!session) return res.status(410).type('html').send(EXPIRED);
      res.set('Set-Cookie', sessionCookie(session.sessionToken, auth.sessionMaxAgeSeconds));
      logger.info({ tenantId: session.tenantId }, 'dashboard login');
      return res.redirect(303, '/dashboard/');
    } catch (error) {
      logger.error({ err: error }, 'dashboard login failed');
      return res.sendStatus(500);
    }
  });

  const staticDir = options.staticDir ?? path.resolve(__dirname, '..', '..', 'public', 'dashboard');
  pages.use((_req, res, next) => {
    baseHeaders(res, APP_CSP);
    next();
  });
  pages.use(express.static(staticDir, { index: 'index.html', fallthrough: true, dotfiles: 'deny', etag: false }));

  // ---------------------------------------------------------------- API
  const api = Router();
  api.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });

  type AuthedRequest = Request & { tenant?: TenantProfile; sessionId?: string };

  api.use(async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const identity = await auth.authenticate(readCookie(req.get('cookie'), SESSION_COOKIE));
      const tenant = identity ? await tenants.byId(identity.tenantId) : null;
      if (!identity || !tenant) {
        res.status(401).json({ error: 'UNAUTHENTICATED' });
        return;
      }
      if (req.method !== 'GET' && !sameOrigin(req)) {
        res.status(403).json({ error: 'CROSS_ORIGIN' });
        return;
      }
      req.tenant = tenant;
      req.sessionId = identity.sessionId;
      next();
    } catch (error) {
      next(error);
    }
  });
  // Only JSON bodies: a cross-site HTML form cannot produce one without a CORS preflight.
  api.use(express.json({ limit: '4kb', type: 'application/json' }));

  const handle =
    (fn: (req: AuthedRequest, tenant: TenantProfile) => Promise<unknown> | unknown) => async (req: AuthedRequest, res: Response) => {
      try {
        res.json(await fn(req, req.tenant as TenantProfile));
      } catch (error) {
        logger.error({ err: error, tenantId: req.tenant?.id }, 'dashboard API failed');
        res.status(500).json({ error: 'INTERNAL' });
      }
    };

  api.get('/me', handle((_req, tenant) => service.me(tenant)));
  api.get('/summary', handle((_req, tenant) => service.summary(tenant)));
  api.get('/bookings', handle((req, tenant) => {
    const range = req.query.range === 'today' || req.query.range === 'past' ? req.query.range : 'upcoming';
    return service.bookings(tenant, range);
  }));
  api.get('/orders', handle((req, tenant) => service.orders(tenant, req.query.filter === 'all' ? 'all' : 'open')));
  api.get('/payments', handle((req, tenant) => {
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
    return service.payments(tenant, before && !Number.isNaN(before.getTime()) ? before : undefined);
  }));
  api.get('/wallet', handle((_req, tenant) => service.wallet(tenant)));

  const statusAction =
    (targets: ReadonlySet<string>, run: (tenant: TenantProfile, id: string, to: string) => Promise<{ ok: boolean; error?: string }>) =>
    async (req: AuthedRequest, res: Response) => {
      const id = req.params.id ?? '';
      const to = (req.body as { status?: unknown } | undefined)?.status;
      if (!UUID.test(id) || typeof to !== 'string' || !targets.has(to)) {
        res.status(400).json({ error: 'BAD_REQUEST' });
        return;
      }
      try {
        const result = await run(req.tenant as TenantProfile, id, to);
        res.status(result.ok ? 200 : result.error === 'NOT_FOUND' ? 404 : 409).json(result);
      } catch (error) {
        logger.error({ err: error, tenantId: req.tenant?.id }, 'dashboard action failed');
        res.status(500).json({ error: 'INTERNAL' });
      }
    };
  api.post('/bookings/:id/status', statusAction(APPOINTMENT_TARGETS, (t, id, to) => service.setAppointmentStatus(t, id, to as never)));
  api.post('/orders/:id/status', statusAction(ORDER_TARGETS, (t, id, to) => service.setOrderStatus(t, id, to as never)));

  api.post('/logout', async (req: AuthedRequest, res: Response) => {
    await auth.revoke(req.sessionId as string);
    res.set('Set-Cookie', sessionCookie('', 0)).json({ ok: true });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });
  return { pages, api };
}
