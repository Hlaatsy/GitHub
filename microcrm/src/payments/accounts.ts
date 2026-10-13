import { type PaymentProvider, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { type Logger } from '../lib/logger';
import { decryptCredentials, encryptCredentials } from './credentials';
import { type NotificationContext, type PaymentGateway } from './gateway';
import { parseFormPairs, parseJson } from './http';
import { PayFastGateway } from './payfast';
import { PaystackGateway } from './paystack';

// Each business can be paid into its own PayFast or Paystack account. Its
// credentials sit encrypted in tenant_payment_accounts; a gateway is built
// from them on demand and cached briefly.

export const ACCOUNT_PROVIDERS = ['PAYFAST', 'PAYSTACK'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export const PayFastAccountSchema = z
  .object({
    merchantId: z.string().regex(/^\d{5,20}$/, 'PayFast merchant ID is digits only'),
    merchantKey: z.string().regex(/^[A-Za-z0-9]{8,40}$/, 'PayFast merchant key is letters and digits'),
    // PayFast signs ITNs with the passphrase when one is set on the account; we require one.
    passphrase: z.string().min(8, 'Set a passphrase of at least 8 characters on the PayFast account first').max(100),
    sandbox: z.boolean(),
  })
  .strict();

export const PaystackAccountSchema = z
  .object({ secretKey: z.string().regex(/^sk_(live|test)_[A-Za-z0-9]+$/, 'Paystack secret key must start sk_live_ or sk_test_') })
  .strict();

export type PayFastAccount = z.infer<typeof PayFastAccountSchema>;
export type PaystackAccount = z.infer<typeof PaystackAccountSchema>;

export function parseAccount(provider: AccountProvider, input: unknown): { credentials: PayFastAccount | PaystackAccount; testMode: boolean } {
  if (provider === 'PAYFAST') {
    const credentials = PayFastAccountSchema.parse(input);
    return { credentials, testMode: credentials.sandbox };
  }
  const credentials = PaystackAccountSchema.parse(input);
  return { credentials, testMode: credentials.secretKey.startsWith('sk_test_') };
}

/**
 * Our merchant reference from a not-yet-verified notification, used only to
 * find which business's credentials verify it. Nothing is trusted until the
 * gateway built from those credentials has checked the signature.
 */
export function peekReference(provider: PaymentProvider, context: NotificationContext): string | null {
  try {
    if (provider === 'PAYFAST') {
      return parseFormPairs(context.rawBody, context.contentType).find(([key]) => key === 'm_payment_id')?.[1] ?? null;
    }
    if (provider === 'PAYSTACK') {
      const body = parseJson(context.rawBody.toString('utf8')) as { data?: { reference?: unknown } } | undefined;
      return typeof body?.data?.reference === 'string' ? body.data.reference : null;
    }
  } catch {
    // Malformed: the gateway's own verification reports it properly.
  }
  return null;
}

export interface PaymentAccountOptions {
  key: Buffer;
  production: boolean;
  logger: Logger;
  payfast: { verifySourceIp: boolean; timeoutMs: number };
  paystack: { baseUrl: string; timeoutMs: number; placeholderEmailDomain: string };
  cacheMs?: number;
  /** Tests only: PayFast stand-ins. */
  payfastOverrides?: Pick<ConstructorParameters<typeof PayFastGateway>[0], 'resolveHosts' | 'endpoints'>;
}

interface CacheEntry {
  gateway: PaymentGateway | null;
  expiresAt: number;
}

export class PaymentAccounts {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PaymentAccountOptions,
  ) {
    this.cacheMs = options.cacheMs ?? 60_000;
  }

  async set(tenantId: string, provider: AccountProvider, input: unknown): Promise<{ testMode: boolean }> {
    const { credentials, testMode } = parseAccount(provider, input);
    if (testMode && this.options.production) {
      throw new Error(`A ${provider === 'PAYFAST' ? 'PayFast sandbox' : 'Paystack test'} account cannot be used in production`);
    }
    const credentialsEnc = encryptCredentials(this.options.key, tenantId, provider, credentials);
    await this.prisma.tenantPaymentAccount.upsert({
      where: { tenantId_provider: { tenantId, provider } },
      create: { tenantId, provider, credentialsEnc, testMode },
      update: { credentialsEnc, testMode },
    });
    this.cache.delete(`${tenantId}:${provider}`);
    return { testMode };
  }

  async remove(tenantId: string, provider: AccountProvider): Promise<boolean> {
    const removed = await this.prisma.tenantPaymentAccount.deleteMany({ where: { tenantId, provider } });
    this.cache.delete(`${tenantId}:${provider}`);
    return removed.count > 0;
  }

  /** Providers this business has its own account with, in a stable order. */
  async providers(tenantId: string): Promise<AccountProvider[]> {
    const rows = await this.prisma.tenantPaymentAccount.findMany({ where: { tenantId }, select: { provider: true } });
    const have = new Set(rows.map((row) => row.provider));
    return ACCOUNT_PROVIDERS.filter((provider) => have.has(provider));
  }

  /** The business's own gateway for this provider, or null when it has none (or it is unusable). */
  async gateway(tenantId: string, provider: PaymentProvider, now = Date.now()): Promise<PaymentGateway | null> {
    if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) return null;
    const cacheKey = `${tenantId}:${provider}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.gateway;

    const gateway = await this.build(tenantId, provider as AccountProvider);
    this.cache.set(cacheKey, { gateway, expiresAt: now + this.cacheMs });
    return gateway;
  }

  private async build(tenantId: string, provider: AccountProvider): Promise<PaymentGateway | null> {
    const { key, logger, production } = this.options;
    const row = await this.prisma.tenantPaymentAccount.findUnique({ where: { tenantId_provider: { tenantId, provider } } });
    if (!row) return null;
    if (row.testMode && production) {
      logger.error({ tenantId, provider }, 'test-mode payment account ignored in production');
      return null;
    }
    let raw: unknown;
    try {
      raw = decryptCredentials(key, tenantId, provider, row.credentialsEnc);
    } catch (err) {
      logger.error({ err, tenantId, provider }, 'payment account credentials cannot be decrypted');
      return null;
    }
    const { credentials } = parseAccount(provider, raw);
    if (provider === 'PAYFAST') {
      const account = credentials as PayFastAccount;
      return new PayFastGateway({
        merchantId: account.merchantId,
        merchantKey: account.merchantKey,
        passphrase: account.passphrase,
        sandbox: account.sandbox,
        verifySourceIp: this.options.payfast.verifySourceIp,
        timeoutMs: this.options.payfast.timeoutMs,
        logger,
        ...this.options.payfastOverrides,
      });
    }
    const account = credentials as PaystackAccount;
    const { baseUrl, timeoutMs, placeholderEmailDomain } = this.options.paystack;
    return new PaystackGateway({
      secretKey: account.secretKey,
      baseUrl,
      timeoutMs,
      logger,
      placeholderEmail: (reference) => `pay-${reference.toLowerCase()}@${placeholderEmailDomain}`,
    });
  }
}
