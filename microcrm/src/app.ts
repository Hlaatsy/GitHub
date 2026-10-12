import express, { type Express } from 'express';
import { type Logger } from './lib/logger';
import { type createDashboardRouters } from './dashboard/dashboard.router';
import { createOnboardingRouter } from './onboarding/onboarding.router';
import { type OnboardingService } from './onboarding/OnboardingService';
import { createPayLinkRouter } from './payments/payLink.router';
import { createPaymentsWebhookRouter } from './payments/payments.router';
import { type PaymentService } from './payments/PaymentService';
import { type WebhookSink } from './webhooks/processor';
import { createWhatsAppWebhookRouter } from './webhooks/whatsapp.router';

export interface AppOptions {
  appSecret: string;
  verifyToken: string;
  sink: WebhookSink;
  logger: Logger;
  payments?: {
    service: Pick<PaymentService, 'handleNotification' | 'resolveLink' | 'describeReturn'>;
    allowedIps?: ReadonlySet<string>;
  };
  onboarding?: Pick<OnboardingService, 'resolve' | 'checklist' | 'sendTestPayment'>;
  dashboard?: ReturnType<typeof createDashboardRouters>;
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
  if (options.payments) {
    const { service, allowedIps } = options.payments;
    app.use(
      '/webhooks/payments',
      createPaymentsWebhookRouter({ payments: service, logger: options.logger, ...(allowedIps ? { allowedIps } : {}) }),
    );
    app.use('/pay', createPayLinkRouter({ payments: service, logger: options.logger }));
  }
  if (options.dashboard) {
    // Express matches '/dashboard/' here too; only redirect the exact slash-less path.
    app.get('/dashboard', (req, res, next) => (req.path === '/dashboard' && !req.originalUrl.startsWith('/dashboard/') ? res.redirect(301, '/dashboard/') : next()));
    app.use('/dashboard', options.dashboard.pages);
    app.use('/api/dashboard', options.dashboard.api);
  }
  if (options.onboarding) {
    app.use('/onboarding', createOnboardingRouter({ onboarding: options.onboarding, logger: options.logger }));
  }

  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res) => {
    res.sendStatus(404);
  });

  return app;
}
