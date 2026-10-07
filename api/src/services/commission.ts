import { Prisma, type PrismaClient } from '@prisma/client';
import { config } from '../config.js';
import { percentToBps } from '../lib/money.js';

/**
 * Commission resolution.
 *
 * Commission is snapshotted onto each booking at creation time. That is the whole
 * point: if an owner has paid out at 8% for six months and the admin raises the
 * rate to 12% today, the six months of settled bookings must not be recomputed.
 * A booking's `commissionRateBps` is the rate that produced `commissionAmount`,
 * and it is what settlement reports read.
 *
 * Resolution order: owner override -> active CommissionConfig -> env default.
 */

export const DEFAULT_COMMISSION_BPS = percentToBps(config.DEFAULT_COMMISSION_PERCENT);

/** The config in effect right now, if there is exactly one active window. */
export async function activeCommissionConfig(client: PrismaClient, now = new Date()) {
  return client.commissionConfig.findFirst({
    where: {
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * The rate that applies to a new booking by this owner.
 * Returns bps (1000 = 10.00%).
 */
export async function resolveCommissionBps(
  client: PrismaClient,
  ownerId: string | null | undefined,
  now = new Date(),
): Promise<number> {
  if (ownerId) {
    const owner = await client.owner.findUnique({
      where: { id: ownerId },
      select: { commissionOverrideBps: true },
    });
    if (owner?.commissionOverrideBps !== null && owner?.commissionOverrideBps !== undefined) {
      return owner.commissionOverrideBps;
    }
  }

  const active = await activeCommissionConfig(client, now);
  if (active) return active.percentageBps;

  return DEFAULT_COMMISSION_BPS;
}

/**
 * Create a new config and close out the previous open-ended one.
 *
 * Both statements run in one transaction so there is never a moment with two
 * active configs or none. Without that, `activeCommissionConfig` could pick the
 * wrong row and owners would be billed at a rate that was never published.
 */
export async function setCommissionRate(
  client: PrismaClient,
  input: { percentageBps: number; label: string; createdById?: string; effectiveFrom?: Date },
  now = new Date(),
): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.commissionConfig.updateMany({
      where: { effectiveTo: null },
      data: { effectiveTo: input.effectiveFrom ?? now },
    });

    await tx.commissionConfig.create({
      data: {
        percentageBps: input.percentageBps,
        label: input.label,
        createdById: input.createdById,
        effectiveFrom: input.effectiveFrom ?? now,
        effectiveTo: null,
      },
    });
  });
}

/** Total commission retained, for admin reporting. */
export async function commissionTotals(
  client: PrismaClient,
  range: { from: Date; to: Date },
): Promise<{ grossRentPaise: number; commissionPaise: number; depositPaise: number }> {
  const rows = await client.booking.aggregate({
    where: {
      createdAt: { gte: range.from, lt: range.to },
      status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REFUNDED'] },
    },
    _sum: {
      baseRent: true,
      foodCharges: true,
      commissionAmount: true,
      depositAmount: true,
      ownerPayout: true,
    },
    _count: { _all: true },
  });

  const gross = (rows._sum.baseRent ?? 0) + (rows._sum.foodCharges ?? 0);
  return {
    grossRentPaise: gross,
    commissionPaise: rows._sum.commissionAmount ?? 0,
    depositPaise: rows._sum.depositAmount ?? 0,
  };
}

/** Per-owner payout summary, the statement an owner sees on the dashboard. */
export async function ownerEarnings(
  client: PrismaClient,
  ownerId: string,
  range?: { from: Date; to: Date },
): Promise<{
  bookingCount: number;
  grossPaise: number;
  commissionPaise: number;
  payoutPaise: number;
  depositHeldPaise: number;
}> {
  const where: Prisma.BookingWhereInput = {
    ownerId,
    status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REFUNDED'] },
    ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
  };

  const agg = await client.booking.aggregate({
    where,
    _count: { _all: true },
    _sum: {
      baseRent: true,
      foodCharges: true,
      commissionAmount: true,
      ownerPayout: true,
      depositAmount: true,
    },
  });

  return {
    bookingCount: agg._count._all,
    grossPaise: (agg._sum.baseRent ?? 0) + (agg._sum.foodCharges ?? 0),
    commissionPaise: agg._sum.commissionAmount ?? 0,
    payoutPaise: agg._sum.ownerPayout ?? 0,
    // Deposits are held, not earned. Shown separately so nobody mistakes the
    // figure for revenue.
    depositHeldPaise: agg._sum.depositAmount ?? 0,
  };
}