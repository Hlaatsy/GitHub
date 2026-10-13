import { readFileSync } from 'node:fs';
import { eraseCustomer, exportCustomer } from '../admin/customerData';
import { applyTenantFile, TenantFileSchema } from '../admin/tenantConfig';
import { loadEnv, paymentsEnv } from '../config/env';
import { logger } from '../lib/logger';
import { createPrismaClient } from '../lib/prisma';
import { OnboardingService } from '../onboarding/OnboardingService';
import { ACCOUNT_PROVIDERS, PaymentAccounts, type AccountProvider } from '../payments/accounts';
import { OutboundMessenger } from '../services/messenger';
import { TenantDirectory } from '../services/tenants';
import { WalletService } from '../services/wallet';
import { coreTemplates } from '../whatsapp/templates/definitions';
import { TemplateService } from '../whatsapp/templates/TemplateService';
import { WhatsAppService } from '../whatsapp/WhatsAppService';

// Operator commands. In production:
//   docker compose exec api node dist/cli/admin.js <command> <tenantId>

const USAGE = `Usage: admin <command> <args>

  tenant-apply <file.json | ->             Create or update a business from a JSON file, or stdin (see docs/example-business.json)
  wallet-topup <tenantId> <rands> <ref>    Credit the business's message wallet, e.g. wallet-topup <id> 200 EFT-2026-10-12
  onboarding-link <tenantId>               Issue the owner's private setup checklist link (replaces any earlier link)
  templates-submit <tenantId>              Validate and submit the app's message templates to Meta for approval
  templates-sync <tenantId>                Pull Meta's current approval status for those templates
  payment-account-set <tenantId> <PAYFAST|PAYSTACK> <file.json | ->
                                           Store the business's own payment account (encrypted), e.g. from stdin:
                                           {"merchantId":"…","merchantKey":"…","passphrase":"…","sandbox":false}
                                           {"secretKey":"sk_live_…"}
  payment-account-remove <tenantId> <PAYFAST|PAYSTACK>
                                           Delete it; new links then use the platform account, if any
  customer-export <tenantId> <waId>        POPIA access request: print everything held about a customer as JSON
  customer-erase <tenantId> <waId>         POPIA deletion request: anonymise the customer (financial records are kept)`;

async function main(): Promise<number> {
  const [command, tenantId, ...rest] = process.argv.slice(2);
  if (!command || !tenantId) {
    console.error(USAGE);
    return 2;
  }

  if (command === 'tenant-apply') {
    // '-' reads stdin, so a file on the host can be piped into the container.
    const parsed = TenantFileSchema.safeParse(JSON.parse(readFileSync(tenantId === '-' ? 0 : tenantId, 'utf8')));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) console.error(`✘ ${issue.path.join('.') || '(file)'}: ${issue.message}`);
      return 1;
    }
    // WhatsApp list rows show at most 24 characters; longer names arrive cut short.
    const long = [...parsed.data.services, ...parsed.data.products].filter((item) => item.name.length > 24);
    for (const item of long) console.warn(`⚠ "${item.name}" is ${item.name.length} characters; WhatsApp lists show only the first 24.`);
    const prisma = createPrismaClient();
    try {
      const result = await applyTenantFile(prisma, parsed.data);
      console.log(`${result.created ? 'Created' : 'Updated'} ${parsed.data.businessName}: tenant id ${result.tenantId}`);
      console.log(`Catalog: ${result.catalog.added} added, ${result.catalog.updated} updated, ${result.catalog.deactivated} deactivated.`);
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  }

  if (command === 'customer-export' || command === 'customer-erase') {
    const waId = (rest[0] ?? '').replace(/^\+/, '');
    if (!/^[1-9]\d{7,14}$/.test(waId)) {
      console.error(`Usage: admin ${command} <tenantId> <waId>   (digits with country code, e.g. 27821234567)`);
      return 2;
    }
    const prisma = createPrismaClient();
    try {
      if (command === 'customer-export') {
        const data = await exportCustomer(prisma, tenantId, waId);
        if (!data) {
          console.error('No such customer for this business.');
          return 1;
        }
        console.log(JSON.stringify(data, null, 2));
        return 0;
      }
      const result = await eraseCustomer(prisma, tenantId, waId);
      if (result.status === 'not_found') {
        console.error('No such customer for this business.');
        return 1;
      }
      if (result.status === 'open_items') {
        console.error(`Not erased: ${result.orders} open order(s) and ${result.bookings} open booking(s). Fulfil or cancel them first.`);
        return 1;
      }
      console.log('Customer anonymised. Their orders and payments are kept without their name, number or address.');
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  }

  if (command === 'wallet-topup') {
    const [amount, reference] = rest;
    const rands = Number(amount);
    if (!Number.isFinite(rands) || rands <= 0 || !reference) {
      console.error('Usage: admin wallet-topup <tenantId> <rands> <reference>');
      return 2;
    }
    const prisma = createPrismaClient();
    try {
      const balance = await new WalletService(prisma).topUp(tenantId, Math.round(rands * 100), reference.slice(0, 64));
      console.log(`Wallet balance is now R${(balance.balanceCents / 100).toFixed(2)}.`);
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  }

  const env = loadEnv();

  if (command === 'payment-account-set' || command === 'payment-account-remove') {
    const [provider, source] = rest;
    if (!provider || !(ACCOUNT_PROVIDERS as readonly string[]).includes(provider) || (command === 'payment-account-set' && !source)) {
      console.error(`Usage: admin ${command} <tenantId> <PAYFAST|PAYSTACK>${command === 'payment-account-set' ? ' <file.json | ->' : ''}`);
      return 2;
    }
    const config = paymentsEnv(env)?.accounts;
    if (!config) {
      console.error('Set CREDENTIALS_ENCRYPTION_KEY (and PUBLIC_BASE_URL) in .env first: openssl rand -base64 32');
      return 2;
    }
    const prisma = createPrismaClient();
    try {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { businessName: true } });
      if (!tenant) {
        console.error(`No tenant ${tenantId}`);
        return 1;
      }
      const accounts = new PaymentAccounts(prisma, { ...config, logger });
      if (command === 'payment-account-remove') {
        const removed = await accounts.remove(tenantId, provider as AccountProvider);
        console.log(removed ? `Removed the ${provider} account for ${tenant.businessName}.` : `${tenant.businessName} had no ${provider} account.`);
        return 0;
      }
      let input: unknown;
      try {
        input = JSON.parse(readFileSync(source === '-' ? 0 : (source as string), 'utf8'));
      } catch {
        console.error('Could not read the account JSON');
        return 1;
      }
      try {
        const { testMode } = await accounts.set(tenantId, provider as AccountProvider, input);
        console.log(`Saved the ${provider} account for ${tenant.businessName}${testMode ? ' (TEST MODE: payments are not real)' : ''}.`);
        console.log(`Settlement notices arrive at ${new URL(env.PUBLIC_BASE_URL ?? '').origin}${provider === 'PAYFAST' ? '/api/payments/payfast-itn' : '/api/payments/callback'}`);
        if (provider === 'PAYSTACK') console.log('Set that URL as the Webhook URL in the Paystack dashboard (Settings → API Keys & Webhooks).');
        return 0;
      } catch (error) {
        // Validation messages never echo the secret values themselves.
        const issues = (error as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
        if (issues) for (const issue of issues) console.error(`✘ ${issue.path.join('.') || '(account)'}: ${issue.message}`);
        else console.error(`✘ ${(error as Error).message}`);
        return 1;
      }
    } finally {
      await prisma.$disconnect();
    }
  }

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
