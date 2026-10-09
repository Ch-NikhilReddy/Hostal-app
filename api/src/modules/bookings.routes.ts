import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  BookingStatus,
  NotificationChannel,
  PaymentProvider,
  PaymentStatus,
  Role,
  StayType,
} from '@prisma/client';
import { config } from '../config.js';
import { prisma, withTransaction } from '../db.js';
import { limits } from '../lib/rateLimit.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { requireAuth, requireRole, type AuthedRequest } from '../http/auth.js';
import { startOfUtcDay } from '../lib/dates.js';
import { quotePrice, resolveRateCard, type StayInput } from '../lib/pricing.js';
import {
  assertTransition,
  availableBeds,
  HOLD_MINUTES,
  lockAndAssertBedAvailable,
} from '../services/availability.js';
import { resolveCommissionBps } from '../services/commission.js';
import { mockGateway, paymentGateway, usingMockGateway } from '../services/payments.js';
import { notify } from '../services/notifications.js';
import { paiseToRupees } from '../lib/money.js';

export const bookingsRouter = Router();

/**
 * Human-readable booking reference.
 *
 * Ambiguous characters (0/O, 1/I/L) are excluded because these get read aloud over
 * the phone to PG owners and typed into WhatsApp messages.
 */
function newBookingRef(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return `HM-${out}`;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be in YYYY-MM-DD format.')
  .transform((v) => startOfUtcDay(new Date(`${v}T00:00:00Z`)))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date.');

const stayFields = {
  stayType: z.nativeEnum(StayType),
  checkIn: isoDate,
  months: z.coerce.number().int().min(1).max(12).optional(),
  days: z.coerce.number().int().min(1).max(30).optional(),
};

const quoteBody = z.object({
  roomTypeId: z.string().min(1),
  ...stayFields,
});

function toStayInput(body: { stayType: StayType; checkIn: Date; months?: number; days?: number }): StayInput {
  return { stayType: body.stayType, checkIn: body.checkIn, months: body.months, days: body.days };
}

/** Resolve room type + hostel, rejecting anything a student must not be able to book. */
async function loadBookableRoomType(roomTypeId: string) {
  const roomType = await prisma.roomType.findUnique({
    where: { id: roomTypeId },
    include: {
      hostel: {
        select: {
          id: true,
          name: true,
          slug: true,
          ownerId: true,
          published: true,
          verificationStatus: true,
          depositAmount: true,
          foodIncluded: true,
          gender: true,
          addressLine: true,
          area: true,
          city: true,
        },
      },
    },
  });

  if (!roomType) throw AppError.notFound('ROOM_TYPE_NOT_FOUND', 'That room type was not found.');

  if (!roomType.isActive) {
    throw AppError.unprocessable('ROOM_TYPE_INACTIVE', 'This room type is not currently offered.');
  }

  if (!roomType.hostel.published || roomType.hostel.verificationStatus !== 'APPROVED') {
    throw AppError.unprocessable('HOSTEL_NOT_BOOKABLE', 'This hostel is not accepting bookings.');
  }

  return roomType;
}

/** Price a stay, including which commission rate applies. */
async function buildQuote(roomTypeId: string, stay: StayInput) {
  const roomType = await loadBookableRoomType(roomTypeId);
  const commissionBps = await resolveCommissionBps(prisma, roomType.hostel.ownerId);

  const rates = resolveRateCard({
    monthlyRent: roomType.monthlyRent,
    shortStayDailyRent: roomType.shortStayDailyRent,
    dayStayDailyRent: roomType.dayStayDailyRent,
    depositAmount: roomType.depositAmount,
    foodCharges: roomType.foodCharges,
    hostelDepositAmount: roomType.hostel.depositAmount,
    hostelFoodIncluded: roomType.hostel.foodIncluded,
  });

  const quote = quotePrice({ stay, rates, commissionBps });
  return { roomType, quote };
}

function serialiseQuote(quote: ReturnType<typeof quotePrice>) {
  return {
    stayType: quote.stayType,
    checkIn: quote.checkIn.toISOString().slice(0, 10),
    checkOut: quote.checkOut.toISOString().slice(0, 10),
    months: quote.months,
    days: quote.days,
    // Paise everywhere. The client converts to rupees for display in exactly one
    // place, so there is one rounding decision in the codebase instead of many.
    amounts: {
      baseRent: quote.baseRent,
      foodCharges: quote.foodCharges,
      depositAmount: quote.depositAmount,
      serviceFee: quote.serviceFee,
      taxes: quote.taxes,
      discountAmount: quote.discountAmount,
      commissionAmount: quote.commissionAmount,
      ownerPayout: quote.ownerPayout,
      totalAmount: quote.totalAmount,
      rentSubtotal: quote.rentSubtotal,
    },
    totalsInRupees: {
      totalAmount: paiseToRupees(quote.totalAmount),
      rentSubtotal: paiseToRupees(quote.rentSubtotal),
      depositAmount: paiseToRupees(quote.depositAmount),
    },
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

bookingsRouter.post(
  '/quote',
  limits.quote,
  requireAuth,
  requireRole(Role.STUDENT, Role.OWNER, Role.ADMIN),
  validate(z.object({ body: quoteBody })),
  asyncHandler(async (req: Request, res) => {
    const body = req.body as z.infer<typeof quoteBody>;
    const { roomType, quote } = await buildQuote(body.roomTypeId, toStayInput(body));

    const beds = await availableBeds(prisma, body.roomTypeId, quote.checkIn, quote.checkOut);

    res.json({
      quote: serialiseQuote(quote),
      hostel: {
        id: roomType.hostel.id,
        name: roomType.hostel.name,
        slug: roomType.hostel.slug,
        addressLine: roomType.hostel.addressLine,
        area: roomType.hostel.area,
      },
      roomType: {
        id: roomType.id,
        name: roomType.name,
        sharingType: roomType.sharingType,
        monthlyRent: roomType.monthlyRent,
      },
      // No beds means no booking, so the client should say so before the student
      // reaches a payment screen.
      availableBeds: beds,
      availableBedCount: beds.length,
    });
  }),
);

// ---------------------------------------------------------------------------
// Create booking (holds a bed, creates the payment order)
// ---------------------------------------------------------------------------

const createBody = z.object({
  roomTypeId: z.string().min(1),
  bedId: z.string().min(1),
  ...stayFields,
  notes: z.string().trim().max(500).optional(),
});

bookingsRouter.post(
  '/',
  requireAuth,
  requireRole(Role.STUDENT),
  // 8 per hour per user. Booking is the money path and the one place where a
  // burst has a real cost. The limit sits above the concurrency probe's 8
  // simultaneous requests so that the SELECT ... FOR UPDATE guarantee stays testable.
  limits.booking,
  validate(z.object({ body: createBody })),
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;
    const body = req.body as z.infer<typeof createBody>;

    const student = await prisma.user.findUnique({
      where: { id: auth.sub },
      select: { id: true, name: true, phone: true, verified: true, isActive: true },
    });
    if (!student?.verified) {
      throw AppError.forbidden(
        'Verify your phone number before booking.',
        'STUDENT_NOT_VERIFIED',
      );
    }

    const { roomType, quote } = await buildQuote(body.roomTypeId, toStayInput(body));

    // No owner-self-booking check is needed here: the route is gated on
    // requireRole(STUDENT), so an owner cannot reach this handler at all and gets
    // 403 INSUFFICIENT_ROLE from the middleware. Owner-side booking would be a
    // separate route with its own rules.

    const heldUntil = new Date(Date.now() + HOLD_MINUTES * 60_000);

    // ---- Phase 1: take the hold, inside a transaction ----------------------
    // The bed row is locked for the duration, so a concurrent request for the same
    // bed and overlapping dates cannot get in. This is the double-booking guard.
    const booking = await withTransaction(async (tx) => {
      await lockAndAssertBedAvailable(tx, body.bedId, quote.checkIn, quote.checkOut);

      const created = await tx.booking.create({
        data: {
          bookingRef: newBookingRef(),
          studentId: student.id,
          hostelId: roomType.hostel.id,
          roomTypeId: roomType.id,
          bedId: body.bedId,
          ownerId: roomType.hostel.ownerId,
          stayType: quote.stayType,
          checkIn: quote.checkIn,
          checkOut: quote.checkOut,
          months: quote.months,
          days: quote.days,
          baseRent: quote.baseRent,
          foodCharges: quote.foodCharges,
          depositAmount: quote.depositAmount,
          serviceFee: quote.serviceFee,
          taxes: quote.taxes,
          discountAmount: quote.discountAmount,
          commissionAmount: quote.commissionAmount,
          commissionRateBps: quote.commissionRateBps,
          ownerPayout: quote.ownerPayout,
          totalAmount: quote.totalAmount,
          status: BookingStatus.PENDING_PAYMENT,
          heldUntil,
          notes: body.notes,
        },
        select: { id: true, bookingRef: true, totalAmount: true },
      });

      await tx.bookingStatusEvent.create({
        data: {
          bookingId: created.id,
          toStatus: BookingStatus.PENDING_PAYMENT,
          actorRole: 'STUDENT',
          actorId: student.id,
          reason: `Bed held for ${quote.days || quote.months} ${quote.stayType === StayType.MONTHLY ? 'month(s)' : 'day(s)'}.`,
        },
      });

      return created;
    });

    // ---- Phase 2: create the gateway order OUTSIDE the transaction ----------
    // Holding a database transaction open across a network call to a third party
    // risks lock contention and a long tail of aborted transactions. If the
    // gateway call fails, the hold is released explicitly below, so the bed never
    // stays stuck.
    let order;
    try {
      order = await paymentGateway.createOrder({
        amount: booking.totalAmount,
        currency: 'INR',
        receipt: booking.bookingRef,
        notes: {
          bookingRef: booking.bookingRef,
          hostelId: roomType.hostel.id,
          roomTypeId: roomType.id,
        },
      });
    } catch (err) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.EXPIRED, heldUntil: null },
      });
      await prisma.bookingStatusEvent.create({
        data: {
          bookingId: booking.id,
          toStatus: BookingStatus.EXPIRED,
          actorRole: 'SYSTEM',
          reason: 'Payment gateway order could not be created; bed released.',
        },
      });
      throw err;
    }

    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        provider: paymentGateway.provider,
        providerOrderId: order.orderId,
        amount: booking.totalAmount,
        status: PaymentStatus.CREATED,
        commissionAmount: quote.commissionAmount,
      },
    });

    await notify(prisma, {
      userId: student.id,
      title: `Bed held — ${booking.bookingRef}`,
      body: `Complete payment within ${HOLD_MINUTES} minutes to confirm ${roomType.name} at ${roomType.hostel.name}.`,
      data: { type: 'PAYMENT_PENDING', bookingRef: booking.bookingRef },
      channels: [NotificationChannel.IN_APP],
    });

    res.status(201).json({
      bookingRef: booking.bookingRef,
      status: BookingStatus.PENDING_PAYMENT,
      amount: booking.totalAmount,
      heldUntil,
      payment: {
        provider: paymentGateway.provider,
        orderId: order.orderId,
        // Razorpay checkout needs keyId; the mock needs nothing from the client.
        keyId: config.paymentProvider === 'razorpay' ? config.RAZORPAY_KEY_ID : undefined,
        amount: order.amount,
        currency: order.currency,
      },
      quote: serialiseQuote(quote),
    });
  }),
);

// ---------------------------------------------------------------------------
// Payment capture
// ---------------------------------------------------------------------------

const payBody = z.object({
  paymentId: z.string().min(4),
  /** Required by Razorpay's checkout; ignored by the mock gateway. */
  signature: z.string().optional(),
});

/**
 * Confirm a payment was captured and move the booking to PENDING_OWNER.
 *
 * Idempotent by design: a student who taps "pay" twice, or whose app retries
 * after a dropped response, must not create two confirmations or fail with an
 * error the second time. An already-PAID payment returns the same success shape.
 */
async function capturePayment(bookingId: string, input: { paymentId: string; signature?: string }) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, hostel: { select: { name: true } } },
  });

  if (!booking?.payment) {
    throw AppError.notFound('PAYMENT_NOT_FOUND', 'No payment was started for this booking.');
  }

  const payment = booking.payment;

  if (payment.status === PaymentStatus.PAID) {
    return { alreadyCaptured: true, bookingRef: booking.bookingRef, status: booking.status };
  }

  // Verify that this payment id genuinely belongs to this order. Without this, a
  // student could post any successful payment id from their own account and have
  // the platform mark someone else's booking as paid.
  if (payment.provider === PaymentProvider.RAZORPAY) {
    if (!input.signature) {
      throw AppError.badRequest('SIGNATURE_REQUIRED', 'Payment signature is missing.');
    }
    const ok = paymentGateway.verifyPaymentSignature({
      orderId: payment.providerOrderId,
      paymentId: input.paymentId,
      signature: input.signature,
    });
    if (!ok) {
      throw AppError.badRequest('SIGNATURE_INVALID', 'Payment could not be verified.');
    }
  }

  const updated = await withTransaction(async (tx) => {
    const marked = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        providerPaymentId: input.paymentId,
        capturedAt: new Date(),
        method: 'gateway',
      },
    });

    assertTransition(booking.status, BookingStatus.PENDING_OWNER);

    const moved = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.PENDING_OWNER,
        heldUntil: null,
        // The bed stays held while the owner decides, via a booking in
        // PENDING_OWNER, so it cannot be taken by another student.
      },
      select: { id: true, bookingRef: true, status: true, ownerId: true, studentId: true },
    });

    await tx.bookingStatusEvent.create({
      data: {
        bookingId: booking.id,
        toStatus: BookingStatus.PENDING_OWNER,
        actorRole: 'SYSTEM',
        reason: `Payment captured (${marked.providerPaymentId ?? input.paymentId}).`,
      },
    });

    return moved;
  });

  // Notify after commit: a notification about a booking that then failed to
  // commit is worse than a slightly late one.
  await Promise.allSettled([
    notify(prisma, {
      userId: updated.ownerId,
      title: 'New booking request',
      body: `${booking.hostel.name} — booking ${updated.bookingRef} is awaiting your approval.`,
      data: { type: 'BOOKING_REQUEST', bookingRef: updated.bookingRef },
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.SMS],
    }),
    notify(prisma, {
      userId: updated.studentId,
      title: 'Payment received',
      body: `We have your payment for ${booking.bookingRef}. The hostel will confirm shortly.`,
      data: { type: 'PAYMENT_CAPTURED', bookingRef: updated.bookingRef },
      channels: [NotificationChannel.IN_APP],
    }),
  ]);

  return { alreadyCaptured: false, bookingRef: updated.bookingRef, status: updated.status };
}

bookingsRouter.post(
  '/:ref/pay',
  requireAuth,
  requireRole(Role.STUDENT),
  validate(z.object({ params: z.object({ ref: z.string().min(4) }), body: payBody })),
  asyncHandler(async (req: Request, res) => {
    const { ref } = req.params as { ref: string };
    const auth = (req as AuthedRequest).auth;
    const body = req.body as z.infer<typeof payBody>;

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      select: { id: true, studentId: true },
    });
    if (!booking) throw AppError.notFound('BOOKING_NOT_FOUND', 'That booking was not found.');
    if (booking.studentId !== auth.sub) {
      throw AppError.forbidden('That booking belongs to someone else.');
    }

    const result = await capturePayment(booking.id, body);
    res.json({ ok: true, ...result });
  }),
);

/**
 * Dev-only shortcut: drive the mock gateway to a paid or failed outcome.
 *
 * Gated three ways — mock gateway active, NODE_ENV not production, ADMIN role —
 * because it settles money without a gateway. All three conditions must hold.
 */
bookingsRouter.post(
  '/:ref/mock-authorize',
  requireAuth,
  requireRole(Role.ADMIN),
  validate(
    z.object({
      params: z.object({ ref: z.string().min(4) }),
      body: z.object({ outcome: z.enum(['paid', 'failed']).default('paid') }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    if (!usingMockGateway) {
      throw AppError.notFound('NOT_AVAILABLE', 'The mock gateway is not active.');
    }
    if (config.isProduction) {
      throw AppError.notFound('NOT_AVAILABLE', 'Not available in production.');
    }

    const { ref } = req.params as { ref: string };
    const { outcome } = req.body as { outcome: 'paid' | 'failed' };

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      include: { payment: true },
    });
    if (!booking?.payment) {
      throw AppError.notFound('PAYMENT_NOT_FOUND', 'No payment was started for this booking.');
    }

    const auth = mockGateway.authorize(booking.payment.providerOrderId, outcome);

    if (outcome === 'failed') {
      await withTransaction(async (tx) => {
        await tx.payment.update({
          where: { id: booking.payment!.id },
          data: { status: PaymentStatus.FAILED, failureCode: 'MOCK_DECLINED' },
        });
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.EXPIRED, heldUntil: null },
        });
        await tx.bookingStatusEvent.create({
          data: {
            bookingId: booking.id,
            toStatus: BookingStatus.EXPIRED,
            actorRole: 'SYSTEM',
            reason: 'Payment declined; bed released.',
          },
        });
      });
      return res.json({ ok: false, outcome });
    }

    const result = await capturePayment(booking.id, { paymentId: auth.paymentId });
    res.json({ ok: true, outcome, ...result });
  }),
);

// ---------------------------------------------------------------------------
// Student's bookings
// ---------------------------------------------------------------------------

bookingsRouter.get(
  '/',
  requireAuth,
  validate(
    z.object({
      query: z.object({
        status: z.nativeEnum(BookingStatus).optional(),
        upcoming: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;
    const q = req.query as unknown as {
      status?: BookingStatus;
      upcoming?: string;
      page: number;
      pageSize: number;
    };

    const where = {
      // A student sees their own bookings; an owner sees bookings for their
      // properties. They are never mixed, because an owner's pending requests
      // and a student's trips are different queues.
      ...(auth.role === Role.OWNER ? { ownerId: auth.ownerId } : { studentId: auth.sub }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.upcoming === 'true' ? { checkOut: { gte: new Date() } } : {}),
    };

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: [{ checkIn: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          hostel: { select: { id: true, name: true, slug: true, addressLine: true, area: true, latitude: true, longitude: true, photos: true, contactPhone: true } },
          roomType: { select: { id: true, name: true, sharingType: true } },
          bed: { select: { id: true, label: true, floorLabel: true } },
          payment: { select: { status: true, amount: true, method: true, capturedAt: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({ bookings, total, page: q.page, pageSize: q.pageSize });
  }),
);

bookingsRouter.get(
  '/:ref',
  requireAuth,
  validate(z.object({ params: z.object({ ref: z.string().min(4) }) })),
  asyncHandler(async (req: Request, res) => {
    const { ref } = req.params as { ref: string };
    const auth = (req as AuthedRequest).auth;

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      include: {
        hostel: { select: { id: true, name: true, slug: true, addressLine: true, area: true, latitude: true, longitude: true, photos: true, amenities: true, contactPhone: true } },
        roomType: { select: { id: true, name: true, sharingType: true, amenities: true } },
        bed: { select: { id: true, label: true, floorLabel: true } },
        payment: true,
        statusHistory: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, actorRole: true, reason: true, createdAt: true } },
      },
    });

    if (!booking) throw AppError.notFound('BOOKING_NOT_FOUND', 'That booking was not found.');

    const isOwner = booking.ownerId === auth.ownerId;
    const isStudent = booking.studentId === auth.sub;
    if (!isOwner && !isStudent && auth.role !== Role.ADMIN) {
      throw AppError.forbidden('That booking belongs to someone else.');
    }

    res.json({ booking });
  }),
);

const cancelBody = z.object({ reason: z.string().trim().min(3).max(300) });

bookingsRouter.post(
  '/:ref/cancel',
  requireAuth,
  requireRole(Role.STUDENT),
  validate(z.object({ params: z.object({ ref: z.string().min(4) }), body: cancelBody })),
  asyncHandler(async (req: Request, res) => {
    const { ref } = req.params as { ref: string };
    const auth = (req as AuthedRequest).auth;
    const { reason } = req.body as z.infer<typeof cancelBody>;

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      include: { hostel: { select: { name: true, noticePeriodDays: true } }, payment: true },
    });

    if (!booking) throw AppError.notFound('BOOKING_NOT_FOUND', 'That booking was not found.');
    if (booking.studentId !== auth.sub) {
      throw AppError.forbidden('That booking belongs to someone else.');
    }

    assertTransition(booking.status, BookingStatus.CANCELLED_BY_STUDENT);

    await withTransaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED_BY_STUDENT,
          cancelReason: reason,
          cancelledAt: new Date(),
          heldUntil: null,
        },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId: booking.id,
          toStatus: BookingStatus.CANCELLED_BY_STUDENT,
          actorRole: 'STUDENT',
          actorId: auth.sub,
          reason,
        },
      });
    });

    // The refund itself is a separate, deliberate step (see refunds.routes). It is
    // not automatic here: the money was captured to the platform, and returning it
    // is an accounting action that needs to be recorded, not a side effect of a
    // status change.
    res.json({
      ok: true,
      bookingRef: booking.bookingRef,
      status: BookingStatus.CANCELLED_BY_STUDENT,
      refundEligible: booking.payment?.status === PaymentStatus.PAID,
      noticePeriodDays: booking.hostel.noticePeriodDays,
      message:
        booking.payment?.status === PaymentStatus.PAID
          ? 'Booking cancelled. A refund will be processed under the hostel notice policy.'
          : 'Booking cancelled. No payment was taken.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Owner actions on a booking
// ---------------------------------------------------------------------------

const respondBody = z.object({
  action: z.enum(['accept', 'decline']),
  reason: z.string().trim().max(300).optional(),
});

bookingsRouter.post(
  '/:ref/respond',
  requireAuth,
  requireRole(Role.OWNER),
  validate(z.object({ params: z.object({ ref: z.string().min(4) }), body: respondBody })),
  asyncHandler(async (req: Request, res) => {
    const { ref } = req.params as { ref: string };
    const auth = (req as AuthedRequest).auth;
    const { action, reason } = req.body as z.infer<typeof respondBody>;

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      select: { id: true, bookingRef: true, ownerId: true, studentId: true, status: true, hostel: { select: { name: true } } },
    });

    if (!booking) throw AppError.notFound('BOOKING_NOT_FOUND', 'That booking was not found.');
    if (booking.ownerId !== auth.ownerId) {
      throw AppError.forbidden('That booking is not for one of your properties.');
    }

    const next = action === 'accept' ? BookingStatus.CONFIRMED : BookingStatus.REJECTED;
    assertTransition(booking.status, next);

    await withTransaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: next, confirmedAt: next === BookingStatus.CONFIRMED ? new Date() : null },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId: booking.id,
          toStatus: next,
          actorRole: 'OWNER',
          actorId: auth.sub,
          reason: reason ?? (action === 'accept' ? 'Owner confirmed.' : 'Owner declined.'),
        },
      });
    });

    await Promise.allSettled([
      notify(prisma, {
        userId: booking.studentId,
        title: action === 'accept' ? 'Booking confirmed' : 'Booking declined',
        body:
          action === 'accept'
            ? `${booking.hostel.name} confirmed your booking ${booking.bookingRef}.`
            : `${booking.hostel.name} could not take your booking ${booking.bookingRef}.${reason ? ` Reason: ${reason}` : ''}`,
        data: { type: action === 'accept' ? 'BOOKING_CONFIRMED' : 'BOOKING_DECLINED', bookingRef: booking.bookingRef },
        channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
      }),
    ]);

    res.json({ ok: true, bookingRef: booking.bookingRef, status: next });
  }),
);

const lifecycleBody = z.object({
  action: z.enum(['check-in', 'check-out']),
});

bookingsRouter.post(
  '/:ref/lifecycle',
  requireAuth,
  requireRole(Role.OWNER),
  validate(z.object({ params: z.object({ ref: z.string().min(4) }), body: lifecycleBody })),
  asyncHandler(async (req: Request, res) => {
    const { ref } = req.params as { ref: string };
    const auth = (req as AuthedRequest).auth;
    const { action } = req.body as z.infer<typeof lifecycleBody>;

    const booking = await prisma.booking.findUnique({
      where: { bookingRef: ref },
      select: { id: true, bookingRef: true, ownerId: true, status: true, depositAmount: true, hostel: { select: { name: true } } },
    });

    if (!booking) throw AppError.notFound('BOOKING_NOT_FOUND', 'That booking was not found.');
    if (booking.ownerId !== auth.ownerId) {
      throw AppError.forbidden('That booking is not for one of your properties.');
    }

    const next =
      action === 'check-in' ? BookingStatus.CHECKED_IN : BookingStatus.CHECKED_OUT;
    assertTransition(booking.status, next);

    await withTransaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: next,
          // Marking the deposit settled at checkout is what makes it refundable.
          // Recording it at check-in would let an owner claim a deposit twice.
          ...(action === 'check-out' ? { depositSettledAt: new Date() } : {}),
        },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId: booking.id,
          toStatus: next,
          actorRole: 'OWNER',
          actorId: auth.sub,
          reason: action === 'check-in' ? 'Student checked in.' : 'Student checked out.',
        },
      });
    });

    res.json({ ok: true, bookingRef: booking.bookingRef, status: next });
  }),
);

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Razorpay webhook.
 *
 * Must use the RAW body: the signature is computed over the exact bytes sent, and
 * any re-serialisation changes them and fails verification. app.ts mounts this
 * route before the JSON body parser for that reason.
 */
export const webhookRouter = Router();

webhookRouter.post(
  '/razorpay',
  asyncHandler(async (req: Request, res) => {
    const signature = req.header('x-razorpay-signature');
    const event = (await paymentGateway.verifyWebhook(
      req.body as Buffer,
      signature,
    )) as
      | { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } } }
      | null;

    if (!event) {
      // Always 200 on an unverifiable payload. Answering 400 makes Razorpay retry
      // a message that will never be valid, and the rejection is already logged.
      console.warn('[webhook] rejected: bad or missing signature');
      res.status(200).json({ received: false });
      return;
    }

    const paymentEntity = event.payload?.payment?.entity;

    if (event.event === 'payment.captured' && paymentEntity?.order_id) {
      const payment = await prisma.payment.findUnique({
        where: { providerOrderId: paymentEntity.order_id },
        include: { booking: { select: { id: true, bookingRef: true, status: true, totalAmount: true } } },
      });

      // The amount must match what we expect. A captured amount that differs from
      // the booking total means either a bug or a tampered client; either way the
      // booking must not be confirmed.
      if (payment && paymentEntity.amount !== undefined && payment.amount !== paymentEntity.amount) {
        console.error(
          `[webhook] AMOUNT MISMATCH booking=${payment.booking.bookingRef} ` +
            `expected=${payment.amount} got=${paymentEntity.amount}`,
        );
        res.status(200).json({ received: true, action: 'amount_mismatch' });
        return;
      }

      if (payment && payment.status !== PaymentStatus.PAID) {
        await capturePayment(payment.bookingId, {
          paymentId: paymentEntity.id ?? 'unknown',
        });
        res.json({ received: true, action: 'captured' });
        return;
      }
    }

    if (event.event === 'payment.failed' && paymentEntity?.order_id) {
      await prisma.payment.updateMany({
        where: { providerOrderId: paymentEntity.order_id, status: { not: PaymentStatus.PAID } },
        data: { status: PaymentStatus.FAILED, failureCode: paymentEntity.status ?? 'gateway_failed' },
      });
    }

    res.json({ received: true });
  }),
);