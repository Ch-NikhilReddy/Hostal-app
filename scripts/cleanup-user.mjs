/**
 * Test-harness helper for the session-revocation probe.
 *
 *   node --import tsx scripts/cleanup-user.mjs <userId>            delete the user
 *   node --import tsx scripts/cleanup-user.mjs <userId> --is-active false
 *
 * The application has no endpoint for setting isActive or deleting a user, so a
 * probe cannot simulate an admin action over HTTP. It goes through Prisma instead.
 *
 * There is deliberately no endpoint to reactivate or delete an account. Deactivating
 * a user is a support action that belongs in the admin UI; until that exists, this
 * script is the only way, and it is a harness, not a feature.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// pathToFileURL, not path.join: a bare "C:\..." string is not a valid ESM specifier
// on Windows, and Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME. That failure was easy
// to miss because the caller discarded stderr, which made it look like cleanup had
// silently succeeded.
const { prisma } = await import(pathToFileURL(path.join(repoRoot, 'api', 'src', 'db.ts')).href);

const userId = process.argv[2];
const flagIndex = process.argv.indexOf('--is-active');

if (!userId) {
  console.error('usage: cleanup-user.mjs <userId> [--is-active true|false]');
  process.exit(1);
}

try {
  if (flagIndex !== -1) {
    const raw = process.argv[flagIndex + 1];
    const isActive = raw === 'true';
    await prisma.user.updateMany({ where: { id: userId }, data: { isActive } });
    process.stdout.write(String(isActive));
  } else {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user) {
      await prisma.refreshToken.deleteMany({ where: { userId } });
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.pushToken.deleteMany({ where: { userId } });
      await prisma.owner.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
} finally {
  await prisma.$disconnect();
}