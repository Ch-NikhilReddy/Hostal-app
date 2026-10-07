import { describe, expect, it } from 'vitest';
import { BookingStatus } from '@prisma/client';
import {
  BLOCKING_STATUSES,
  HOLD_MINUTES,
  assertTransition,
  blockingOverlapFilter,
  canTransition,
  rangesOverlap,
  TRANSITIONS,
} from '../../src/services/availability.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('rangesOverlap', () => {
  it('detects a clear overlap', () => {
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-10'), d('2026-08-05'), d('2026-08-15'))).toBe(true);
  });

  it('does not treat touching endpoints as overlapping', () => {
    // Checkout is morning, check-in is evening, so the same day is a legitimate
    // turn-over. An inclusive comparison would make every turn-over unbookable.
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-10'), d('2026-08-10'), d('2026-08-20'))).toBe(false);
    expect(rangesOverlap(d('2026-08-10'), d('2026-08-20'), d('2026-08-01'), d('2026-08-10'))).toBe(false);
  });

  it('detects full containment in both directions', () => {
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-30'), d('2026-08-10'), d('2026-08-12'))).toBe(true);
    expect(rangesOverlap(d('2026-08-10'), d('2026-08-12'), d('2026-08-01'), d('2026-08-30'))).toBe(true);
  });

  it('finds no overlap for disjoint ranges', () => {
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-05'), d('2026-08-20'), d('2026-08-25'))).toBe(false);
  });

  it('finds no overlap for identical zero-length ranges', () => {
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-01'), d('2026-08-01'), d('2026-08-01'))).toBe(false);
  });

  it('detects a single-day overlap', () => {
    // The second range starts on the last day of the first, so it overlaps by
    // exactly one day.
    expect(rangesOverlap(d('2026-08-01'), d('2026-08-06'), d('2026-08-05'), d('2026-08-09'))).toBe(true);
  });
});

describe('blockingOverlapFilter', () => {
  const checkIn = d('2026-08-10');
  const checkOut = d('2026-09-10');
  const now = d('2026-08-01');

  it('scopes by the half-open window', () => {
    const where = blockingOverlapFilter(checkIn, checkOut, now);
    const clauses = where.AND as Record<string, unknown>[];
    expect(clauses[0]).toEqual({ checkIn: { lt: checkOut } });
    expect(clauses[1]).toEqual({ checkOut: { gt: checkIn } });
  });

  it('treats an unpaid hold as blocking only while the hold is live', () => {
    // This is what makes an abandoned checkout release its bed on its own, with
    // no sweeper required.
    const where = blockingOverlapFilter(checkIn, checkOut, now);
    const statusClause = (where.AND as { OR: { status?: unknown }[] }[])[2]!.OR;

    const paymentHolds = statusClause.filter((c) => c.status === BookingStatus.PENDING_PAYMENT);
    expect(paymentHolds).toHaveLength(1);
    expect((paymentHolds[0] as unknown as { heldUntil: { gt: Date } }).heldUntil.gt).toBe(now);
  });

  it('lists exactly the statuses that occupy a bed', () => {
    const where = blockingOverlapFilter(checkIn, checkOut, now);
    const statusClause = (where.AND as { OR: { status?: { in?: BookingStatus[] } }[] }[])[2]!.OR;
    const blockingList = statusClause
      .map((c) => c.status?.in)
      .find((v) => Array.isArray(v));

    expect(new Set(blockingList)).toEqual(new Set(BLOCKING_STATUSES.filter((s) => s !== BookingStatus.PENDING_PAYMENT)));
  });

  it('excludes statuses that do not occupy a bed', () => {
    for (const status of [
      BookingStatus.CANCELLED_BY_STUDENT,
      BookingStatus.CANCELLED_BY_OWNER,
      BookingStatus.REJECTED,
      BookingStatus.REFUNDED,
      BookingStatus.EXPIRED,
    ]) {
      expect(BLOCKING_STATUSES).not.toContain(status);
    }
  });
});

describe('transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition(BookingStatus.PENDING_PAYMENT, BookingStatus.PENDING_OWNER)).toBe(true);
    expect(canTransition(BookingStatus.PENDING_OWNER, BookingStatus.CONFIRMED)).toBe(true);
    expect(canTransition(BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN)).toBe(true);
    expect(canTransition(BookingStatus.CHECKED_IN, BookingStatus.CHECKED_OUT)).toBe(true);
  });

  it('prevents confirming a booking that was never paid', () => {
    // The owner cannot skip the payment step.
    expect(canTransition(BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED)).toBe(false);
  });

  it('prevents skipping check-in on the way to check-out', () => {
    expect(canTransition(BookingStatus.CONFIRMED, BookingStatus.CHECKED_OUT)).toBe(false);
  });

  it('treats fully terminal states as terminal', () => {
    // These can never move anywhere. A rejected booking was never paid, so there
    // is nothing left to refund, and REFUNDED itself is the end of the line.
    for (const terminal of [BookingStatus.REJECTED, BookingStatus.REFUNDED]) {
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('allows only a refund out of a cancelled or completed booking', () => {
    // These are not terminal in the strict sense: money may have been captured
    // before the cancellation, and a completed stay still has a deposit to return.
    // REFUNDED must stay reachable — and nothing else may.
    for (const refundable of [
      BookingStatus.CANCELLED_BY_STUDENT,
      BookingStatus.CANCELLED_BY_OWNER,
      BookingStatus.CHECKED_OUT,
      BookingStatus.EXPIRED,
    ]) {
      expect(TRANSITIONS[refundable]).toEqual([BookingStatus.REFUNDED]);
    }
  });

  it('does not allow a cancelled booking to be confirmed', () => {
    expect(canTransition(BookingStatus.CANCELLED_BY_STUDENT, BookingStatus.CONFIRMED)).toBe(false);
    expect(canTransition(BookingStatus.CANCELLED_BY_OWNER, BookingStatus.CONFIRMED)).toBe(false);
    expect(canTransition(BookingStatus.REJECTED, BookingStatus.CONFIRMED)).toBe(false);
  });

  it('does not allow a completed stay to be cancelled or re-confirmed', () => {
    expect(canTransition(BookingStatus.CHECKED_OUT, BookingStatus.REFUNDED)).toBe(true);
    expect(canTransition(BookingStatus.CHECKED_OUT, BookingStatus.CANCELLED_BY_STUDENT)).toBe(false);
    expect(canTransition(BookingStatus.CHECKED_OUT, BookingStatus.CONFIRMED)).toBe(false);
  });

  it('throws a conflict with the allowed set on an illegal move', () => {
    expect(() => assertTransition(BookingStatus.PENDING_PAYMENT, BookingStatus.CHECKED_OUT)).toThrowError(
      expect.objectContaining({ status: 409, code: 'INVALID_TRANSITION' }),
    );
  });

  it('passes silently on a legal move', () => {
    expect(() => assertTransition(BookingStatus.PENDING_OWNER, BookingStatus.CONFIRMED)).not.toThrow();
  });

  it('never allows a transition into PENDING_PAYMENT from anywhere', () => {
    // Payment initiation creates a new booking, it never rewinds an existing one.
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(targets).not.toContain(BookingStatus.PENDING_PAYMENT);
      expect(from).toBeTruthy();
    }
  });
});

describe('HOLD_MINUTES', () => {
  it('is a short window', () => {
    // Long enough to type a UPI PIN, short enough that an abandoned checkout
    // does not hold inventory overnight.
    expect(HOLD_MINUTES).toBeGreaterThanOrEqual(10);
    expect(HOLD_MINUTES).toBeLessThanOrEqual(60);
  });
});