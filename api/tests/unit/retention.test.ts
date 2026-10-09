import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { sweepRetention } from '../../src/lib/retention.js';

/**
 * M-6: retention.
 *
 * The finding was 4,626 OTP rows on a development database that has never seen real
 * traffic, growing without bound. A code is useless the moment it expires, so keeping
 * it is pure liability — it is a list of login credentials for recently-active phone
 * numbers.
 *
 * The point of these tests is the boundary. A sweeper that is too eager signs real
 * users out; one that is too timid grows the table forever. Both failure modes are
 * invisible until one of them happens in production, so each window is pinned on both
 * sides here.
 */

const DAY_MS = 86_400_000;
const created: string[] = [];

async function seedOtp(phone: string, expiresAt: Date) {
  const row = await prisma.otpCode.create({
    data: {
      phone,
      codeHash: `hash_${phone}_${expiresAt.getTime()}_${Math.random()}`,
      expiresAt,
      attempts: 0,
      consumedAt: null,
    },
  });
  created.push(row.id);
  return row;
}

beforeEach(async () => {
  // Own rows only, so the sweep can be exercised without touching a developer's data.
  await prisma.otpCode.deleteMany({ where: { phone: { startsWith: '997' } } });
});

afterAll(async () => {
  await prisma.otpCode.deleteMany({ where: { phone: { startsWith: '997' } } });
  await prisma.$disconnect();
});

describe('M-6 — expired OTP codes are removed', () => {
  it('a code well past expiry is deleted', async () => {
    const old = await seedOtp('9970000001', new Date(Date.now() - 30 * DAY_MS));

    const result = await sweepRetention();

    expect(result.otpDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.otpCode.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('a code inside the retention window is KEPT', async () => {
    // The important half. Deleting a code that is still inside 24 hours would break a
    // real login in progress: a user who mistypes their number and asks for a new code
    // a few minutes later must still find the previous one valid.
    const recent = await seedOtp('9970000002', new Date(Date.now() - 2 * 3_600_000));

    await sweepRetention();

    expect(await prisma.otpCode.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('a brand-new code is KEPT', async () => {
    const fresh = await seedOtp('9970000003', new Date(Date.now() + 10 * 60_000));

    await sweepRetention();

    expect(await prisma.otpCode.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it('the boundary is where it is documented to be', async () => {
    // 24h retention: something at 25 hours goes, something at 23 hours stays. Asserted
    // with slack so a slow test run cannot land on the wrong side of the line.
    const justOver = await seedOtp('9970000004', new Date(Date.now() - 25 * 3_600_000));
    const justUnder = await seedOtp('9970000005', new Date(Date.now() - 23 * 3_600_000));

    await sweepRetention();

    expect(await prisma.otpCode.findUnique({ where: { id: justOver.id } })).toBeNull();
    expect(await prisma.otpCode.findUnique({ where: { id: justUnder.id } })).not.toBeNull();
  });

  it('reports how many rows were eligible, not just deleted', async () => {
    // A log line reading "deleted 0" cannot be told apart from "nothing to do" or
    // "the query is wrong". Counting first makes the two distinguishable.
    await seedOtp('9970000006', new Date(Date.now() - 40 * DAY_MS));

    const result = await sweepRetention();

    expect(result.otpEligible).toBe(result.otpDeleted);
  });

  it('an empty table is not an error', async () => {
    await prisma.otpCode.deleteMany({ where: { phone: { startsWith: '997' } } });

    const result = await sweepRetention();

    expect(result.otpDeleted).toBe(0);
    expect(result.refreshDeleted).toBeGreaterThanOrEqual(0);
  });
});

describe('M-6 — the sweep is idempotent', () => {
  it('running twice deletes nothing the second time', async () => {
    await seedOtp('9970000007', new Date(Date.now() - 30 * DAY_MS));

    const first = await sweepRetention();
    const second = await sweepRetention();

    expect(first.otpDeleted).toBeGreaterThanOrEqual(1);
    // The second run finds nothing new. An hourly timer will run this repeatedly, and a
    // sweep that re-reports the same deletions is a sign the WHERE clause is wrong.
    expect(second.otpDeleted).toBe(0);
  });
});

describe('M-6 — nothing else is touched', () => {
  it('users, bookings and payments are never candidates', async () => {
    const before = {
      users: await prisma.user.count(),
      bookings: await prisma.booking.count(),
      payments: await prisma.payment.count(),
    };

    await seedOtp('9970000008', new Date(Date.now() - 90 * DAY_MS));
    await sweepRetention();

    const after = {
      users: await prisma.user.count(),
      bookings: await prisma.booking.count(),
      payments: await prisma.payment.count(),
    };

    expect(after).toEqual(before);
  });

  it('an unconsumed code inside the window is still consumed-aware', async () => {
    // A code that has already been used but is still inside 24 hours is kept. That is
    // deliberate: consumed codes are the evidence that a sign-in happened.
    const used = await seedOtp('9970000009', new Date(Date.now() - 3 * 3_600_000));
    await prisma.otpCode.update({
      where: { id: used.id },
      data: { consumedAt: new Date(Date.now() - 2 * 3_600_000), attempts: 1 },
    });

    await sweepRetention();

    expect(await prisma.otpCode.findUnique({ where: { id: used.id } })).not.toBeNull();
  });
});