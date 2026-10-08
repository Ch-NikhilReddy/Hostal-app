/**
 * Deletes a throwaway owner created by a probe.
 *
 * The application exposes no endpoint for removing an owner — deliberately, since an
 * owner is a real party to bookings. Probes therefore clean up through Prisma
 * directly. Hostels cascade from the owner (schema.prisma onDelete: Cascade), so
 * removing the owner removes the properties the probe created too.
 *
 *   node --import tsx scripts/cleanup-owner.mjs <ownerId>
 *
 * Exits 0 whether or not the owner existed; a leftover row is not a probe failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { prisma } = await import(path.join(repoRoot, 'api', 'src', 'db.ts'));

const ownerId = process.argv[2];
if (!ownerId) {
  console.error('usage: cleanup-owner.mjs <ownerId>');
  process.exit(1);
}

try {
  const owner = await prisma.owner.findUnique({
    where: { id: ownerId },
    select: { userId: true },
  });

  if (owner) {
    await prisma.refreshToken.deleteMany({ where: { userId: owner.userId } });
    await prisma.notification.deleteMany({ where: { userId: owner.userId } });
    await prisma.owner.deleteMany({ where: { id: ownerId } });
    await prisma.user.deleteMany({ where: { id: owner.userId } });
  }
} finally {
  await prisma.$disconnect();
}