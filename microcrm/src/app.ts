import express, { type Express } from 'express';
import { type Logger } from './lib/logger';
import { type WebhookSink } from './webhooks/processor';
import { createWhatsAppWebhookRouter } from './webhooks/whatsapp.router';

export interface AppOptions {
  appSecret: string;
  verifyToken: string;
  sink: WebhookSink;
  logger: Logger;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Raw-body route first: it must see the request before any JSON parser.
  app.use('/webhooks/whatsapp', createWhatsAppWebhookRouter(options));

  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res) => {
    res.sendStatus(404);
  });

  return app;
}
