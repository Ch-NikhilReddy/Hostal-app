import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertDuration } from './lib/duration.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Node >= 20.12 can read a .env file itself, so this does not need dotenv.
// process.loadEnvFile does not overwrite variables already in the environment,
// which is what lets CI pass real credentials and override the file.
for (const candidate of [path.resolve(here, '../.env'), path.resolve(here, '../../.env')]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // A malformed line in .env should not take down a process that was handed
      // a complete environment by its launcher, so a load failure is ignored.
    }
  }
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  // Validated by parseDurationMs below, not by a bare z.string(). See
  // lib/duration.ts: a unitless value like "3600" is ambiguous, and a value like
  // "12h" used to be silently read as 12 days by the refresh-token path.
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  DEFAULT_COMMISSION_PERCENT: z.coerce.number().min(0).max(50).default(10),

  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  OTP_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().default(''),
  MSG91_SENDER_ID: z.string().default('HMTRIA'),

  FCM_SERVER_KEY: z.string().default(''),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./var/uploads'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_PUBLIC_BASE_URL: z.string().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

// Fail at startup, not at first login.
//
// Both TTLs are resolved by the same parser here and at every use site, so a typo
// cannot produce one interpretation for the signed JWT and another for the
// refresh-token row.
for (const [value, label] of [
  [env.JWT_ACCESS_TTL, 'JWT_ACCESS_TTL'],
  [env.JWT_REFRESH_TTL, 'JWT_REFRESH_TTL'],
] as const) {
  assertDuration(value, label);
}

// Dev conveniences that must not survive into production.
if (env.NODE_ENV === 'development') {
  if (env.JWT_SECRET === 'dev-only-insecure-secret-change-me') {
    // Deliberately allowed: this is the documented default in .env.example and
    // makes `npm run dev` work with zero setup.
  } else if (env.JWT_SECRET.length < 16) {
    throw new Error('JWT_SECRET is too short.');
  }
}

if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET === 'dev-only-insecure-secret-change-me') {
    throw new Error('Refusing to start in production with the example JWT_SECRET.');
  }
  if (env.OTP_PROVIDER === 'console' && !process.env.ALLOW_CONSOLE_OTP_IN_PROD) {
    throw new Error(
      'OTP_PROVIDER=console would send real users no OTP. Configure MSG91_AUTH_KEY, ' +
        'or set ALLOW_CONSOLE_OTP_IN_PROD=1 deliberately for a private staging build.',
    );
  }
}

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  /** Razorpay keys present means use the real gateway; otherwise the mock. */
  paymentProvider: (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? 'razorpay' : 'mock') as
    | 'razorpay'
    | 'mock',

  /** Where uploaded photos end up. */
  storageDriver: env.STORAGE_DRIVER as 'local' | 's3',
  uploadsDir: path.resolve(
    path.resolve(here, '../..'),
    env.STORAGE_LOCAL_DIR.replace(/^\.\//, ''),
  ),
  repoRoot: path.resolve(here, '../../..'),
} as const;

export type Config = typeof config;