import { z } from 'zod';
import { parseCredentialsKey } from '../payments/credentials';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const MIN_GRAPH_MAJOR_VERSION = 20;

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),

  WA_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  WA_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'Expected a Graph API version such as v20.0')
    .refine(
      (value) => Number(value.slice(1).split('.')[0]) >= MIN_GRAPH_MAJOR_VERSION,
      `Graph API v${MIN_GRAPH_MAJOR_VERSION}.0 or newer is required`,
    )
    .default('v20.0'),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(16),
  WA_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  WA_MARK_AS_READ: booleanFlag,
  WA_LOW_BALANCE_TEMPLATE: z.string().min(1).default('wallet_low_balance'),
  WA_TEMPLATE_LANGUAGE: z.string().min(2).default('en'),

  COST_SERVICE_MESSAGE_CENTS: z.coerce.number().int().min(0).default(12),
  COST_UTILITY_TEMPLATE_CENTS: z.coerce.number().int().min(0).default(12),

  MENU_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(300),
  STALE_MESSAGE_SECONDS: z.coerce.number().int().positive().default(3600),
  /** A shop checkout (items, cart, delivery, address) is 7-10 taps in a minute; spam is far more. */
  CUSTOMER_MAX_EVENTS_PER_MINUTE: z.coerce.number().int().positive().default(15),

  /** Public https origin behind nginx, e.g. https://yourdomain.co.za. Required for payments. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Your POPIA privacy notice (see docs/privacy-notice.md), linked from each customer's first menu. */
  PRIVACY_NOTICE_URL: z.string().url().startsWith('https://').optional(),

  // Ozow pay-by-bank. Payments are enabled only when all three secrets are set.
  OZOW_SITE_CODE: optionalSecret,
  OZOW_API_KEY: optionalSecret,
  OZOW_PRIVATE_KEY: optionalSecret,
  OZOW_BASE_URL: z.string().url().default('https://api.ozow.com'),
  /** Deliberately no default: a test-mode site in production would confirm unpaid bookings. */
  OZOW_IS_TEST: z.enum(['true', 'false']).optional(),
  OZOW_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  PAYMENT_LINK_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  PAYMENT_MAX_CENTS: z.coerce.number().int().positive().default(5_000_000),
  PAYMENT_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
  /** Comma-separated provider egress IPs; empty disables the allowlist. */
  /** Comma-separated Ozow egress IPs for /webhooks/payments; empty disables the allowlist. */
  PAYMENT_WEBHOOK_ALLOWED_IPS: z.string().default(''),

  // PayFast (form checkout + ITN at /api/payments/payfast-itn). Enabled when all three are set.
  PAYFAST_MERCHANT_ID: optionalSecret,
  PAYFAST_MERCHANT_KEY: optionalSecret,
  PAYFAST_PASSPHRASE: optionalSecret,
  /** Deliberately no default: the sandbox in production would confirm unpaid bookings. */
  PAYFAST_SANDBOX: z.enum(['true', 'false']).optional(),
  PAYFAST_VERIFY_SOURCE_IP: z.enum(['true', 'false']).default('true'),
  PAYFAST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Paystack (webhook at /api/payments/callback).
  PAYSTACK_SECRET_KEY: optionalSecret,
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Comma-separated Paystack webhook IPs; empty disables the allowlist (the HMAC still applies). */
  PAYSTACK_WEBHOOK_ALLOWED_IPS: z.string().default(''),
  /** Domain for the per-payment placeholder email Paystack requires; defaults to PUBLIC_BASE_URL's host. */
  PAYSTACK_PLACEHOLDER_EMAIL_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).optional(),

  /**
   * Encrypts each business's own PayFast / Paystack credentials at rest
   * (`openssl rand -base64 32`). Required to use per-business payment accounts.
   */
  CREDENTIALS_ENCRYPTION_KEY: optionalSecret,

  /** Gateway for new payment links: OZOW, PAYFAST or PAYSTACK. Defaults to the first configured. */
  PAYMENT_DEFAULT_PROVIDER: z.enum(['OZOW', 'PAYFAST', 'PAYSTACK']).optional(),
  WA_PAYMENT_REQUEST_TEMPLATE: z.string().min(1).default('payment_request'),
  WA_PAYMENT_CONFIRMED_TEMPLATE: z.string().min(1).default('payment_confirmed'),

  // SMS fallback for undeliverable pay links (BulkSMS). Enabled when both token parts are set.
  BULKSMS_TOKEN_ID: optionalSecret,
  BULKSMS_TOKEN_SECRET: optionalSecret,
  BULKSMS_BASE_URL: z.string().url().default('https://api.bulksms.com/v1'),
  /** Registered alphanumeric sender ID (max 11 characters); empty uses BulkSMS's default route. */
  BULKSMS_SENDER_ID: z
    .string()
    .regex(/^[A-Za-z0-9 ]{0,11}$/)
    .optional()
    .transform((value) => (value ? value : undefined)),
  SMS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  SMS_COST_PER_SEGMENT_CENTS: z.coerce.number().int().min(0).default(25),

  /** Real payment the owner makes to themselves during onboarding, in cents. */
  ONBOARDING_TEST_AMOUNT_CENTS: z.coerce.number().int().min(100).max(10_000).default(500),
  ONBOARDING_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),

  // Owner dashboard (/dashboard): owners log in by sending LOGIN to their business number.
  DASHBOARD_LOGIN_LINK_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
  DASHBOARD_SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  DASHBOARD_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  DASHBOARD_MAX_LINKS_PER_HOUR: z.coerce.number().int().min(1).max(20).default(5),
});

export interface SmsEnv {
  tokenId: string;
  tokenSecret: string;
  baseUrl: string;
  senderId?: string;
  timeoutMs: number;
  costPerSegmentCents: number;
}

export type ProviderName = 'OZOW' | 'PAYFAST' | 'PAYSTACK';

export interface PaymentsEnv {
  publicBaseUrl: string;
  /** Null when only per-business accounts are configured. */
  defaultProvider: ProviderName | null;
  ozow?: { siteCode: string; apiKey: string; privateKey: string; baseUrl: string; isTest: boolean; timeoutMs: number };
  payfast?: { merchantId: string; merchantKey: string; passphrase: string; sandbox: boolean; verifySourceIp: boolean; timeoutMs: number };
  paystack?: { secretKey: string; baseUrl: string; timeoutMs: number; placeholderEmailDomain: string };
  allowedIps: Partial<Record<ProviderName, ReadonlySet<string>>>;
  /** Present when businesses can bring their own PayFast / Paystack accounts. */
  accounts?: {
    key: Buffer;
    production: boolean;
    payfast: { verifySourceIp: boolean; timeoutMs: number };
    paystack: { baseUrl: string; timeoutMs: number; placeholderEmailDomain: string };
  };
}

function ipSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
  );
}

/** All of a provider's settings, or none: a half configuration is an error. */
function allOrNone<T extends string>(provider: string, values: Record<T, string | undefined>): Record<T, string> | null {
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length === Object.keys(values).length) return null;
  if (missing.length > 0) throw new Error(`${provider}: also set ${missing.join(', ')} (or none of its settings)`);
  return values as Record<T, string>;
}

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `KEY=` in an env file arrives as an empty string: treat it as not set.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const result = EnvSchema.safeParse(present);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${issues.join('; ')}`);
  }
  return result.data;
}

/** Null when SMS fallback is not configured. Throws on a half configuration. */
export function smsEnv(env: Env): SmsEnv | null {
  const { BULKSMS_TOKEN_ID: tokenId, BULKSMS_TOKEN_SECRET: tokenSecret } = env;
  if (!tokenId && !tokenSecret) return null;
  if (!tokenId || !tokenSecret) throw new Error('Set both BULKSMS_TOKEN_ID and BULKSMS_TOKEN_SECRET, or neither');
  return {
    tokenId,
    tokenSecret,
    baseUrl: env.BULKSMS_BASE_URL,
    ...(env.BULKSMS_SENDER_ID ? { senderId: env.BULKSMS_SENDER_ID } : {}),
    timeoutMs: env.SMS_TIMEOUT_MS,
    costPerSegmentCents: env.SMS_COST_PER_SEGMENT_CENTS,
  };
}

/** Null when no payment provider is configured. Throws on a half or unsafe configuration. */
export function paymentsEnv(env: Env): PaymentsEnv | null {
  const production = env.NODE_ENV === 'production';
  const ozowKeys = allOrNone('Ozow', { OZOW_SITE_CODE: env.OZOW_SITE_CODE, OZOW_API_KEY: env.OZOW_API_KEY, OZOW_PRIVATE_KEY: env.OZOW_PRIVATE_KEY });
  const payfastKeys = allOrNone('PayFast', {
    PAYFAST_MERCHANT_ID: env.PAYFAST_MERCHANT_ID,
    PAYFAST_MERCHANT_KEY: env.PAYFAST_MERCHANT_KEY,
    PAYFAST_PASSPHRASE: env.PAYFAST_PASSPHRASE,
  });
  const paystackKey = env.PAYSTACK_SECRET_KEY;
  const credentialsKey = env.CREDENTIALS_ENCRYPTION_KEY;
  if (!ozowKeys && !payfastKeys && !paystackKey && !credentialsKey) return null;

  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be an https URL when payments are enabled');
  }
  const result: PaymentsEnv = { publicBaseUrl: env.PUBLIC_BASE_URL, defaultProvider: null, allowedIps: {} };
  if (env.PAYFAST_VERIFY_SOURCE_IP === 'false' && production) throw new Error('PAYFAST_VERIFY_SOURCE_IP=false is not allowed in production');
  const paystackEmailDomain = env.PAYSTACK_PLACEHOLDER_EMAIL_DOMAIN ?? new URL(env.PUBLIC_BASE_URL).hostname;
  result.allowedIps.PAYSTACK = ipSet(env.PAYSTACK_WEBHOOK_ALLOWED_IPS);

  if (credentialsKey) {
    result.accounts = {
      key: parseCredentialsKey(credentialsKey),
      production,
      payfast: { verifySourceIp: env.PAYFAST_VERIFY_SOURCE_IP === 'true', timeoutMs: env.PAYFAST_TIMEOUT_MS },
      paystack: { baseUrl: env.PAYSTACK_BASE_URL, timeoutMs: env.PAYSTACK_TIMEOUT_MS, placeholderEmailDomain: paystackEmailDomain },
    };
  }

  if (ozowKeys) {
    if (!env.OZOW_IS_TEST) throw new Error('OZOW_IS_TEST must be set explicitly when Ozow is enabled');
    const isTest = env.OZOW_IS_TEST === 'true';
    if (isTest && production) throw new Error('OZOW_IS_TEST=true is not allowed in production');
    result.ozow = {
      siteCode: ozowKeys.OZOW_SITE_CODE,
      apiKey: ozowKeys.OZOW_API_KEY,
      privateKey: ozowKeys.OZOW_PRIVATE_KEY,
      baseUrl: env.OZOW_BASE_URL,
      isTest,
      timeoutMs: env.OZOW_TIMEOUT_MS,
    };
    result.allowedIps.OZOW = ipSet(env.PAYMENT_WEBHOOK_ALLOWED_IPS);
  }

  if (payfastKeys) {
    if (!env.PAYFAST_SANDBOX) throw new Error('PAYFAST_SANDBOX must be set explicitly when PayFast is enabled');
    const sandbox = env.PAYFAST_SANDBOX === 'true';
    if (sandbox && production) throw new Error('PAYFAST_SANDBOX=true is not allowed in production');
    result.payfast = {
      merchantId: payfastKeys.PAYFAST_MERCHANT_ID,
      merchantKey: payfastKeys.PAYFAST_MERCHANT_KEY,
      passphrase: payfastKeys.PAYFAST_PASSPHRASE,
      sandbox,
      verifySourceIp: env.PAYFAST_VERIFY_SOURCE_IP === 'true',
      timeoutMs: env.PAYFAST_TIMEOUT_MS,
    };
  }

  if (paystackKey) {
    if (!/^sk_(live|test)_[A-Za-z0-9]+$/.test(paystackKey)) throw new Error('PAYSTACK_SECRET_KEY must be an sk_live_… or sk_test_… key');
    if (paystackKey.startsWith('sk_test_') && production) throw new Error('A Paystack test key is not allowed in production');
    result.paystack = {
      secretKey: paystackKey,
      baseUrl: env.PAYSTACK_BASE_URL,
      timeoutMs: env.PAYSTACK_TIMEOUT_MS,
      placeholderEmailDomain: paystackEmailDomain,
    };
  }

  const configured: ProviderName[] = [...(result.ozow ? ['OZOW' as const] : []), ...(result.payfast ? ['PAYFAST' as const] : []), ...(result.paystack ? ['PAYSTACK' as const] : [])];
  const wanted = env.PAYMENT_DEFAULT_PROVIDER ?? configured[0];
  if (!wanted && !env.PAYMENT_DEFAULT_PROVIDER) return result; // per-business accounts only
  if (!wanted || !configured.includes(wanted)) {
    throw new Error(`PAYMENT_DEFAULT_PROVIDER=${env.PAYMENT_DEFAULT_PROVIDER} is not configured (configured: ${configured.join(', ')})`);
  }
  result.defaultProvider = wanted;
  return result;
}
