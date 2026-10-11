import { Router, type Request, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { type LinkResolution, type PaymentService } from './PaymentService';

export interface PayLinkRouterOptions {
  payments: Pick<PaymentService, 'resolveLink' | 'describeReturn'>;
  logger: Logger;
}

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

const COPY: Record<'paid' | 'processing' | 'expired' | 'unknown', { title: string; body: string }> = {
  paid: { title: 'Payment received ✅', body: 'You’re all set. Your confirmation is on its way in WhatsApp.' },
  processing: { title: 'Confirming your payment…', body: 'Your bank is finalising the payment. You’ll get a WhatsApp confirmation shortly.' },
  expired: { title: 'This payment link has expired', body: 'Send HI in WhatsApp to get a fresh link.' },
  unknown: { title: 'Link not found', body: 'Please use the latest link sent to you in WhatsApp.' },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(view: Extract<LinkResolution, { action: 'show' }>): string {
  const copy = COPY[view.state];
  const digits = view.waDisplayPhone?.replace(/\D/g, '');
  const back = digits ? `<p><a href="https://wa.me/${digits}">Back to WhatsApp</a></p>` : '';
  const from = view.businessName ? `<p>${escapeHtml(view.businessName)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{color:#128c7e;font-weight:600}</style></head><body><h1>${escapeHtml(copy.title)}</h1>${from}<p>${escapeHtml(copy.body)}</p>${back}</body></html>`;
}

function secureHeaders(res: Response): void {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
}

/**
 * Short links sent in WhatsApp, mounted at `/pay`. Every tap re-checks the
 * intent, so an expired or already-paid link never reaches the bank page.
 */
export function createPayLinkRouter({ payments, logger }: PayLinkRouterOptions): Router {
  const router = Router();

  const show = (res: Response, view: Extract<LinkResolution, { action: 'show' }>, status = 200) => {
    res.status(status).type('html').send(page(view));
  };

  router.get('/:token', async (req: Request, res: Response) => {
    secureHeaders(res);
    const token = req.params.token ?? '';
    if (!TOKEN.test(token)) return show(res, { action: 'show', state: 'unknown' }, 404);
    try {
      const resolution = await payments.resolveLink(token);
      if (resolution.action === 'redirect') return res.redirect(302, resolution.url);
      return show(res, resolution, resolution.state === 'unknown' ? 404 : 200);
    } catch (error) {
      logger.error({ err: error }, 'pay link resolution failed');
      return res.sendStatus(500);
    }
  });

  // Providers return the shopper via GET or a form POST; neither body nor query is trusted.
  const onReturn = async (req: Request, res: Response) => {
    secureHeaders(res);
    const token = req.params.token ?? '';
    if (!TOKEN.test(token)) return show(res, { action: 'show', state: 'unknown' }, 404);
    try {
      const view = await payments.describeReturn(token);
      return view.action === 'show' ? show(res, view) : res.sendStatus(500);
    } catch (error) {
      logger.error({ err: error }, 'pay return page failed');
      return res.sendStatus(500);
    }
  };
  router.get('/:token/return', onReturn);
  router.post('/:token/return', onReturn);

  return router;
}
