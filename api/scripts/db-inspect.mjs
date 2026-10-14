/**
 * Read-only database inspection: indexes, constraints, row counts, and the query
 * plans behind the two hottest endpoints.
 *
 *   node api/scripts/db-inspect.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// repoRoot is two levels up from api/scripts; the .env lives at the repo root and
// is shared with Docker Compose, so it is loaded before Prisma reads it.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
for (const c of [path.join(repoRoot, 'api', '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(c)) {
    process.loadEnvFile(c);
    break;
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Expected a .env at', path.join(repoRoot, '.env'));
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== Indexes per table ===');
  const idx = await prisma.$queryRawUnsafe(
    `SELECT tablename, indexname FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`,
  );
  const byTable = new Map();
  for (const r of idx) {
    if (!byTable.has(r.tablename)) byTable.set(r.tablename, []);
    byTable.get(r.tablename).push(r.indexname);
  }
  for (const [t, list] of byTable) {
    console.log(`  ${t.padEnd(24)} ${list.length} indexes`);
  }

  console.log('\n=== Constraints (pk / unique / fk) ===');
  const cons = await prisma.$queryRawUnsafe(
    `SELECT relname,
            count(*) FILTER (WHERE contype='p') AS pk,
            count(*) FILTER (WHERE contype='f') AS fk,
            count(*) FILTER (WHERE contype='u') AS uniq
       FROM pg_constraint c JOIN pg_class ON conrelid = pg_class.oid
      GROUP BY relname ORDER BY relname`,
  );
  for (const c of cons) {
    if (c.fk > 0 || c.uniq > 0) {
      console.log(`  ${String(c.relname).padEnd(24)} pk=${c.pk} uniq=${c.uniq} fk=${c.fk}`);
    }
  }

  console.log('\n=== Row counts ===');
  // Counts are done in SQL rather than via prisma[model] because the model
  // accessor names do not reliably match the DB table names, and a wrong name
  // would throw rather than report zero.
  const tables = [
    'users', 'owners', 'hostels', 'room_types', 'beds',
    'bookings', 'payments', 'booking_status_events', 'notifications',
    'otp_codes', 'refresh_tokens', 'push_tokens', 'colleges',
  ];
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t}"`);
    console.log(`  ${t.padEnd(24)} ${rows[0].n}`);
  }

  console.log('\n=== EXPLAIN: availability overlap query (the hot path) ===');
  const plan = await prisma.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT "id" FROM bookings
      WHERE "bedId" = 'x'
        AND "checkIn" < NOW() + interval '30 days'
        AND "checkOut" > NOW()
        AND "status" IN ('PENDING_PAYMENT','PENDING_OWNER','CONFIRMED','CHECKED_IN')`,
  );
  console.log(plan.map((r) => '  ' + r['QUERY PLAN']).join('\n'));

  console.log('\n=== EXPLAIN: hostel search by city/verification ===');
  const plan2 = await prisma.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT "id" FROM hostels WHERE "published" = true AND "verificationStatus" = 'APPROVED' AND "city" = 'Hyderabad'`,
  );
  console.log(plan2.map((r) => '  ' + r['QUERY PLAN']).join('\n'));

  console.log('\n=== Data at rest: what PII is stored, unencrypted ===');
  const pii = await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public'
        AND column_name IN ('phone','email','name','panLast4','gstin','bankAccountName','bankIfsc','upiId','contactPhone','contactEmail','legalName','businessName','avatarUrl','providerPayload','url')
      ORDER BY table_name, column_name`,
  );
  for (const p of pii) console.log(`  ${p.table_name}.${p.column_name} (${p.data_type})`);

  console.log('\n=== OtpCode: is the code hashed? ===');
  const otp = await prisma.otpCode.findFirst({ orderBy: { createdAt: 'desc' }, select: { phone: true, codeHash: true, attempts: true } });
  if (otp) {
    console.log(`  codeHash sample: ${otp.codeHash}`);
    console.log(`  is it a hex sha256 (64 chars)? ${/^[0-9a-f]{64}$/.test(otp.codeHash) ? 'YES' : 'NO — PLAINTEXT'}`);
  } else {
    console.log('  no OTP rows');
  }

  console.log('\n=== RefreshToken: plaintext or hashed? ===');
  const rt = await prisma.refreshToken.findFirst({ select: { tokenHash: true } });
  console.log(`  tokenHash sample: ${rt ? rt.tokenHash.slice(0, 32) + '...' : 'none'}`);
  console.log(`  is it a hex sha256 (64 chars)? ${rt && /^[0-9a-f]{64}$/.test(rt.tokenHash) ? 'YES' : 'NO'}`);

  console.log('\n=== Are OTP codes / tokens ever logged? (grep the source) ===');
  console.log('  see the log review section of the audit report');

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('inspect failed:', e.message); await prisma.$disconnect(); process.exit(1); });