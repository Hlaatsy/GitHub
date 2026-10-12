import { Router, type Request, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { SlidingWindowLimiter } from '../lib/rateLimiter';
import { type Checklist, type OnboardingService, type StepState, type TestPaymentResult } from './OnboardingService';

export interface OnboardingRouterOptions {
  onboarding: Pick<OnboardingService, 'resolve' | 'checklist' | 'sendTestPayment'>;
  logger: Logger;
}

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const REFRESH_SECONDS = 10;

const BADGES: Record<StepState, { icon: string; label: string; cls: string }> = {
  done: { icon: '✅', label: 'Done', cls: 'done' },
  waiting: { icon: '⏳', label: 'In progress', cls: 'waiting' },
  todo: { icon: '⬜', label: 'To do', cls: 'todo' },
  blocked: { icon: '🔒', label: 'Waiting on an earlier step', cls: 'blocked' },
};

/** Fixed notices only: query strings are never echoed into the page. */
const NOTICES: Record<TestPaymentResult, string> = {
  sent: 'Test payment link sent. Check your WhatsApp.',
  already_waiting: 'A test link is already waiting in your WhatsApp.',
  blocked: 'Finish the earlier steps before sending a test payment.',
  failed: 'We could not send the test link. Please try again in a minute.',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function renderPage(token: string, checklist: Checklist, notice: string | null): string {
  const done = checklist.steps.filter((step) => step.state === 'done').length;
  const steps = checklist.steps
    .map((step, index) => {
      const badge = BADGES[step.state];
      const action =
        step.key === 'test_payment' && checklist.canSendTestPayment
          ? `<form method="post" action="/onboarding/${token}/test-payment"><button type="submit">Send me a test payment link</button></form>`
          : '';
      return `<li class="${badge.cls}"><div class="row"><span class="num">${index + 1}</span><h2>${escapeHtml(step.title)}</h2><span class="badge">${badge.icon} ${badge.label}</span></div>${step.detail
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('')}${action}</li>`;
    })
    .join('');
  const refresh = checklist.waiting ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Setup checklist</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#5d6873;--line:#dfe3e8;--accent:#128c7e;--ok:#1a7f37;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#182026;--text:#e8edf1;--muted:#9aa7b2;--line:#2a343c;--accent:#25d3b8;--ok:#4ac26b;--warn:#d4a72c}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0}.sub{color:var(--muted);margin:4px 0 20px}
.notice{background:var(--card);border-left:4px solid var(--accent);padding:10px 14px;border-radius:6px;margin-bottom:16px}
ol{list-style:none;padding:0;margin:0;display:grid;gap:12px}
li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}h2{font-size:1rem;margin:0;flex:1}
.num{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:.8rem;border:1px solid var(--line);color:var(--muted)}
.badge{font-size:.8rem;color:var(--muted)}li.done .badge{color:var(--ok)}li.waiting .badge{color:var(--warn)}
li p{margin:6px 0 0 34px;color:var(--muted);overflow-wrap:anywhere}li.blocked{opacity:.7}
form{margin:10px 0 0 34px}button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><main><h1>${escapeHtml(checklist.businessName)}: WhatsApp setup</h1><p class="sub">${done} of ${checklist.steps.length} steps done${checklist.waiting ? ' · this page refreshes by itself' : ''}</p>${
    notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''
  }<ol>${steps}</ol></main></body></html>`;
}

function secureHeaders(res: Response): void {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

const EXPIRED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 16px"><h1>This setup link has expired</h1><p>Ask support for a new one.</p></body></html>';

/**
 * Owner-only setup checklist, mounted at `/onboarding`. The unguessable link
 * is the credential (only its hash is stored), so the page shows the
 * business's own setup state and never any customer's personal information.
 */
export function createOnboardingRouter({ onboarding, logger }: OnboardingRouterOptions): Router {
  const router = Router();
  // At most 3 test sends per tenant per 10 minutes, whatever the page does.
  const limiter = new SlidingWindowLimiter(3, 10 * 60_000);

  router.get('/:token', async (req: Request, res: Response) => {
    secureHeaders(res);
    const token = req.params.token ?? '';
    try {
      const tenant = TOKEN.test(token) ? await onboarding.resolve(token) : null;
      if (!tenant) return res.status(404).type('html').send(EXPIRED_PAGE);
      const result = typeof req.query.result === 'string' && req.query.result in NOTICES ? (req.query.result as TestPaymentResult) : null;
      return res.type('html').send(renderPage(token, await onboarding.checklist(tenant), result ? NOTICES[result] : null));
    } catch (error) {
      logger.error({ err: error }, 'onboarding page failed');
      return res.sendStatus(500);
    }
  });

  router.post('/:token/test-payment', async (req: Request, res: Response) => {
    secureHeaders(res);
    const token = req.params.token ?? '';
    try {
      const tenant = TOKEN.test(token) ? await onboarding.resolve(token) : null;
      if (!tenant) return res.status(404).type('html').send(EXPIRED_PAGE);
      const result = limiter.allow(tenant.id) ? await onboarding.sendTestPayment(tenant) : 'already_waiting';
      // Post/redirect/get, so a refresh never sends a second link.
      return res.redirect(303, `/onboarding/${token}?result=${result}`);
    } catch (error) {
      logger.error({ err: error }, 'onboarding test payment failed');
      return res.redirect(303, `/onboarding/${token}?result=failed`);
    }
  });

  return router;
}
