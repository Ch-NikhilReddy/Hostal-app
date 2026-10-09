/**
 * Runs the retention sweep immediately, instead of waiting for the hourly timer.
 *
 *   node --import tsx scripts/run-retention.mjs
 *
 * Useful for reclaiming space on a development database, and for checking what the
 * sweep would do without turning it into a habit.
 *
 * Reports the real table counts before and after. A sweeper that reports "deleted 0"
 * for a table with four thousand rows is either working on the wrong column or the
 * rows are not actually expired — and both look identical from the log line alone.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { prisma } = await import(pathToFileURL(path.join(repoRoot, 'api', 'src', 'db.ts')).href);
const { sweepRetention } = await import(pathToFileURL(path.join(repoRoot, 'api', 'src', 'lib', 'retention.ts')).href);

const before = {
  otp: await prisma.otpCode.count(),
  refresh: await prisma.refreshToken.count(),
  oldestOtp: await prisma.otpCode.findFirst({
    orderBy: { expiresAt: 'asc' },
    select: { expiresAt: true },
  }),
};

const result = await sweepRetention();

const after = {
  otp: await prisma.otpCode.count(),
  refresh: await prisma.refreshToken.count(),
};

console.log(`
Retention sweep
---------------
  before    ${before.otp} OTP row(s), ${before.refresh} refresh token(s)
  removed   ${result.otpDeleted} OTP code(s), ${result.refreshDeleted} refresh token(s)
  after     ${after.otp} OTP row(s), ${after.refresh} refresh token(s)
  oldest remaining OTP expires ${before.oldestOtp?.expiresAt.toISOString() ?? 'n/a'}
`);

if (result.otpEligible > 0 && result.otpDeleted === 0) {
  console.error('  WARNING: rows were eligible but none were deleted — check the WHERE clause.\n');
  process.exitCode = 1;
}

await prisma.$disconnect();