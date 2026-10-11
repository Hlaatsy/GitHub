import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const MIN_GRAPH_MAJOR_VERSION = 20;

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
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${issues.join('; ')}`);
  }
  return result.data;
}
