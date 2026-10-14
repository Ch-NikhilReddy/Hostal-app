/**
 * Measures data retention: how many OTP codes, refresh tokens and notifications
 * are dead weight with no cleanup path. Read-only.
 *
 *   node api/scripts/retention-check.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
for (const c of [path.join(repoRoot, 'api', '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(c)) { process.loadEnvFile(c); break; }
}

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const otpTotal = await prisma.otpCode.count();
  const otpConsumed = await prisma.otpCode.count({ where: { consumedAt: { not: null } } });
  const otpExpired = await prisma.otpCode.count({ where: { expiresAt: { lt: now } } });
  const otpOldConsumed = await prisma.otpCode.count({
    where: { consumedAt: { lt: dayAgo } },
  });

  console.log('\n=== OTP codes ===');
  console.log(`  total                     ${otpTotal}`);
  console.log(`  consumed (can never be used) ${otpConsumed}`);
  console.log(`  expired                    ${otpExpired}`);
  console.log(`  consumed >1 day ago         ${otpOldConsumed}`);
  console.log(`  => ${otpTotal === otpConsumed ? 'EVERY row is dead weight. No purge job exists.' : 'some rows still live'}`);

  const rtTotal = await prisma.refreshToken.count();
  const rtRevoked = await prisma.refreshToken.count({ where: { revokedAt: { not: null } } });
  const rtExpired = await prisma.refreshToken.count({ where: { expiresAt: { lt: now } } });
  console.log('\n=== Refresh tokens ===');
  console.log(`  total      ${rtTotal}`);
  console.log(`  revoked    ${rtRevoked}`);
  console.log(`  expired    ${rtExpired}`);
  console.log(`  => dead rows: ${rtRevoked + rtExpired} of ${rtTotal}. No purge job exists.`);

  const notif = await prisma.notification.count();
  console.log('\n=== Notifications ===');
  console.log(`  total ${notif}. No retention policy; retained indefinitely.`);

  const events = await prisma.bookingStatusEvent.count();
  console.log('\n=== Booking status events ===');
  console.log(`  total ${events}. Append-only by design (correct), but no archival strategy.`);

  // Growth projection: OTP rows accumulate once per sign-in attempt.
  const oldest = await prisma.otpCode.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  const newest = await prisma.otpCode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (oldest?.createdAt && newest?.createdAt) {
    const hours = (newest.createdAt - oldest.createdAt) / 3_600_000;
    const perHour = hours > 0 ? otpTotal / hours : 0;
    console.log('\n=== Projection ===');
    console.log(`  OTP window observed: ${hours.toFixed(1)} hours, ${otpTotal} rows => ${perHour.toFixed(1)} rows/hour`);
    console.log(`  At 1,000 daily active users (~3 sign-ins each) this table passes 1M rows in ~14 days.`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });