import { loadEnv } from '../config/env';
import { logger } from '../lib/logger';
import { createPrismaClient } from '../lib/prisma';
import { OnboardingService } from '../onboarding/OnboardingService';
import { OutboundMessenger } from '../services/messenger';
import { TenantDirectory } from '../services/tenants';
import { WalletService } from '../services/wallet';
import { coreTemplates } from '../whatsapp/templates/definitions';
import { TemplateService } from '../whatsapp/templates/TemplateService';
import { WhatsAppService } from '../whatsapp/WhatsAppService';

// Operator commands. In production:
//   docker compose exec api node dist/cli/admin.js <command> <tenantId>

const USAGE = `Usage: admin <command> <tenantId>

  onboarding-link   Issue the owner's private setup checklist link (replaces any earlier link)
  templates-submit  Validate and submit the app's message templates to Meta for approval
  templates-sync    Pull Meta's current approval status for those templates`;

async function main(): Promise<number> {
  const [command, tenantId] = process.argv.slice(2);
  if (!command || !tenantId) {
    console.error(USAGE);
    return 2;
  }

  const env = loadEnv();
  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) {
    console.error('PUBLIC_BASE_URL must be set to your https origin');
    return 2;
  }
  const prisma = createPrismaClient();
  try {
    const tenants = new TenantDirectory(prisma, logger);
    const tenant = await tenants.byId(tenantId);
    if (!tenant) {
      console.error(`No tenant ${tenantId}`);
      return 1;
    }
    const whatsapp = new WhatsAppService({
      accessToken: env.WA_ACCESS_TOKEN,
      graphVersion: env.WA_GRAPH_VERSION,
      baseUrl: env.WA_GRAPH_BASE_URL,
      timeoutMs: env.WA_HTTP_TIMEOUT_MS,
      logger,
    });

    if (command === 'onboarding-link') {
      const messenger = new OutboundMessenger({
        prisma,
        whatsapp,
        wallet: new WalletService(prisma),
        logger,
        costs: { serviceCents: env.COST_SERVICE_MESSAGE_CENTS, utilityTemplateCents: env.COST_UTILITY_TEMPLATE_CENTS },
        lowBalanceTemplate: env.WA_LOW_BALANCE_TEMPLATE,
        templateLanguage: env.WA_TEMPLATE_LANGUAGE,
      });
      const onboarding = new OnboardingService(
        { prisma, tenants, messenger, payments: null, logger },
        {
          publicBaseUrl: env.PUBLIC_BASE_URL,
          linkTtlHours: env.ONBOARDING_LINK_TTL_HOURS,
          testAmountCents: env.ONBOARDING_TEST_AMOUNT_CENTS,
          templateLanguage: env.WA_TEMPLATE_LANGUAGE,
          requestTemplate: env.WA_PAYMENT_REQUEST_TEMPLATE,
          requiredTemplates: [],
        },
      );
      const { url, expiresAt } = await onboarding.issueLink(tenant.id);
      console.log(`Setup link for ${tenant.businessName} (valid until ${expiresAt.toISOString()}):\n${url}`);
      console.log('Share it with the owner only: anyone with the link can see setup status and send a test payment to the owner.');
      return 0;
    }

    if (command === 'templates-submit' || command === 'templates-sync') {
      if (!tenant.waBusinessAccountId) {
        console.error(`${tenant.businessName} has no waBusinessAccountId on file`);
        return 1;
      }
      const service = new TemplateService(prisma, whatsapp, logger);
      const definitions = coreTemplates(new URL(env.PUBLIC_BASE_URL).origin, env.WA_TEMPLATE_LANGUAGE);
      if (command === 'templates-sync') {
        console.log(`Synced ${await service.sync(tenant.waBusinessAccountId, definitions)} template(s).`);
        return 0;
      }
      const outcomes = await service.submitMissing(tenant.waBusinessAccountId, definitions);
      for (const outcome of outcomes) {
        if (outcome.result === 'invalid') console.log(`✘ ${outcome.name}: ${outcome.problems.join('; ')}`);
        else if (outcome.result === 'failed') console.log(`✘ ${outcome.name}: ${outcome.error}`);
        else if (outcome.result === 'skipped') console.log(`• ${outcome.name}: already ${outcome.status.toLowerCase()}`);
        else console.log(`✔ ${outcome.name}: submitted (${outcome.status.toLowerCase()})${outcome.categoryChanged ? ' — Meta changed its category, check pricing' : ''}`);
      }
      return outcomes.some((o) => o.result === 'invalid' || o.result === 'failed') ? 1 : 0;
    }

    console.error(USAGE);
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    logger.fatal({ err }, 'admin command failed');
    process.exit(1);
  },
);
