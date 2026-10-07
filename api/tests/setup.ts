import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// Tests must not talk to the gateway, real SMS, or a production database, no
// matter what the developer's shell environment happens to contain. Everything
// below is set before any application module is imported, because config.ts reads
// the environment at import time.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://hostelmitra:hostelmitra@localhost:5432/hostelmitra?schema=public';
process.env.JWT_SECRET = 'test-only-secret-at-least-32-chars-long-abcdefgh';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RAZORPAY_WEBHOOK_SECRET = '';
process.env.OTP_PROVIDER = 'console';
process.env.FCM_SERVER_KEY = '';
process.env.STORAGE_DRIVER = 'local';
process.env.DEFAULT_COMMISSION_PERCENT = '10';

// No billing is configured in tests, so the OTP send limit is already inert (see
// enforceOtpRateLimit). The wrong-OTP attempt limit still applies, and a test
// covers it.

// Silence request logging during tests; morgan checks isTest and skips already,
// but the app's own console.warn calls are useful when a test fails.
if (existsSync(path.join(repoRoot, '.env'))) {
  // Deliberately NOT loaded. The defaults above are the whole point: a test run
  // must be reproducible on a machine that has real Razorpay keys configured.
}