import express, { Router, type Request, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { PaymentError } from './errors';
import { type PaymentService } from './PaymentService';

export interface PaymentsWebhookRouterOptions {
  payments: Pick<PaymentService, 'handleNotification'>;
  logger: Logger;
  /** Optional source-IP allowlist (provider's published egress IPs). Requires `trust proxy` behind nginx. */
  allowedIps?: ReadonlySet<string>;
}

const MAX_BODY_BYTES = '32kb';
const ACCEPTED_TYPES = ['application/x-www-form-urlencoded', 'application/json'];
const RETRY_AFTER_SECONDS = '30';

function clientIp(req: Request): string {
  return (req.ip ?? '').replace(/^::ffff:/, '');
}

/**
 * Public settlement endpoint, mounted at `/webhooks/payments`.
 *
 * Unlike the WhatsApp webhook, it acknowledges only after the payment is
 * verified and recorded: a 503 tells the provider to redeliver, which (with
 * the reconciler) guarantees a settlement is never lost to a transient fault.
 */
export function createPaymentsWebhookRouter({ payments, logger, allowedIps }: PaymentsWebhookRouterOptions): Router {
  const router = Router();

  router.post('/', express.raw({ type: ACCEPTED_TYPES, limit: MAX_BODY_BYTES }), async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');

    if (allowedIps && allowedIps.size > 0 && !allowedIps.has(clientIp(req))) {
      logger.warn({ ip: clientIp(req) }, 'payment webhook from non-allowlisted IP');
      res.sendStatus(403);
      return;
    }
    // express.raw leaves non-matching content types unparsed.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.sendStatus(415);
      return;
    }

    try {
      const result = await payments.handleNotification(req.body, req.get('content-type'), new Date());
      logger.info({ result }, 'payment notification processed');
      // Rejected/ignored notifications are still acknowledged: they were
      // authentic, and redelivering them cannot change the outcome.
      res.status(200).json({ received: true });
    } catch (error) {
      if (error instanceof PaymentError) {
        if (error.code === 'SIGNATURE_INVALID') {
          logger.warn({ ip: clientIp(req) }, 'payment webhook rejected: invalid signature');
          res.sendStatus(401);
          return;
        }
        if (error.code === 'PAYLOAD_INVALID') {
          logger.warn({ ip: clientIp(req), reason: error.message }, 'payment webhook rejected: invalid payload');
          res.sendStatus(400);
          return;
        }
        if (error.transient) {
          logger.warn({ code: error.code }, 'payment webhook deferred; provider will redeliver');
          res.set('Retry-After', RETRY_AFTER_SECONDS).sendStatus(503);
          return;
        }
      }
      logger.error({ err: error }, 'payment webhook failed');
      res.sendStatus(500);
    }
  });

  // Body-parser errors (oversized / malformed) surface here, never with a stack trace.
  router.use((error: { status?: number; type?: string }, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (error?.type === 'entity.too.large') {
      res.sendStatus(413);
      return;
    }
    if (typeof error?.status === 'number' && error.status < 500) {
      res.sendStatus(400);
      return;
    }
    next(error);
  });

  return router;
}
