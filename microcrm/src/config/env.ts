import { z } from 'zod';

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
  CUSTOMER_MAX_EVENTS_PER_MINUTE: z.coerce.number().int().positive().default(6),

  /** Public https origin behind nginx, e.g. https://yourdomain.co.za. Required for payments. */
  PUBLIC_BASE_URL: z.string().url().optional(),

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
  PAYMENT_WEBHOOK_ALLOWED_IPS: z.string().default(''),
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
});

export interface SmsEnv {
  tokenId: string;
  tokenSecret: string;
  baseUrl: string;
  senderId?: string;
  timeoutMs: number;
  costPerSegmentCents: number;
}

export interface PaymentsEnv {
  publicBaseUrl: string;
  ozow: { siteCode: string; apiKey: string; privateKey: string; baseUrl: string; isTest: boolean; timeoutMs: number };
  allowedIps: ReadonlySet<string>;
}

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
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

/** Null when payments are not configured. Throws on a half or unsafe configuration. */
export function paymentsEnv(env: Env): PaymentsEnv | null {
  const { OZOW_SITE_CODE: siteCode, OZOW_API_KEY: apiKey, OZOW_PRIVATE_KEY: privateKey } = env;
  const provided = [siteCode, apiKey, privateKey].filter(Boolean).length;
  if (provided === 0) return null;
  if (!siteCode || !apiKey || !privateKey) {
    throw new Error('Set all of OZOW_SITE_CODE, OZOW_API_KEY and OZOW_PRIVATE_KEY, or none');
  }
  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be an https URL when payments are enabled');
  }
  if (!env.OZOW_IS_TEST) {
    throw new Error('OZOW_IS_TEST must be set explicitly when payments are enabled');
  }
  const isTest = env.OZOW_IS_TEST === 'true';
  if (isTest && env.NODE_ENV === 'production') {
    throw new Error('OZOW_IS_TEST=true is not allowed in production');
  }
  return {
    publicBaseUrl: env.PUBLIC_BASE_URL,
    ozow: { siteCode, apiKey, privateKey, baseUrl: env.OZOW_BASE_URL, isTest, timeoutMs: env.OZOW_TIMEOUT_MS },
    allowedIps: new Set(
      env.PAYMENT_WEBHOOK_ALLOWED_IPS.split(',')
        .map((ip) => ip.trim())
        .filter(Boolean),
    ),
  };
}
