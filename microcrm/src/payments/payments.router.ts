import { type PaymentProvider } from '@prisma/client';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { PaymentError } from './errors';
import { type PaymentService } from './PaymentService';

export interface PaymentWebhookOptions {
  payments: Pick<PaymentService, 'handleNotification'>;
  logger: Logger;
  /** Optional source-IP allowlist (provider's published egress IPs). Requires `trust proxy` behind nginx. */
  allowedIps?: ReadonlySet<string>;
}

const MAX_BODY_BYTES = '32kb';
const RETRY_AFTER_SECONDS = '30';

function clientIp(req: Request): string {
  return (req.ip ?? '').replace(/^::ffff:/, '');
}

/**
 * Settlement endpoint for one provider, as a middleware chain for app.post():
 *
 *   app.post('/api/payments/payfast-itn', createPaymentWebhookHandler('PAYFAST', options));
 *
 * It reads its own raw body (signatures cover the exact bytes), so it must be
 * registered before any global body parser. It acknowledges only after the
 * payment is verified and recorded: a 503 tells the provider to redeliver,
 * which (with the reconciler) means a settlement is never lost to a transient fault.
 */
export function createPaymentWebhookHandler(provider: PaymentProvider, { payments, logger, allowedIps }: PaymentWebhookOptions): RequestHandler[] {
  const log = logger.child({ provider });

  const allowlist: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (allowedIps && allowedIps.size > 0 && !allowedIps.has(clientIp(req))) {
      log.warn({ ip: clientIp(req) }, 'payment webhook from non-allowlisted IP');
      res.sendStatus(403);
      return;
    }
    next();
  };

  const rawBody = express.raw({ type: ['application/x-www-form-urlencoded', 'application/json'], limit: MAX_BODY_BYTES });

  const handle: RequestHandler = async (req, res) => {
    // express.raw leaves other content types unparsed.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.sendStatus(415);
      return;
    }
    req.rawBody = req.body;
    try {
      const result = await payments.handleNotification(
        provider,
        { rawBody: req.body, contentType: req.get('content-type'), sourceIp: clientIp(req), header: (name) => req.get(name) },
        new Date(),
      );
      log.info({ result }, 'payment notification processed');
      // Rejected/ignored notifications are still acknowledged: they were
      // authentic, and redelivering them cannot change the outcome.
      res.status(200).json({ received: true });
    } catch (error) {
      if (error instanceof PaymentError) {
        if (error.code === 'SIGNATURE_INVALID') {
          log.warn({ ip: clientIp(req), reason: error.message }, 'payment webhook rejected: not authentic');
          res.sendStatus(401);
          return;
        }
        if (error.code === 'PAYLOAD_INVALID') {
          log.warn({ ip: clientIp(req), reason: error.message }, 'payment webhook rejected: invalid payload');
          res.sendStatus(400);
          return;
        }
        if (error.transient) {
          log.warn({ code: error.code }, 'payment webhook deferred; provider will redeliver');
          res.set('Retry-After', RETRY_AFTER_SECONDS).sendStatus(503);
          return;
        }
      }
      log.error({ err: error }, 'payment webhook failed');
      res.sendStatus(500);
    }
  };

  // Body-parser errors (oversized / malformed) surface here, never with a stack trace.
  const bodyErrors = (error: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (error?.type === 'entity.too.large') {
      res.sendStatus(413);
      return;
    }
    if (typeof error?.status === 'number' && error.status < 500) {
      res.sendStatus(400);
      return;
    }
    next(error);
  };

  return [allowlist, rawBody, handle, bodyErrors as unknown as RequestHandler];
}
