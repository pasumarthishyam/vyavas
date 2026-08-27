/**
 * Environment, validated at boot.
 *
 * Fails loudly at startup rather than at 2am when a webhook arrives and a
 * missing secret turns into an unhandled rejection three layers down.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Supabase pooled connection string (Supavisor, port 6543), NOT the direct
   * 5432 one. Serverless invocations each open their own connection; without
   * the pooler you exhaust Postgres exactly when a merchant is having an outage
   * and traffic spikes.
   *
   * Session mode additionally caps concurrent clients (15 on the default plan)
   * and rejects the excess with a FATAL error rather than queueing, so
   * transaction mode is the only workable choice for serverless.
   */
  DATABASE_URL: z.string().url().optional(),

  /** Direct 5432 connection. Migrations only — drizzle-kit needs real DDL. */
  DIRECT_DATABASE_URL: z.string().url().optional(),

  /**
   * 32 bytes, base64. Wraps the Razorpay key secrets and webhook secrets before
   * they are written to the database.
   *
   * Validated for real entropy-carrying length rather than just "a string":
   * a short passphrase here would silently produce a weak key and nothing
   * would complain until it mattered.
   */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message:
        'must decode to exactly 32 bytes. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    })
    .optional(),

  // ── Razorpay ──
  RAZORPAY_API_KEY: z.string().min(1).optional(),
  RAZORPAY_API_SECRET: z.string().min(1).optional(),
  /**
   * Razorpay signs every webhook delivery with this. Without it the endpoint is
   * open: anyone who learns the URL can post fake payment failures and drive
   * real messages to real customers.
   */
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

/**
 * Treat an empty string as unset.
 *
 * A .env file carries placeholders — RAZORPAY_WEBHOOK_SECRET="" until the
 * webhook is actually created in the dashboard. dotenv sets those as empty
 * strings, which are PRESENT but not usable, so a plain .optional() would
 * reject the whole environment and take down every script that needed some
 * other variable entirely.
 */
function blankToUndefined(source: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = typeof v === 'string' && v.trim().length === 0 ? undefined : v;
  }
  return out;
}

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(blankToUndefined(process.env));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the memoised env. Tests only. */
export function resetEnvCache(): void {
  cached = null;
}

function required(name: keyof Env, hint: string): string {
  const value = env()[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}

export function requireDatabaseUrl(): string {
  return required(
    'DATABASE_URL',
    'Use the Supabase POOLED connection string (transaction pooler, port 6543).',
  );
}

export function requireEncryptionKey(): Buffer {
  return Buffer.from(
    required('ENCRYPTION_KEY', 'Generate 32 random bytes and base64-encode them.'),
    'base64',
  );
}

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export function requireRazorpayCredentials(): RazorpayCredentials {
  return {
    keyId: required('RAZORPAY_API_KEY', 'Razorpay Dashboard > Account & Settings > API Keys.'),
    keySecret: required('RAZORPAY_API_SECRET', 'Shown once when the key is generated.'),
  };
}

export function requireWebhookSecret(): string {
  return required(
    'RAZORPAY_WEBHOOK_SECRET',
    'Razorpay Dashboard > Settings > Webhooks — the secret you set when creating the webhook.',
  );
}

/** True when the configured key is a test-mode key. */
export function isTestMode(): boolean {
  return (env().RAZORPAY_API_KEY ?? '').startsWith('rzp_test_');
}
