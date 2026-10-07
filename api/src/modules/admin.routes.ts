import { Router, type Request } from 'express';
import { z } from 'zod';
import { BookingStatus, NotificationChannel, Role, VerificationStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { requireAuth, requireRole, type AuthedRequest } from '../http/auth.js';
import { percentToBps } from '../lib/money.js';
import { activeCommissionConfig, commissionTotals, setCommissionRate } from '../services/commission.js';
import { notify } from '../services/notifications.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(Role.ADMIN));

// ---------------------------------------------------------------------------
// Owner verification
// ---------------------------------------------------------------------------

adminRouter.get(
  '/owners',
  validate(
    z.object({
      query: z.object({
        status: z.nativeEnum(VerificationStatus).optional(),
        search: z.string().trim().max(80).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const q = req.query as unknown as {
      status?: VerificationStatus;
      search?: string;
      page: number;
      pageSize: number;
    };

    const where = {
      ...(q.status ? { verificationStatus: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { businessName: { contains: q.search, mode: 'insensitive' as const } },
              { legalName: { contains: q.search, mode: 'insensitive' as const } },
              { contactPhone: { contains: q.search } },
              { user: { name: { contains: q.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [owners, total] = await Promise.all([
      prisma.owner.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          legalName: true,
          businessName: true,
          contactPhone: true,
          contactEmail: true,
          panLast4: true,
          gstin: true,
          bankAccountName: true,
          bankIfsc: true,
          upiId: true,
          verificationStatus: true,
          verifiedAt: true,
          rejectionReason: true,
          commissionOverrideBps: true,
          createdAt: true,
          userId: true,
          _count: { select: { hostels: true, documents: true } },
          documents: {
            select: { id: true, type: true, url: true, name: true, status: true, rejectionReason: true },
          },
        },
      }),
      prisma.owner.count({ where }),
    ]);

    res.json({ owners, total, page: q.page, pageSize: q.pageSize });
  }),
);

const verifyOwnerBody = z.object({
  status: z.enum([VerificationStatus.APPROVED, VerificationStatus.REJECTED, VerificationStatus.SUSPENDED]),
  reason: z.string().trim().max(500).optional(),
});

adminRouter.post(
  '/owners/:id/verify',
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: verifyOwnerBody })),
  asyncHandler(async (req: Request, res) => {
    const { id } = req.params as { id: string };
    const body = req.body as z.infer<typeof verifyOwnerBody>;
    const admin = (req as AuthedRequest).auth;

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, userId: true, businessName: true, verificationStatus: true, _count: { select: { documents: true } } },
    });

    if (!owner) throw AppError.notFound('OWNER_NOT_FOUND', 'That owner was not found.');

    // Approving an owner with no documents on file would defeat the purpose of the
    // check. Rejecting or suspending does not require documents.
    if (body.status === VerificationStatus.APPROVED && owner._count.documents === 0) {
      throw AppError.unprocessable(
        'NO_DOCUMENTS',
        'This owner has not uploaded any verification documents yet.',
      );
    }

    if (body.status === VerificationStatus.REJECTED && !body.reason) {
      throw AppError.badRequest('REASON_REQUIRED', 'Give a reason so the owner knows what to fix.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.owner.update({
        where: { id },
        data: {
          verificationStatus: body.status,
          verifiedAt: body.status === VerificationStatus.APPROVED ? new Date() : null,
          rejectionReason: body.status === VerificationStatus.REJECTED ? body.reason : null,
        },
      });

      // Any document still awaiting review is resolved along with the owner, so
      // the admin does not have to open each file separately.
      await tx.ownerDocument.updateMany({
        where: { ownerId: id, status: VerificationStatus.PENDING },
        data: {
          status: body.status,
          rejectionReason: body.status === VerificationStatus.REJECTED ? body.reason : null,
          reviewedAt: new Date(),
          reviewedById: admin.sub,
        },
      });

      // Suspending an owner takes their live listings down immediately. Leaving a
      // suspended owner's hostels published means students can still book a
      // property the platform has pulled off the board.
      if (body.status === VerificationStatus.SUSPENDED) {
        await tx.hostel.updateMany({
          where: { ownerId: id, published: true },
          data: { published: false, publishedAt: null },
        });
      }
    });

    await notify(prisma, {
      userId: owner.userId,
      title:
        body.status === VerificationStatus.APPROVED
          ? 'Verification approved'
          : body.status === VerificationStatus.REJECTED
            ? 'Verification needs attention'
            : 'Account suspended',
      body:
        body.status === VerificationStatus.APPROVED
          ? `${owner.businessName} is verified. You can now publish your properties.`
          : body.status === VerificationStatus.REJECTED
            ? `Reason: ${body.reason ?? 'Not specified.'}`
            : 'Your listings have been taken down pending review.',
      data: { type: 'VERIFICATION_UPDATE', status: body.status },
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
    });

    res.json({ ok: true, ownerId: id, status: body.status });
  }),
);

const commissionOverrideBody = z.object({
  commissionOverrideBps: z.number().int().min(0).max(5_000).nullable(),
});

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

adminRouter.get(
  '/commission',
  asyncHandler(async (_req, res) => {
    const active = await activeCommissionConfig(prisma);
    const history = await prisma.commissionConfig.findMany({
      orderBy: { effectiveFrom: 'desc' },
      take: 20,
    });
    res.json({ active, history });
  }),
);

const setCommissionBody = z.object({
  percent: z.number().min(0).max(50),
  label: z.string().trim().min(2).max(80),
});

adminRouter.post(
  '/commission',
  validate(z.object({ body: setCommissionBody })),
  asyncHandler(async (req: Request, res) => {
    const body = req.body as z.infer<typeof setCommissionBody>;
    const admin = (req as AuthedRequest).auth;

    await setCommissionRate(prisma, {
      percentageBps: percentToBps(body.percent),
      label: body.label,
      createdById: admin.sub,
    });

    res.json({ ok: true, percentageBps: percentToBps(body.percent) });
  }),
);

adminRouter.post(
  '/owners/:id/commission-override',
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: commissionOverrideBody,
    }),
  ),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const { commissionOverrideBps } = req.body as z.infer<typeof commissionOverrideBody>;

    const owner = await prisma.owner.update({
      where: { id },
      data: { commissionOverrideBps },
      select: { id: true, commissionOverrideBps: true },
    });

    res.json({ ok: true, owner });
  }),
);

// ---------------------------------------------------------------------------
// Property moderation
// ---------------------------------------------------------------------------

const moderateHostelBody = z.object({
  status: z.enum([VerificationStatus.APPROVED, VerificationStatus.REJECTED, VerificationStatus.SUSPENDED]),
  published: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

adminRouter.post(
  '/hostels/:id/moderate',
  validate(
    z.object({ params: z.object({ id: z.string().min(1) }), body: moderateHostelBody }),
  ),
  asyncHandler(async (req: Request, res) => {
    const { id } = req.params as { id: string };
    const body = req.body as z.infer<typeof moderateHostelBody>;

    const hostel = await prisma.hostel.findUnique({
      where: { id },
      select: { id: true, name: true, ownerId: true, owner: { select: { userId: true, verificationStatus: true } } },
    });
    if (!hostel) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That property was not found.');

    if (body.status === VerificationStatus.REJECTED && !body.reason) {
      throw AppError.badRequest('REASON_REQUIRED', 'Give a reason so the owner knows what to fix.');
    }

    // A property can only be published if its owner is verified, whatever the
    // moderator sets here.
    const wantsPublished = body.published ?? false;
    if (wantsPublished && hostel.owner.verificationStatus !== VerificationStatus.APPROVED) {
      throw AppError.unprocessable(
        'OWNER_NOT_VERIFIED',
        'This owner is not verified, so the property cannot be published.',
      );
    }

    const updated = await prisma.hostel.update({
      where: { id },
      data: {
        verificationStatus: body.status,
        published: wantsPublished,
        publishedAt: wantsPublished ? new Date() : null,
      },
      select: { id: true, name: true, verificationStatus: true, published: true },
    });

    await notify(prisma, {
      userId: hostel.owner.userId,
      title: `Your property "${hostel.name}" was reviewed`,
      body:
        body.status === VerificationStatus.APPROVED
          ? wantsPublished
            ? 'Approved and live. Students can now find and book it.'
            : 'Approved. Publish it whenever you are ready.'
          : `Status: ${body.status}.${body.reason ? ` Reason: ${body.reason}` : ''}`,
      data: { type: 'HOSTEL_MODERATED', hostelId: id, status: body.status },
      channels: [NotificationChannel.IN_APP],
    });

    res.json({ ok: true, hostel: updated });
  }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

adminRouter.get(
  '/reports/overview',
  validate(
    z.object({
      query: z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    // Default window: last 30 days. An unbounded query over every booking ever
    // is fine at launch scale and an outage at Hyderabad scale.
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const range = { from, to };

    const [
      totals,
      bookingsByStatus,
      topHostels,
      newOwners,
      newStudents,
      cancelledCount,
      collegeBreakdown,
    ] = await Promise.all([
      commissionTotals(prisma, range),
      prisma.booking.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
      prisma.booking.groupBy({
        by: ['hostelId'],
        where: {
          createdAt: { gte: from, lt: to },
          status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
        },
        _sum: { ownerPayout: true, commissionAmount: true },
        _count: { _all: true },
        // No `take`: Prisma requires an orderBy alongside take, and Prisma cannot
        // order a groupBy on a named aggregate. The full set is aggregated and then
        // sorted and sliced in JS, which is correct and bounded by hostel count.
      }),
      prisma.owner.count({ where: { createdAt: { gte: from, lt: to } } }),
      prisma.user.count({ where: { role: 'STUDENT', createdAt: { gte: from, lt: to } } }),
      prisma.booking.count({
        where: {
          createdAt: { gte: from, lt: to },
          status: { in: ['CANCELLED_BY_STUDENT', 'CANCELLED_BY_OWNER', 'REJECTED', 'EXPIRED'] },
        },
      }),
      prisma.college.findMany({
        where: { isActive: true },
        select: { id: true, name: true, _count: { select: { hostels: true } } },
      }),
    ]);

    const hostelIds = topHostels.map((t) => t.hostelId);
    const hostelNames = await prisma.hostel.findMany({
      where: { id: { in: hostelIds } },
      select: { id: true, name: true, area: true },
    });
    const nameOf = new Map(hostelNames.map((h) => [h.id, h]));

    const statusCounts = Object.fromEntries(
      bookingsByStatus.map((b) => [b.status, b._count._all]),
    ) as Record<BookingStatus, number>;

    const totalBookings = bookingsByStatus.reduce((a, b) => a + b._count._all, 0);
    const lostBookings = cancelledCount;

    res.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      totals,
      totalBookings,
      lostBookings,
      // Cancellation rate is the number that tells you whether commission and
      // payments are healthy. A rising rate means the hold logic or the owner
      // approval step is failing people.
      cancellationRate: totalBookings === 0 ? 0 : Math.round((lostBookings / totalBookings) * 1000) / 10,
      bookingsByStatus: statusCounts,
      growth: { newOwners, newStudents },
      topHostels: topHostels
        .map((t) => ({
          hostelId: t.hostelId,
          name: nameOf.get(t.hostelId)?.name ?? 'Unknown',
          area: nameOf.get(t.hostelId)?.area ?? '',
          bookings: t._count._all,
          payoutPaise: t._sum?.ownerPayout ?? 0,
          commissionPaise: t._sum?.commissionAmount ?? 0,
        }))
        // Sorted in JS rather than via groupBy orderBy, which cannot order on a
        // named aggregate. Ten rows in memory is cheaper than the extra query.
        .sort((a, b) => b.bookings - a.bookings)
        .slice(0, 10),
      colleges: collegeBreakdown
        .map((c) => ({ id: c.id, name: c.name, hostelCount: c._count.hostels }))
        .sort((a, b) => b.hostelCount - a.hostelCount),
    });
  }),
);

adminRouter.get(
  '/owners/:id/settlement',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, businessName: true, commissionOverrideBps: true },
    });
    if (!owner) throw AppError.notFound('OWNER_NOT_FOUND', 'That owner was not found.');

    const bookings = await prisma.booking.findMany({
      where: {
        ownerId: id,
        status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REFUNDED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        bookingRef: true,
        createdAt: true,
        stayType: true,
        months: true,
        days: true,
        baseRent: true,
        foodCharges: true,
        commissionAmount: true,
        commissionRateBps: true,
        ownerPayout: true,
        depositAmount: true,
        status: true,
      },
    });

    res.json({ owner, bookings });
  }),
);

// ---------------------------------------------------------------------------
// Colleges
// ---------------------------------------------------------------------------

const collegeBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  city: z.string().trim().max(60).default('Hyderabad'),
  address: z.string().trim().max(300).optional(),
  latitude: z.number().min(6.9).max(35.9),
  longitude: z.number().min(68.1).max(97.5),
});

adminRouter.post(
  '/colleges',
  validate(z.object({ body: collegeBody })),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof collegeBody>;
    const college = await prisma.college.create({ data: body });
    res.status(201).json({ college });
  }),
);