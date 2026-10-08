import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  BedStatus,
  DocumentType,
  Gender,
  HostelType,
  Role,
  SharingType,
  VerificationStatus,
} from '@prisma/client';
import { prisma } from '../db.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { requireAuth, requireRole, type AuthedRequest } from '../http/auth.js';
import { sanitiseAmenities } from '../lib/vocabulary.js';
import { ownerEarnings, resolveCommissionBps } from '../services/commission.js';
import { estimateTravelMinutes, haversineKm } from '../lib/geo.js';

export const ownerRouter = Router();

ownerRouter.use(requireAuth, requireRole(Role.OWNER));

/**
 * Owner states that may still use the owner API.
 *
 * DRAFT and PENDING are deliberately ALLOWED. A new owner arrives as DRAFT, uploads
 * a document which moves them to PENDING, and needs to reach GET /verification to
 * read the checklist of what is still missing. Blocking those states would lock a
 * new owner out of the only screen that tells them how to get approved.
 *
 * SUSPENDED and REJECTED are blocked. Suspending unpublishes an owner's existing
 * properties (see admin.routes.ts) but previously did nothing to their session, so
 * a suspended owner could still create new properties and accept bookings. That is
 * the H-1 defect.
 */
const OWNER_BLOCKED_STATUSES: readonly VerificationStatus[] = [
  VerificationStatus.SUSPENDED,
  VerificationStatus.REJECTED,
];

/**
 * Load the caller's Owner record, rejecting owners whose account is not in good
 * standing.
 *
 * A user with the OWNER role and no Owner row is a broken account, not an empty
 * dashboard — it means signup did not complete — so it is a 500 rather than a
 * silent empty state.
 *
 * This is the single funnel for all 12 owner handlers, which is why the status
 * check lives here rather than in each route: adding a handler without repeating
 * the guard is exactly how the original gap appeared.
 */
async function requireOwner(auth: { sub: string; ownerId?: string }) {
  // The token's ownerId is a hint, not proof: fall back to the userId lookup so a
  // token minted before the Owner row existed still resolves.
  const byId = auth.ownerId ? await prisma.owner.findUnique({ where: { id: auth.ownerId } }) : null;
  const owner = byId ?? (await prisma.owner.findUnique({ where: { userId: auth.sub } }));

  if (!owner) {
    throw AppError.internal('Your owner account is incomplete. Please contact support.');
  }

  // Read fresh from the database on every call, never from the token. The token
  // outlives a suspension, so trusting it would leave this exact hole open.
  if (OWNER_BLOCKED_STATUSES.includes(owner.verificationStatus)) {
    throw AppError.forbidden(
      owner.verificationStatus === VerificationStatus.SUSPENDED
        ? 'Your owner account is suspended. Please contact support.'
        : 'Your owner account was not approved. Please check your verification documents.',
      'OWNER_NOT_IN_GOOD_STANDING',
    );
  }

  return owner;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'hostel';
  let candidate = base;
  for (let i = 0; i < 20; i += 1) {
    const clash = await prisma.hostel.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Verification documents
// ---------------------------------------------------------------------------

const documentBody = z.object({
  type: z.nativeEnum(DocumentType),
  url: z.string().url().max(500),
  name: z.string().trim().max(120).optional(),
});

ownerRouter.post(
  '/documents',
  validate(z.object({ body: documentBody })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const body = req.body as z.infer<typeof documentBody>;

    const doc = await prisma.ownerDocument.create({
      data: { ownerId: owner.id, type: body.type, url: body.url, name: body.name },
    });

    // Uploading any document moves the owner into the review queue, but only if
    // they are still a draft — a resubmission must not silently un-approve an
    // owner that was already live.
    if (owner.verificationStatus === VerificationStatus.DRAFT) {
      await prisma.owner.update({
        where: { id: owner.id },
        data: { verificationStatus: VerificationStatus.PENDING },
      });
    }

    res.status(201).json({ document: doc });
  }),
);

ownerRouter.get(
  '/verification',
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);

    const [documents, hostels] = await Promise.all([
      prisma.ownerDocument.findMany({
        where: { ownerId: owner.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, url: true, name: true, status: true, rejectionReason: true, reviewedAt: true },
      }),
      prisma.hostel.findMany({
        where: { ownerId: owner.id },
        select: { id: true, name: true, verificationStatus: true, published: true },
      }),
    ]);

    // The checklist drives the owner dashboard UI: it says exactly what is
    // missing rather than leaving the owner to guess why nothing is live.
    const requiredDocs: DocumentType[] = [DocumentType.PAN_CARD, DocumentType.BANK_PROOF];
    const uploaded = new Set(documents.map((d) => d.type));
    const checklist = requiredDocs.map((type) => ({
      type,
      uploaded: uploaded.has(type),
      done: documents.some((d) => d.type === type && d.status === VerificationStatus.APPROVED),
    }));

    res.json({
      verificationStatus: owner.verificationStatus,
      verifiedAt: owner.verifiedAt,
      rejectionReason: owner.rejectionReason,
      commissionOverrideBps: owner.commissionOverrideBps,
      documents,
      checklist,
      hostels,
      canPublish: owner.verificationStatus === VerificationStatus.APPROVED,
    });
  }),
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const hostelBody = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(4000).optional(),
  type: z.nativeEnum(HostelType).default(HostelType.HOSTEL),
  gender: z.nativeEnum(Gender).default(Gender.MIXED),
  addressLine: z.string().trim().min(5).max(200),
  area: z.string().trim().min(2).max(60),
  city: z.string().trim().max(60).default('Hyderabad'),
  pincode: z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits.').optional(),
  latitude: z.number().min(6.9).max(35.9),
  longitude: z.number().min(68.1).max(97.5),
  amenities: z.array(z.string()).max(30).optional(),
  photos: z.array(z.string().url().max(500)).max(20).optional(),
  foodIncluded: z.boolean().default(false),
  depositAmount: z.number().int().min(0).max(10_000_000).default(0),
  noticePeriodDays: z.number().int().min(0).max(180).default(7),
  collegeId: z.string().cuid().optional(),
});

ownerRouter.post(
  '/hostels',
  validate(z.object({ body: hostelBody })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const body = req.body as z.infer<typeof hostelBody>;

    const hostel = await prisma.hostel.create({
      data: {
        ownerId: owner.id,
        name: body.name,
        slug: await uniqueSlug(body.name),
        description: body.description,
        type: body.type,
        gender: body.gender,
        addressLine: body.addressLine,
        area: body.area,
        city: body.city,
        pincode: body.pincode,
        latitude: body.latitude,
        longitude: body.longitude,
        amenities: sanitiseAmenities(body.amenities),
        photos: body.photos ?? [],
        foodIncluded: body.foodIncluded,
        depositAmount: body.depositAmount,
        noticePeriodDays: body.noticePeriodDays,
        collegeId: body.collegeId,
        // A new property is never public: it starts its life under admin review,
        // and the owner cannot set published=true on the create call.
        published: false,
        verificationStatus: VerificationStatus.PENDING,
      },
    });

    res.status(201).json({ hostel });
  }),
);

const hostelUpdateBody = hostelBody.partial().extend({
  published: z.boolean().optional(),
});

ownerRouter.patch(
  '/hostels/:id',
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: hostelUpdateBody,
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };
    const body = req.body as Partial<z.infer<typeof hostelBody>> & { published?: boolean };

    const existing = await prisma.hostel.findUnique({ where: { id }, select: { ownerId: true } });
    if (!existing) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That property was not found.');
    if (existing.ownerId !== owner.id) {
      throw AppError.forbidden('That property belongs to another owner.');
    }

    // Publishing is gated on the owner being verified. Without this an unverified
    // owner could set published=true and a student could search and find a
    // property that was never reviewed.
    let published = body.published;
    if (published === true) {
      if (owner.verificationStatus !== VerificationStatus.APPROVED) {
        throw AppError.forbidden(
          'Complete verification before publishing a property.',
          'OWNER_NOT_VERIFIED',
        );
      }
    }

    const hostel = await prisma.hostel.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.addressLine !== undefined ? { addressLine: body.addressLine } : {}),
        ...(body.area !== undefined ? { area: body.area } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.pincode !== undefined ? { pincode: body.pincode } : {}),
        ...(body.latitude !== undefined ? { latitude: body.latitude } : {}),
        ...(body.longitude !== undefined ? { longitude: body.longitude } : {}),
        ...(body.amenities !== undefined ? { amenities: sanitiseAmenities(body.amenities) } : {}),
        ...(body.photos !== undefined ? { photos: body.photos } : {}),
        ...(body.foodIncluded !== undefined ? { foodIncluded: body.foodIncluded } : {}),
        ...(body.depositAmount !== undefined ? { depositAmount: body.depositAmount } : {}),
        ...(body.noticePeriodDays !== undefined ? { noticePeriodDays: body.noticePeriodDays } : {}),
        ...(body.collegeId !== undefined ? { collegeId: body.collegeId } : {}),
        ...(published !== undefined
          ? { published, publishedAt: published ? new Date() : null }
          : {}),
      },
    });

    res.json({ hostel });
  }),
);

ownerRouter.get(
  '/hostels',
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);

    const hostels = await prisma.hostel.findMany({
      where: { ownerId: owner.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        area: true,
        city: true,
        published: true,
        verificationStatus: true,
        photos: true,
        ratingAverage: true,
        ratingCount: true,
        roomTypes: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            monthlyRent: true,
            _count: { select: { beds: { where: { isActive: true, status: BedStatus.AVAILABLE } } } },
          },
        },
        _count: { select: { bookings: true } },
      },
    });

    res.json({ hostels });
  }),
);

ownerRouter.get(
  '/hostels/:id',
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };

    const hostel = await prisma.hostel.findFirst({
      where: { id, ownerId: owner.id },
      include: { roomTypes: { include: { beds: { orderBy: { label: 'asc' } } } } },
    });

    if (!hostel) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That property was not found.');

    // Distance from every nearby college: the single most useful number for an
    // owner deciding which campus to market to.
    const colleges = await prisma.college.findMany({
      where: { city: hostel.city, isActive: true },
      select: { id: true, name: true, latitude: true, longitude: true },
    });

    const nearby = colleges
      .map((c) => {
        const distanceKm = haversineKm(hostel.latitude, hostel.longitude, c.latitude, c.longitude);
        return { id: c.id, name: c.name, distanceKm: Math.round(distanceKm * 100) / 100, travelMinutes: estimateTravelMinutes(distanceKm) };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);

    res.json({ hostel, nearbyColleges: nearby });
  }),
);

ownerRouter.delete(
  '/hostels/:id',
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };

    const hostel = await prisma.hostel.findUnique({
      where: { id },
      select: { ownerId: true, _count: { select: { bookings: true } } },
    });
    if (!hostel) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That property was not found.');
    if (hostel.ownerId !== owner.id) {
      throw AppError.forbidden('That property belongs to another owner.');
    }

    // A property with bookings is archived, never deleted: the booking rows carry
    // money figures and must keep a valid foreign key.
    if (hostel._count.bookings > 0) {
      await prisma.hostel.update({
        where: { id },
        data: { published: false, publishedAt: null },
      });
      return res.json({
        archived: true,
        message: 'This property has bookings, so it was unpublished instead of deleted. Its history is preserved.',
      });
    }

    await prisma.hostel.delete({ where: { id } });
    res.json({ deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Room types and beds
// ---------------------------------------------------------------------------

const roomTypeBody = z.object({
  name: z.string().trim().min(2).max(60),
  sharingType: z.nativeEnum(SharingType),
  gender: z.nativeEnum(Gender).default(Gender.MIXED),
  /** Rupees. Converted to paise here so the whole codebase stores paise only. */
  monthlyRent: z.number().int().min(500).max(100_000),
  shortStayDailyRent: z.number().int().min(50).max(20_000).nullable().optional(),
  dayStayDailyRent: z.number().int().min(50).max(20_000).nullable().optional(),
  depositAmount: z.number().int().min(0).max(10_000_000).nullable().optional(),
  foodCharges: z.number().int().min(0).max(50_000).nullable().optional(),
  amenities: z.array(z.string()).max(20).optional(),
  photos: z.array(z.string().url().max(500)).max(10).optional(),
  isActive: z.boolean().optional(),
});

ownerRouter.post(
  '/hostels/:hostelId/room-types',
  validate(z.object({ params: z.object({ hostelId: z.string().min(1) }), body: roomTypeBody })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { hostelId } = req.params as { hostelId: string };
    const body = req.body as z.infer<typeof roomTypeBody>;

    const hostel = await prisma.hostel.findUnique({
      where: { id: hostelId },
      select: { ownerId: true },
    });
    if (!hostel) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That property was not found.');
    if (hostel.ownerId !== owner.id) {
      throw AppError.forbidden('That property belongs to another owner.');
    }

    const roomType = await prisma.roomType.create({
      data: {
        hostelId,
        name: body.name,
        sharingType: body.sharingType,
        gender: body.gender,
        monthlyRent: body.monthlyRent * 100,
        shortStayDailyRent:
          body.shortStayDailyRent === null || body.shortStayDailyRent === undefined
            ? null
            : body.shortStayDailyRent * 100,
        dayStayDailyRent:
          body.dayStayDailyRent === null || body.dayStayDailyRent === undefined
            ? null
            : body.dayStayDailyRent * 100,
        depositAmount:
          body.depositAmount === null || body.depositAmount === undefined
            ? null
            : body.depositAmount * 100,
        foodCharges:
          body.foodCharges === null || body.foodCharges === undefined
            ? null
            : body.foodCharges * 100,
        amenities: sanitiseAmenities(body.amenities),
        photos: body.photos ?? [],
      },
    });

    res.status(201).json({ roomType });
  }),
);

ownerRouter.patch(
  '/room-types/:id',
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: roomTypeBody.partial() })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };
    const body = req.body as Partial<z.infer<typeof roomTypeBody>>;

    const roomType = await prisma.roomType.findUnique({
      where: { id },
      select: { hostel: { select: { ownerId: true } } },
    });
    if (!roomType) throw AppError.notFound('ROOM_TYPE_NOT_FOUND', 'That room type was not found.');
    if (roomType.hostel.ownerId !== owner.id) {
      throw AppError.forbidden('That room type belongs to another owner.');
    }

    const updated = await prisma.roomType.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sharingType !== undefined ? { sharingType: body.sharingType } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.monthlyRent !== undefined ? { monthlyRent: body.monthlyRent * 100 } : {}),
        ...(body.shortStayDailyRent !== undefined
          ? { shortStayDailyRent: body.shortStayDailyRent === null ? null : body.shortStayDailyRent * 100 }
          : {}),
        ...(body.dayStayDailyRent !== undefined
          ? { dayStayDailyRent: body.dayStayDailyRent === null ? null : body.dayStayDailyRent * 100 }
          : {}),
        ...(body.depositAmount !== undefined
          ? { depositAmount: body.depositAmount === null ? null : body.depositAmount * 100 }
          : {}),
        ...(body.foodCharges !== undefined
          ? { foodCharges: body.foodCharges === null ? null : body.foodCharges * 100 }
          : {}),
        ...(body.amenities !== undefined ? { amenities: sanitiseAmenities(body.amenities) } : {}),
        ...(body.photos !== undefined ? { photos: body.photos } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });

    res.json({ roomType: updated });
  }),
);

const bedCreateBody = z.object({
  labels: z.array(z.string().trim().min(1).max(20)).min(1).max(200),
  floorLabel: z.string().trim().max(20).optional(),
});

ownerRouter.post(
  '/room-types/:id/beds',
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: bedCreateBody })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };
    const { labels, floorLabel } = req.body as z.infer<typeof bedCreateBody>;

    const roomType = await prisma.roomType.findUnique({
      where: { id },
      select: { hostel: { select: { ownerId: true } } },
    });
    if (!roomType) throw AppError.notFound('ROOM_TYPE_NOT_FOUND', 'That room type was not found.');
    if (roomType.hostel.ownerId !== owner.id) {
      throw AppError.forbidden('That room type belongs to another owner.');
    }

    // Deduplicate within the request as well as against the DB: the unique index
    // is on (roomTypeId, label) and a duplicate would abort the whole insert.
    const unique = [...new Set(labels)];

    const result = await prisma.bed.createMany({
      data: unique.map((label) => ({ roomTypeId: id, label, floorLabel })),
      skipDuplicates: true,
    });

    res.status(201).json({ created: result.count, skipped: unique.length - result.count });
  }),
);

const bedUpdateBody = z.object({
  status: z.nativeEnum(BedStatus).optional(),
  isActive: z.boolean().optional(),
  label: z.string().trim().min(1).max(20).optional(),
});

ownerRouter.patch(
  '/beds/:id',
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: bedUpdateBody })),
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);
    const { id } = req.params as { id: string };
    const body = req.body as z.infer<typeof bedUpdateBody>;

    const bed = await prisma.bed.findUnique({
      where: { id },
      select: { roomType: { select: { hostel: { select: { ownerId: true } } } } },
    });
    if (!bed) throw AppError.notFound('BED_NOT_FOUND', 'That bed was not found.');
    if (bed.roomType.hostel.ownerId !== owner.id) {
      throw AppError.forbidden('That bed belongs to another owner.');
    }

    // Flipping a bed to maintenance while someone is in it would strand them.
    if (body.status === BedStatus.MAINTENANCE || body.isActive === false) {
      const active = await prisma.booking.count({
        where: {
          bedId: id,
          status: { in: ['PENDING_PAYMENT', 'PENDING_OWNER', 'CONFIRMED', 'CHECKED_IN'] },
          checkOut: { gt: new Date() },
        },
      });
      if (active > 0) {
        throw AppError.conflict(
          'BED_IN_USE',
          `This bed has ${active} active booking(s). Cancel or complete them before taking it off sale.`,
        );
      }
    }

    const updated = await prisma.bed.update({
      where: { id },
      data: { ...(body.status !== undefined ? { status: body.status } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}), ...(body.label !== undefined ? { label: body.label } : {}) },
    });

    res.json({ bed: updated });
  }),
);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

ownerRouter.get(
  '/dashboard',
  asyncHandler(async (req: Request, res) => {
    const owner = await requireOwner((req as AuthedRequest).auth);

    const hostels = await prisma.hostel.findMany({
      where: { ownerId: owner.id },
      select: { id: true, name: true, published: true, verificationStatus: true },
    });

    const [earnings, pendingCount, confirmedCount, occupancy] = await Promise.all([
      ownerEarnings(prisma, owner.id),
      prisma.booking.count({ where: { ownerId: owner.id, status: 'PENDING_OWNER' } }),
      prisma.booking.count({
        where: {
          ownerId: owner.id,
          status: { in: ['CONFIRMED', 'CHECKED_IN'] },
          checkIn: { lte: new Date() },
          checkOut: { gt: new Date() },
        },
      }),
      prisma.bed.groupBy({
        by: ['status'],
        where: { roomType: { hostel: { ownerId: owner.id } } },
        _count: { _all: true },
      }),
    ]);

    const commissionBps = await resolveCommissionBps(prisma, owner.id);
    const bedCounts = Object.fromEntries(
      occupancy.map((o) => [o.status, o._count._all]),
    ) as Record<BedStatus, number>;

    res.json({
      verificationStatus: owner.verificationStatus,
      hostels,
      pendingApprovals: pendingCount,
      currentlyCheckedIn: confirmedCount,
      earnings,
      commissionRateBps: commissionBps,
      beds: {
        total: Object.values(bedCounts).reduce((a, b) => a + b, 0),
        available: bedCounts.AVAILABLE ?? 0,
        occupied: bedCounts.OCCUPIED ?? 0,
        maintenance: bedCounts.MAINTENANCE ?? 0,
      },
    });
  }),
);