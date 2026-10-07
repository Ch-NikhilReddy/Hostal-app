import { BedStatus, BookingStatus, Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { startOfUtcDay } from '../lib/dates.js';

/**
 * Bed availability.
 *
 * The invariant this module defends: **one bed, one occupant, at any instant.**
 * Everything else — search counts, "3 beds left" labels, the dashboard — is a
 * read of this one rule.
 *
 * Two mechanisms, and the distinction matters:
 *
 *  1. OVERLAP. A bed is taken for the half-open interval [checkIn, checkOut). A
 *     stay ending on the 1st and one starting on the 1st do not conflict, because
 *     checkout is morning and check-in is evening. Using an inclusive end date
 *     would make every turn-over day unbookable.
 *
 *  2. SERIALIZATION. Overlap alone is not enough, because two students can both
 *     read "available" and then both write. So the write path takes a row lock on
 *     the Bed with SELECT ... FOR UPDATE inside the same transaction that checks
 *     the overlap and inserts the booking. The second transaction blocks on the
 *     lock and, once it proceeds, re-reads and sees the first booking. A UNIQUE
 *     constraint cannot express "no other row may overlap this range", so the
 *     lock is the guarantee.
 */

/** Statuses that occupy a bed. A booking in any other state does not. */
export const BLOCKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.PENDING_OWNER,
  BookingStatus.CONFIRMED,
  BookingStatus.CHECKED_IN,
];

/** Statuses a student or owner may still move to from `status`. */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING_PAYMENT: [BookingStatus.PENDING_OWNER, BookingStatus.CANCELLED_BY_STUDENT, BookingStatus.EXPIRED],
  PENDING_OWNER: [
    BookingStatus.CONFIRMED,
    BookingStatus.REJECTED,
    BookingStatus.CANCELLED_BY_OWNER,
    BookingStatus.EXPIRED,
  ],
  CONFIRMED: [
    BookingStatus.CHECKED_IN,
    BookingStatus.CANCELLED_BY_STUDENT,
    BookingStatus.CANCELLED_BY_OWNER,
  ],
  REJECTED: [],
  CANCELLED_BY_STUDENT: [BookingStatus.REFUNDED],
  CANCELLED_BY_OWNER: [BookingStatus.REFUNDED],
  CHECKED_IN: [BookingStatus.CHECKED_OUT],
  CHECKED_OUT: [BookingStatus.REFUNDED],
  REFUNDED: [],
  EXPIRED: [BookingStatus.REFUNDED],
};

/** How long an unpaid bed hold survives before it is released. */
export const HOLD_MINUTES = 15;

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `A booking cannot move from ${from} to ${to}.`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

/**
 * Half-open overlap: does [aStart, aEnd) intersect [bStart, bEnd)?
 * Touching endpoints do NOT overlap.
 */
export function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * Prisma filter for "a blocking booking exists on this bed in this window".
 *
 * `heldUntil: { gt: now }` on PENDING_PAYMENT makes an abandoned checkout
 * expire on its own without needing a sweeper to have run. Without it, a student
 * who abandons payment holds a bed forever.
 */
export function blockingOverlapFilter(checkIn: Date, checkOut: Date, now = new Date()): Prisma.BookingWhereInput {
  return {
    AND: [
      { checkIn: { lt: checkOut } },
      { checkOut: { gt: checkIn } },
      {
        OR: [
          { status: { in: BLOCKING_STATUSES.filter((s) => s !== BookingStatus.PENDING_PAYMENT) } },
          { status: BookingStatus.PENDING_PAYMENT, heldUntil: { gt: now } },
        ],
      },
    ],
  };
}

/**
 * Beds of a room type that are free for the window.
 *
 * Returns only beds that are sellable (isActive) and not in maintenance, minus
 * those with a blocking booking. The availability query is one indexed lookup on
 * (roomTypeId, status, isActive) plus one per-bed booking existence check.
 */
export async function availableBeds(
  client: Prisma.TransactionClient,
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date,
  now = new Date(),
): Promise<{ id: string; label: string; floorLabel: string | null }[]> {
  const beds = await client.bed.findMany({
    where: { roomTypeId, isActive: true, status: BedStatus.AVAILABLE },
    select: { id: true, label: true, floorLabel: true },
    orderBy: { label: 'asc' },
  });

  if (beds.length === 0) return [];

  const blocking = await client.booking.findMany({
    where: { bedId: { in: beds.map((b) => b.id) }, ...blockingOverlapFilter(checkIn, checkOut, now) },
    select: { bedId: true },
    distinct: ['bedId'],
  });

  const taken = new Set(blocking.map((b) => b.bedId));
  return beds.filter((b) => !taken.has(b.id));
}

/**
 * Count of free beds per room type — used to show "4 of 12 beds left" in search
 * results without shipping the full bed list.
 */
export async function availabilityByRoomType(
  client: Prisma.TransactionClient,
  roomTypeIds: string[],
  checkIn: Date,
  checkOut: Date,
  now = new Date(),
): Promise<Map<string, { total: number; available: number }>> {
  const out = new Map<string, { total: number; available: number }>();
  if (roomTypeIds.length === 0) return out;

  const grouped = await client.bed.groupBy({
    by: ['roomTypeId'],
    where: { roomTypeId: { in: roomTypeIds }, isActive: true, status: BedStatus.AVAILABLE },
    _count: { _all: true },
  });

  for (const row of grouped) {
    out.set(row.roomTypeId, { total: row._count._all, available: row._count._all });
  }

  const taken = await client.booking.groupBy({
    by: ['bedId'],
    where: { ...blockingOverlapFilter(checkIn, checkOut, now) },
    _count: { _all: true },
  });

  if (taken.length > 0) {
    const beds = await client.bed.findMany({
      where: { id: { in: taken.map((t) => t.bedId) } },
      select: { id: true, roomTypeId: true },
    });
    const roomTypeOf = new Map(beds.map((b) => [b.id, b.roomTypeId]));
    const tally = new Map<string, number>();
    for (const t of taken) {
      const roomTypeId = roomTypeOf.get(t.bedId);
      if (!roomTypeId) continue;
      tally.set(roomTypeId, (tally.get(roomTypeId) ?? 0) + t._count._all);
    }
    for (const [roomTypeId, unavailable] of tally) {
      const current = out.get(roomTypeId);
      if (current) {
        // A bed can carry more than one overlapping booking in principle, so clamp
        // at zero rather than reporting a negative availability.
        current.available = Math.max(0, current.total - unavailable);
      }
    }
  }

  return out;
}

/**
 * Lock a bed and assert it is free for the window.
 *
 * MUST be called inside a transaction. Returns the locked bed row. Throws
 * BED_UNAVAILABLE if another booking took it — the caller is expected to treat
 * that as a normal outcome and offer the student the next free bed, not as a
 * server error.
 */
export async function lockAndAssertBedAvailable(
  tx: Prisma.TransactionClient,
  bedId: string,
  checkIn: Date,
  checkOut: Date,
  now = new Date(),
): Promise<{ id: string; label: string; roomTypeId: string }> {
  // FOR UPDATE: blocks any concurrent transaction touching this row until we
  // commit or roll back. This is what turns a check-then-insert into an atomic
  // operation.
  // Column names are quoted to match the casing Prisma actually creates. The
  // table is mapped to "beds" but the columns keep their camelCase names, so an
  // unquoted `room_type_id` is a column that does not exist.
  const locked = await tx.$queryRaw<
    { id: string; label: string; roomTypeId: string; isActive: boolean; status: string }[]
  >(Prisma.sql`
    SELECT "id", "label", "roomTypeId", "isActive", "status"
    FROM "beds"
    WHERE "id" = ${bedId}
    FOR UPDATE
  `);

  const row = locked[0];
  if (!row) {
    throw AppError.notFound('BED_NOT_FOUND', 'That bed is no longer listed.');
  }
  if (!row.isActive) {
    throw AppError.unprocessable('BED_NOT_LISTED', 'That bed has been taken off sale by the owner.');
  }
  if (row.status !== BedStatus.AVAILABLE) {
    throw AppError.conflict('BED_UNAVAILABLE', 'That bed is not currently available.');
  }

  const clash = await tx.booking.findFirst({
    where: { bedId, ...blockingOverlapFilter(checkIn, checkOut, now) },
    select: { id: true, bookingRef: true, status: true, checkIn: true, checkOut: true },
  });

  if (clash) {
    throw AppError.conflict(
      'BED_UNAVAILABLE',
      'That bed was just booked for those dates. Please pick another bed or date.',
      {
        bookingRef: clash.bookingRef,
        checkIn: clash.checkIn,
        checkOut: clash.checkOut,
      },
    );
  }

  return { id: row.id, label: row.label, roomTypeId: row.roomTypeId };
}

/**
 * Release lapsed payment holds.
 *
 * Cheap and idempotent, so it is called opportunistically on read paths. A
 * dedicated cron can call the same function later; nothing here assumes it is
 * the only caller.
 */
export async function releaseExpiredHolds(client: Prisma.TransactionClient, now = new Date()): Promise<number> {
  // Candidates first, then updateManyAndReturn, because updateMany reports only
  // HOW MANY rows changed and never WHICH. An audit row written from a count
  // alone would be unattributed, and an unattributed EXPIRED event on a
  // money-bearing record is worse than no event at all.
  //
  // updateManyAndReturn gives back the exact rows that transitioned, so a booking
  // that got paid between the select and the update is correctly left out of the
  // trail rather than being falsely logged as expired.
  const candidates = await client.booking.findMany({
    where: {
      status: BookingStatus.PENDING_PAYMENT,
      heldUntil: { lte: now },
    },
    select: { id: true },
    take: 500,
  });

  if (candidates.length === 0) return 0;

  const transitioned = await client.booking.updateManyAndReturn({
    where: { id: { in: candidates.map((b) => b.id) }, status: BookingStatus.PENDING_PAYMENT },
    data: {
      status: BookingStatus.EXPIRED,
      heldUntil: null,
    },
    select: { id: true },
  });

  if (transitioned.length > 0) {
    await client.bookingStatusEvent.createMany({
      data: transitioned.map(({ id: bookingId }) => ({
        bookingId,
        toStatus: BookingStatus.EXPIRED,
        actorRole: 'SYSTEM',
        reason: 'Payment window elapsed before capture.',
      })),
    });
  }

  return transitioned.length;
}

/** Normalise a client-supplied date to a UTC calendar day. */
export function normaliseDay(date: Date): Date {
  return startOfUtcDay(date);
}