import { ConversationHandlers } from './bot/handlers';
import { loadEnv, paymentsEnv, smsEnv } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { createPrismaClient } from './lib/prisma';
import { SlidingWindowLimiter } from './lib/rateLimiter';
import { OzowGateway } from './payments/ozow';
import { PaymentService } from './payments/PaymentService';
import { CustomerRepository } from './services/customers';
import { InboundLedger } from './services/inboundLedger';
import { OutboundMessenger } from './services/messenger';
import { TenantDirectory } from './services/tenants';
import { WalletService } from './services/wallet';
import { BulkSmsProvider } from './sms/bulksms';
import { SmsFallbackService } from './sms/SmsFallbackService';
import { DashboardAuth } from './dashboard/DashboardAuth';
import { createDashboardRouters } from './dashboard/dashboard.router';
import { DashboardService } from './dashboard/DashboardService';
import { OnboardingService } from './onboarding/OnboardingService';
import { WebhookProcessor } from './webhooks/processor';
import { TemplateService } from './whatsapp/templates/TemplateService';
import { WhatsAppService } from './whatsapp/WhatsAppService';

async function main(): Promise<void> {
  const env = loadEnv();
  const paymentConfig = paymentsEnv(env);
  const smsConfig = smsEnv(env);
  const prisma = createPrismaClient();

  const whatsapp = new WhatsAppService({
    accessToken: env.WA_ACCESS_TOKEN,
    graphVersion: env.WA_GRAPH_VERSION,
    baseUrl: env.WA_GRAPH_BASE_URL,
    timeoutMs: env.WA_HTTP_TIMEOUT_MS,
    logger,
  });
  const customers = new CustomerRepository(prisma);
  const tenants = new TenantDirectory(prisma, logger);
  const limiter = new SlidingWindowLimiter(env.CUSTOMER_MAX_EVENTS_PER_MINUTE, 60_000);
  const wallet = new WalletService(prisma);
  const messenger = new OutboundMessenger({
    prisma,
    whatsapp,
    wallet,
    logger,
    costs: {
      serviceCents: env.COST_SERVICE_MESSAGE_CENTS,
      utilityTemplateCents: env.COST_UTILITY_TEMPLATE_CENTS,
    },
    lowBalanceTemplate: env.WA_LOW_BALANCE_TEMPLATE,
    templateLanguage: env.WA_TEMPLATE_LANGUAGE,
  });

  const payments = paymentConfig
    ? new PaymentService(
        {
          prisma,
          gateway: new OzowGateway({ ...paymentConfig.ozow, logger }),
          messenger,
          tenants,
          logger,
        },
        {
          publicBaseUrl: paymentConfig.publicBaseUrl,
          linkTtlMinutes: env.PAYMENT_LINK_TTL_MINUTES,
          maxAmountCents: env.PAYMENT_MAX_CENTS,
          confirmationTemplate: env.WA_PAYMENT_CONFIRMED_TEMPLATE,
          templateLanguage: env.WA_TEMPLATE_LANGUAGE,
        },
      )
    : null;

  const templates = new TemplateService(prisma, whatsapp, logger);
  const onboarding = env.PUBLIC_BASE_URL?.startsWith('https://')
    ? new OnboardingService(
        { prisma, tenants, messenger, payments, logger },
        {
          publicBaseUrl: env.PUBLIC_BASE_URL,
          linkTtlHours: env.ONBOARDING_LINK_TTL_HOURS,
          testAmountCents: env.ONBOARDING_TEST_AMOUNT_CENTS,
          templateLanguage: env.WA_TEMPLATE_LANGUAGE,
          requestTemplate: env.WA_PAYMENT_REQUEST_TEMPLATE,
          requiredTemplates: [env.WA_PAYMENT_REQUEST_TEMPLATE, env.WA_PAYMENT_CONFIRMED_TEMPLATE, env.WA_LOW_BALANCE_TEMPLATE],
        },
      )
    : null;

  const dashboardAuth = env.PUBLIC_BASE_URL?.startsWith('https://')
    ? new DashboardAuth(prisma, {
        publicBaseUrl: env.PUBLIC_BASE_URL,
        loginLinkTtlMinutes: env.DASHBOARD_LOGIN_LINK_MINUTES,
        sessionHours: env.DASHBOARD_SESSION_HOURS,
        idleMinutes: env.DASHBOARD_IDLE_MINUTES,
      })
    : null;

  // SMS only ever re-sends pay links, so it needs payments enabled too.
  const smsFallback =
    smsConfig && paymentConfig
      ? new SmsFallbackService(
          { prisma, provider: new BulkSmsProvider(smsConfig), wallet, messenger, logger },
          { publicBaseUrl: paymentConfig.publicBaseUrl, costPerSegmentCents: smsConfig.costPerSegmentCents },
        )
      : null;
  if (smsConfig && !paymentConfig) logger.warn('BulkSMS is configured but payments are not; SMS fallback stays off');

  const processor = new WebhookProcessor({
    tenants,
    customers,
    ledger: new InboundLedger(prisma),
    handlers: new ConversationHandlers(prisma, customers, {
      menuCooldownMs: env.MENU_COOLDOWN_SECONDS * 1000,
      ...(dashboardAuth ? { dashboard: { auth: dashboardAuth, maxLinksPerHour: env.DASHBOARD_MAX_LINKS_PER_HOUR } } : {}),
      ...(payments
        ? {
            payments: {
              service: payments,
              holdMinutes: env.PAYMENT_LINK_TTL_MINUTES,
              requestTemplate: env.WA_PAYMENT_REQUEST_TEMPLATE,
              templateLanguage: env.WA_TEMPLATE_LANGUAGE,
              logger,
            },
          }
        : {}),
    }),
    messenger,
    whatsapp,
    limiter,
    logger,
    markAsRead: env.WA_MARK_AS_READ,
    staleAfterMs: env.STALE_MESSAGE_SECONDS * 1000,
    ...(smsFallback ? { onFailedStatus: (tenant, status, now) => smsFallback.handleFailedStatus(tenant, status, now) } : {}),
    onTemplateStatus: (wabaId, value) => templates.applyStatusUpdate(wabaId, value),
  });

  const app = createApp({
    appSecret: env.WA_APP_SECRET,
    verifyToken: env.WA_VERIFY_TOKEN,
    sink: processor,
    logger,
    ...(payments && paymentConfig ? { payments: { service: payments, allowedIps: paymentConfig.allowedIps } } : {}),
    ...(onboarding ? { onboarding } : {}),
    ...(dashboardAuth
      ? {
          dashboard: createDashboardRouters({
            auth: dashboardAuth,
            service: new DashboardService(prisma, messenger, logger),
            tenants,
            logger,
          }),
        }
      : {}),
  });

  // Catches missed settlement webhooks, expires abandoned links and retries
  // unsent confirmations. Safe to run on every instance: settlement is idempotent.
  let reconciling = false;
  const reconciler = payments
    ? setInterval(() => {
        if (reconciling) return;
        reconciling = true;
        payments
          .reconcile()
          .then((summary) => {
            if (summary.checked || summary.notified) logger.info({ summary }, 'payment reconciliation');
          })
          .catch((err: unknown) => logger.error({ err }, 'payment reconciliation failed'))
          .finally(() => {
            reconciling = false;
          });
      }, env.PAYMENT_RECONCILE_INTERVAL_SECONDS * 1000)
    : null;
  reconciler?.unref();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, graphVersion: env.WA_GRAPH_VERSION, payments: Boolean(payments), smsFallback: Boolean(smsFallback) },
      'micro-crm listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    limiter.stop();
    if (reconciler) clearInterval(reconciler);
    server.close(() => {
      prisma
        .$disconnect()
        .catch((err: unknown) => logger.error({ err }, 'prisma disconnect failed'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
