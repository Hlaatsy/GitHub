import express, { Router, type Request, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { type WebhookSink } from './processor';
import { parseWebhookPayload } from './schema';
import { secretsMatch, verifyMetaSignature } from './signature';

export interface WhatsAppWebhookRouterOptions {
  appSecret: string;
  verifyToken: string;
  sink: WebhookSink;
  logger: Logger;
}

const MAX_BODY_BYTES = '512kb';
const CHALLENGE_PATTERN = /^[\w-]{1,128}$/;

/**
 * Mount at `/webhooks/whatsapp`, before any global JSON body parser: the
 * signature is computed over the exact raw bytes Meta sent.
 */
export function createWhatsAppWebhookRouter(options: WhatsAppWebhookRouterOptions): Router {
  const { appSecret, verifyToken, sink, logger } = options;
  const router = Router();

  // Subscription handshake from the Meta App Dashboard.
  router.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      secretsMatch(token, verifyToken) &&
      typeof challenge === 'string' &&
      CHALLENGE_PATTERN.test(challenge)
    ) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  router.post('/', express.raw({ type: () => true, limit: MAX_BODY_BYTES }), (req: Request, res: Response) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!verifyMetaSignature(rawBody, req.get('x-hub-signature-256'), appSecret)) {
      logger.warn({ ip: req.ip }, 'whatsapp webhook rejected: bad signature');
      res.sendStatus(401);
      return;
    }

    let payload;
    try {
      payload = parseWebhookPayload(JSON.parse(rawBody.toString('utf8')));
    } catch {
      res.sendStatus(400);
      return;
    }

    // Acknowledge before doing any work. Meta retries slow or failed
    // deliveries, and every retry is a chance to send (and pay for) a
    // duplicate reply; the inbound ledger catches any that still arrive.
    res.sendStatus(200);
    setImmediate(() => {
      sink.process(payload).catch((err: unknown) => logger.error({ err }, 'whatsapp webhook processing failed'));
    });
  });

  return router;
}
