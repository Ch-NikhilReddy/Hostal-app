import { Prisma, PrismaClient } from '@prisma/client';
import { config } from './config.js';

/**
 * One Prisma client for the process.
 *
 * In development `tsx watch` re-evaluates modules on every save, and without a
 * cached global each reload would open a new connection pool. Postgres's default
 * `max_connections` is 100, so a handful of reloads exhausts it and every query
 * starts failing with `too many clients`. The global cache is the standard fix.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Wrap a set of writes in one transaction, retrying on serialization failure.
 *
 * The callback receives a `TransactionClient` rather than a full `PrismaClient`:
 * inside a transaction there is no connection to connect or disconnect, so Prisma
 * withholds those methods. Typing it as the full client is the usual reason a
 * helper "typechecks everywhere except inside $transaction".
 */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { retries?: number },
): Promise<T> {
  const retries = opts?.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        maxWait: 5_000,
        timeout: 15_000,
        // READ COMMITTED with an explicit SELECT ... FOR UPDATE on the bed is
        // what actually prevents double-booking; this isolation level plus the
        // row lock in availability.ts is the guarantee, not SERIALIZABLE, which
        // would abort innocent concurrent bookings under load.
        isolationLevel: 'ReadCommitted',
      });
    } catch (err) {
      lastError = err;
      // 40001 = serialization_failure, 40P01 = deadlock_detected. Both are safe
      // to retry because the transaction was rolled back wholesale.
      const code = (err as { code?: string })?.code;
      if (code !== '40001' && code !== '40P01') throw err;
    }
  }
  throw lastError;
}