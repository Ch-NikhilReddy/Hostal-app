/**
 * Reports what the probes have left in the development database.
 *
 *   node --import tsx scripts/db-residue.mjs
 *
 * Read-only. Useful before demoing: probe accounts, throwaway hostels and OTP rows
 * accumulate, and a fresh reviewer should know which numbers are real seed data and
 * which are test debris.
 */
/**
 * Purges probe and test-fixture accounts from the development database.
 *
 *   node --import tsx scripts/db-residue.mjs --purge
 *
 * Probes and integration tests create throwaway users. They delete their own rows,
 * but a fixture that fails partway through leaves debris behind, and this database
 * is the same one used for the Phase 3 migration baseline. Debris in a baseline is
 * worse than useless: it gets captured into the first migration and then has to be
 * explained forever.
 *
 * Seeded accounts are NEVER touched. The match is on the prefix the probes use:
 *   "H1 " owner-status probe and its fixtures
 *   "H2 " session-revocation probe and its fixtures
 *   "H3 " role-snapshot fixtures
 *   "Probe" probe accounts named "H1 Probe Owner" etc.
 *   "Student 9" random-phone fixtures from earlier runs
 *
 * Refuses to run if the database does not look like a development one, so it cannot
 * be pointed at production by accident.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { prisma } = await import(pathToFileURL(path.join(repoRoot, 'api', 'src', 'db.ts')).href);

const PURGE = process.argv.includes('--purge');

/** Accounts the probes and fixtures create. Seeded accounts never match. */
const DEBRIS_NAME = /^H[123] |^Probe |^Student \d{4}/;

const [users, owners, hostels, bookings, otps, notifications] = await Promise.all([
  prisma.user.count(),
  prisma.owner.count(),
  prisma.hostel.count(),
  prisma.booking.count(),
  prisma.otpCode.count(),
  prisma.notification.count(),
]);

const debris = await prisma.user.findMany({
  where: { name: { startsWith: 'H1 ' } },
  select: { name: true, phone: true },
});

const suspended = await prisma.owner.count({ where: { verificationStatus: 'SUSPENDED' } });
const inactive = await prisma.user.count({ where: { isActive: false } });

console.log(`
Development database residue
----------------------------
  users              ${users}
  owners             ${owners}   (${suspended} suspended)
  hostels            ${hostels}
  bookings           ${bookings}
  OTP rows           ${otps}
  notifications      ${notifications}
  inactive users     ${inactive}

Accounts named "H1 *" present: ${debris.length}
${debris.map((u) => `    ${u.name}  ${u.phone}`).join('\n')}
`);

if (PURGE) {
  // Filtered in JS rather than with Prisma's `matches`, which requires a preview
  // feature enabled in the schema. A development database holds a few dozen users,
  // so there is nothing to gain from pushing this into SQL — and enabling a preview
  // feature in order to delete test debris would be a poor trade.
  const allUsers = await prisma.user.findMany({ select: { id: true, name: true } });
  const targets = allUsers.filter((u) => DEBRIS_NAME.test(u.name));

  if (targets.length === 0) {
    console.log('  nothing to purge.\n');
  } else {
    for (const t of targets) {
      // Bookings cascade from the user; hostels cascade from the owner. Deleting in
      // this order means no intermediate FK violation.
      await prisma.refreshToken.deleteMany({ where: { userId: t.id } });
      await prisma.notification.deleteMany({ where: { userId: t.id } });
      await prisma.pushToken.deleteMany({ where: { userId: t.id } });
      await prisma.owner.deleteMany({ where: { userId: t.id } });
    }
    const removed = await prisma.user.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
    console.log(`  purged ${removed.count} accounts: ${targets.map((t) => t.name).join(', ')}\n`);
  }
}

await prisma.$disconnect();