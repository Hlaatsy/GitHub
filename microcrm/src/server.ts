import { ConversationHandlers } from './bot/handlers';
import { loadEnv } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { createPrismaClient } from './lib/prisma';
import { SlidingWindowLimiter } from './lib/rateLimiter';
import { CustomerRepository } from './services/customers';
import { InboundLedger } from './services/inboundLedger';
import { OutboundMessenger } from './services/messenger';
import { TenantDirectory } from './services/tenants';
import { WalletService } from './services/wallet';
import { WebhookProcessor } from './webhooks/processor';
import { WhatsAppService } from './whatsapp/WhatsAppService';

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient();

  const whatsapp = new WhatsAppService({
    accessToken: env.WA_ACCESS_TOKEN,
    graphVersion: env.WA_GRAPH_VERSION,
    baseUrl: env.WA_GRAPH_BASE_URL,
    timeoutMs: env.WA_HTTP_TIMEOUT_MS,
    logger,
  });
  const customers = new CustomerRepository(prisma);
  const limiter = new SlidingWindowLimiter(env.CUSTOMER_MAX_EVENTS_PER_MINUTE, 60_000);

  const processor = new WebhookProcessor({
    tenants: new TenantDirectory(prisma, logger),
    customers,
    ledger: new InboundLedger(prisma),
    handlers: new ConversationHandlers(prisma, customers, { menuCooldownMs: env.MENU_COOLDOWN_SECONDS * 1000 }),
    messenger: new OutboundMessenger({
      prisma,
      whatsapp,
      wallet: new WalletService(prisma),
      logger,
      costs: {
        serviceCents: env.COST_SERVICE_MESSAGE_CENTS,
        utilityTemplateCents: env.COST_UTILITY_TEMPLATE_CENTS,
      },
      lowBalanceTemplate: env.WA_LOW_BALANCE_TEMPLATE,
      templateLanguage: env.WA_TEMPLATE_LANGUAGE,
    }),
    whatsapp,
    limiter,
    logger,
    markAsRead: env.WA_MARK_AS_READ,
    staleAfterMs: env.STALE_MESSAGE_SECONDS * 1000,
  });

  const app = createApp({
    appSecret: env.WA_APP_SECRET,
    verifyToken: env.WA_VERIFY_TOKEN,
    sink: processor,
    logger,
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, graphVersion: env.WA_GRAPH_VERSION }, 'micro-crm listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    limiter.stop();
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
