import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { type Logger } from '../lib/logger';
import { type WebhookSink } from './processor';
import { parseWebhookPayload } from './schema';
import { secretsMatch, verifyMetaSignature } from './signature';

export interface WhatsAppWebhookOptions {
  appSecret: string;
  verifyToken: string;
  sink: WebhookSink;
  logger: Logger;
}

export interface WhatsAppWebhookHandlers {
  /** GET: Meta's subscription handshake. */
  verifyMetaWebhookHandshake: RequestHandler;
  /** POST step 1: reads the exact body bytes into `req.rawBody`, for any content type. */
  captureRawBody: RequestHandler;
  /** POST step 2: X-Hub-Signature-256 over `req.rawBody`; refuses with 401. */
  verifyWhatsAppSignature: RequestHandler;
  /** POST step 3: validates the payload, acknowledges, then processes in the background. */
  handleWhatsAppWebhook: RequestHandler;
}

const MAX_BODY_BYTES = '512kb';
const CHALLENGE_PATTERN = /^[\w-]{1,128}$/;

/**
 * The Meta webhook as three explicit middleware steps, registered in app.ts as:
 *
 *   app.get('/webhooks/whatsapp', verifyMetaWebhookHandshake);
 *   app.post('/webhooks/whatsapp', captureRawBody, verifyWhatsAppSignature, handleWhatsAppWebhook);
 *
 * Register these before any global body parser: once express.json() has
 * consumed the stream, the raw bytes Meta signed are gone.
 */
export function createWhatsAppWebhookHandlers({ appSecret, verifyToken, sink, logger }: WhatsAppWebhookOptions): WhatsAppWebhookHandlers {
  const rawParser = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

  return {
    verifyMetaWebhookHandshake(req: Request, res: Response) {
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
    },

    captureRawBody(req: Request, res: Response, next: NextFunction) {
      rawParser(req, res, (error?: unknown) => {
        if (error) return next(error);
        req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        next();
      });
    },

    verifyWhatsAppSignature(req: Request, res: Response, next: NextFunction) {
      if (!req.rawBody || !verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), appSecret)) {
        logger.warn({ ip: req.ip }, 'whatsapp webhook rejected: bad signature');
        res.sendStatus(401);
        return;
      }
      next();
    },

    handleWhatsAppWebhook(req: Request, res: Response) {
      let payload;
      try {
        payload = parseWebhookPayload(JSON.parse((req.rawBody ?? Buffer.alloc(0)).toString('utf8')));
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
    },
  };
}
