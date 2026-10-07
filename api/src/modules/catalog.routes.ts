import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  Gender,
  HostelType,
  SharingType,
  StayType,
  VerificationStatus,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../db.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { startOfUtcDay } from '../lib/dates.js';
import { boundingBox, estimateTravelMinutes, haversineKm } from '../lib/geo.js';
import { sanitiseAmenities } from '../lib/vocabulary.js';
import { availabilityByRoomType, availableBeds, releaseExpiredHolds } from '../services/availability.js';

export const catalogRouter = Router();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be in YYYY-MM-DD format.')
  .transform((v) => startOfUtcDay(new Date(`${v}T00:00:00Z`)))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date.');

// ---------------------------------------------------------------------------
// Colleges — the anchor for "hostels near my college"
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/colleges',
  validate(
    z.object({
      query: z.object({
        city: z.string().trim().max(40).default('Hyderabad'),
        search: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const q = req.query as unknown as { city: string; search?: string; limit: number };

    const colleges = await prisma.college.findMany({
      where: {
        city: q.city,
        isActive: true,
        ...(q.search
          ? { name: { contains: q.search, mode: 'insensitive' as const } }
          : {}),
      },
      select: { id: true, name: true, slug: true, city: true, address: true, latitude: true, longitude: true },
      orderBy: { name: 'asc' },
      take: q.limit,
    });

    res.json({ colleges });
  }),
);

catalogRouter.get(
  '/colleges/:id',
  validate(z.object({ params: z.object({ id: z.string().min(1) }) })),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };

    // Accept a cuid or a slug: the app deep-links from a share text, and a slug
    // is what a human reads.
    const college = await prisma.college.findFirst({
      where: { OR: [{ id }, { slug: id }] },
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        address: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!college) throw AppError.notFound('COLLEGE_NOT_FOUND', 'That college was not found.');

    const hostelCount = await prisma.hostel.count({
      where: {
        collegeId: college.id,
        published: true,
        verificationStatus: VerificationStatus.APPROVED,
      },
    });

    res.json({ college: { ...college, hostelCount } });
  }),
);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchQuery = z
  .object({
    search: z.string().trim().max(80).optional(),
    collegeId: z.string().optional(),

    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
    radiusKm: z.coerce.number().min(0.5).max(50).default(5),

    area: z.string().trim().max(60).optional(),
    gender: z.nativeEnum(Gender).optional(),
    hostelType: z.nativeEnum(HostelType).optional(),
    sharingType: z.nativeEnum(SharingType).optional(),
    stayType: z.nativeEnum(StayType).optional(),

    amenities: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => sanitiseAmenities(typeof v === 'string' ? v.split(',') : v)),

    foodIncluded: z.enum(['true', 'false']).optional(),
    minRent: z.coerce.number().min(0).optional(),
    maxRent: z.coerce.number().min(0).optional(),

    checkIn: isoDate.optional(),
    checkOut: isoDate.optional(),

    sort: z.enum(['distance', 'price_asc', 'price_desc', 'rating', 'newest']).default('distance'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .superRefine((v, ctx) => {
    if ((v.lat === undefined) !== (v.lng === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide both lat and lng, or neither.',
        path: ['lat'],
      });
    }
    if (v.checkIn && v.checkOut && v.checkOut.getTime() <= v.checkIn.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'checkOut must be after checkIn.',
        path: ['checkOut'],
      });
    }
    if (v.minRent !== undefined && v.maxRent !== undefined && v.maxRent < v.minRent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'maxRent cannot be less than minRent.',
        path: ['maxRent'],
      });
    }
  });

type SearchQuery = z.infer<typeof searchQuery>;

catalogRouter.get(
  '/hostels',
  validate(z.object({ query: searchQuery })),
  asyncHandler(async (req: Request, res) => {
    const q = req.query as unknown as SearchQuery;

    // Opportunistic, and cheap: it stops abandoned payment holds from shrinking
    // the inventory shown to everyone else.
    await releaseExpiredHolds(prisma).catch((err) => {
      console.warn('[catalog] releaseExpiredHolds failed:', (err as Error).message);
    });

    // Resolve the search origin. A college id wins over raw coordinates, because
    // "hostels near OU campus" is the intent behind most searches.
    let originLat = q.lat;
    let originLng = q.lng;
    let originName: string | undefined;

    // Resolve the college to a real id before using it as a filter.
    //
    // The parameter accepts a slug as well as an id, because the app deep-links
    // with slugs and they are what a human reads. Filtering on the raw string
    // against the `collegeId` column would silently match nothing when a slug was
    // passed — a search that returns zero results with no error is far worse than a
    // 404, because it looks like "no hostels near that college" rather than a bug.
    let resolvedCollegeId: string | undefined;

    if (q.collegeId) {
      const college = await prisma.college.findFirst({
        where: { OR: [{ id: q.collegeId }, { slug: q.collegeId }] },
        select: { id: true, name: true, latitude: true, longitude: true },
      });
      if (!college) throw AppError.notFound('COLLEGE_NOT_FOUND', 'That college was not found.');
      resolvedCollegeId = college.id;
      originName = college.name;

      // The college supplies the search origin only when the caller did not.
      // Explicit coordinates win: "use my current location" is a direct action and
      // silently replacing it with the campus would show a student hostels near a
      // building they may not even be near. The college id still filters results —
      // only its coordinates are advisory.
      if (originLat === undefined || originLng === undefined) {
        originLat = college.latitude;
        originLng = college.longitude;
      }
    }

    const hasWindow = Boolean(q.checkIn && q.checkOut);
    const window = hasWindow ? { checkIn: q.checkIn!, checkOut: q.checkOut! } : null;

    // ---- Room-type filter, shared by price and stay-type constraints -------
    const roomTypeWhere: Prisma.RoomTypeWhereInput = {
      isActive: true,
      ...(q.sharingType ? { sharingType: q.sharingType } : {}),
      ...(q.gender ? { OR: [{ gender: q.gender }, { gender: Gender.MIXED }] } : {}),
      ...(q.minRent !== undefined ? { monthlyRent: { gte: Math.round(q.minRent * 100) } } : {}),
      ...(q.maxRent !== undefined ? { monthlyRent: { lte: Math.round(q.maxRent * 100) } } : {}),
    };

    // A stay-type filter means "only show places that actually sell that stay".
    if (q.stayType === StayType.SHORT_STAY) {
      roomTypeWhere.shortStayDailyRent = { not: null };
    } else if (q.stayType === StayType.DAY_STAY) {
      roomTypeWhere.dayStayDailyRent = { not: null };
    }

    const where: Prisma.HostelWhereInput = {
      published: true,
      verificationStatus: VerificationStatus.APPROVED,
      ...(q.hostelType ? { type: q.hostelType } : {}),
      ...(q.gender ? { OR: [{ gender: q.gender }, { gender: Gender.MIXED }] } : {}),
      ...(resolvedCollegeId ? { collegeId: resolvedCollegeId } : {}),
      ...(q.area ? { area: { equals: q.area, mode: 'insensitive' } } : {}),
      ...(q.foodIncluded ? { foodIncluded: q.foodIncluded === 'true' } : {}),
      ...(q.amenities.length > 0
        ? { OR: q.amenities.map((a) => ({ amenities: { has: a } })) }
        : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { area: { contains: q.search, mode: 'insensitive' } },
              { addressLine: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      roomTypes: { some: roomTypeWhere },
    };

    // Bounding-box prefilter so the DB can use an index instead of scanning every
    // hostel. The box is a superset of the true radius, so nothing is lost; the
    // exact haversine below is what actually decides membership.
    if (originLat !== undefined && originLng !== undefined) {
      const box = boundingBox(originLat, originLng, q.radiusKm);
      where.latitude = { gte: box.minLat, lte: box.maxLat };
      where.longitude = { gte: box.minLng, lte: box.maxLng };
    }

    // Fetch a bounded superset, then filter by exact distance in JS. Page size is
    // capped at 50, so the oversample factor only ever pulls a few hundred rows.
    const candidates = await prisma.hostel.findMany({
      where,
      include: {
        college: { select: { id: true, name: true, slug: true, latitude: true, longitude: true } },
        roomTypes: {
          where: roomTypeWhere,
          select: {
            id: true,
            name: true,
            sharingType: true,
            gender: true,
            monthlyRent: true,
            shortStayDailyRent: true,
            dayStayDailyRent: true,
            depositAmount: true,
            foodCharges: true,
            amenities: true,
            isActive: true,
          },
          orderBy: { monthlyRent: 'asc' },
        },
      },
      orderBy: q.sort === 'newest' ? { createdAt: 'desc' } : undefined,
      take: 500,
    });

    const withDistance = candidates.map((hostel) => {
      const distanceKm =
        originLat !== undefined && originLng !== undefined
          ? haversineKm(originLat, originLng, hostel.latitude, hostel.longitude)
          : null;

      const rents = hostel.roomTypes.map((rt) => rt.monthlyRent);
      return {
        ...hostel,
        distanceKm,
        travelMinutes: distanceKm === null ? null : estimateTravelMinutes(distanceKm),
        minMonthlyRent: rents.length ? Math.min(...rents) : null,
        maxMonthlyRent: rents.length ? Math.max(...rents) : null,
      };
    });

    // Exact radius filter after the box prefilter.
    const inRadius =
      q.radiusKm !== undefined && originLat !== undefined && originLng !== undefined
        ? withDistance.filter(
            (h) => h.distanceKm !== null && h.distanceKm <= q.radiusKm,
          )
        : withDistance;

    // ---- Availability counts ------------------------------------------------
    const roomTypeIds = [...new Set(inRadius.flatMap((h) => h.roomTypes.map((rt) => rt.id)))];

    let availability = new Map<string, { total: number; available: number }>();
    if (window && roomTypeIds.length > 0) {
      availability = await availabilityByRoomType(
        prisma,
        roomTypeIds,
        window.checkIn,
        window.checkOut,
      );
    }

    const enriched = inRadius.map((hostel) => {
      const roomTypes = hostel.roomTypes.map((rt) => {
        const a = window ? availability.get(rt.id) : undefined;
        return {
          ...rt,
          totalBeds: a?.total ?? null,
          availableBeds: a?.available ?? null,
        };
      });
      return { ...hostel, roomTypes };
    });

    // When the student named dates, a hostel with nothing free for those dates is
    // not a result. Showing it would be technically honest and completely
    // useless.
    const withAvailability = window
      ? enriched.filter((h) => h.roomTypes.some((rt) => (rt.availableBeds ?? 0) > 0))
      : enriched;

    const sorted = sortResults(withAvailability, q.sort);
    const total = sorted.length;
    const start = (q.page - 1) * q.pageSize;
    const page = sorted.slice(start, start + q.pageSize);

    res.json({
      // Echoed back so the client can label the search ("Hostels near Osmania
      // University") instead of guessing from its own request, which may have
      // passed a slug.
      origin: originName ? { name: originName } : undefined,
      total,
      page: q.page,
      pageSize: q.pageSize,
      hasMore: start + q.pageSize < total,
      results: page.map((h) => ({
        id: h.id,
        name: h.name,
        slug: h.slug,
        type: h.type,
        gender: h.gender,
        area: h.area,
        city: h.city,
        addressLine: h.addressLine,
        latitude: h.latitude,
        longitude: h.longitude,
        photos: h.photos,
        amenities: h.amenities,
        foodIncluded: h.foodIncluded,
        depositAmount: h.depositAmount,
        ratingAverage: h.ratingAverage,
        ratingCount: h.ratingCount,
        reviewCount: h.reviewCount,
        college: h.college,
        distanceKm: h.distanceKm === null ? null : Math.round(h.distanceKm * 100) / 100,
        travelMinutes: h.travelMinutes,
        minMonthlyRent: h.minMonthlyRent,
        maxMonthlyRent: h.maxMonthlyRent,
        roomTypes: h.roomTypes.map((rt) => ({
          id: rt.id,
          name: rt.name,
          sharingType: rt.sharingType,
          gender: rt.gender,
          monthlyRent: rt.monthlyRent,
          shortStayDailyRent: rt.shortStayDailyRent,
          dayStayDailyRent: rt.dayStayDailyRent,
          depositAmount: rt.depositAmount,
          foodCharges: rt.foodCharges,
          availableBeds: rt.availableBeds,
          totalBeds: rt.totalBeds,
        })),
      })),
    });
  }),
);

/**
 * Shape of a search row after distance and availability have been folded in.
 * Declared explicitly rather than inferred: the inference for this pipeline
 * (Prisma include + spread + map + map) produces an unreadable intersection, and
 * sortResults is the one place that depends on all of it.
 */
type SearchRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  area: string;
  city: string;
  addressLine: string;
  latitude: number;
  longitude: number;
  photos: string[];
  amenities: string[];
  foodIncluded: boolean;
  depositAmount: number;
  ratingAverage: Prisma.Decimal | null;
  ratingCount: number;
  reviewCount: number;
  type: HostelType;
  gender: Gender;
  college: { id: string; name: string; slug: string; latitude: number; longitude: number } | null;
  distanceKm: number | null;
  travelMinutes: number | null;
  minMonthlyRent: number | null;
  maxMonthlyRent: number | null;
  roomTypes: {
    id: string;
    name: string;
    sharingType: SharingType;
    gender: Gender;
    monthlyRent: number;
    shortStayDailyRent: number | null;
    dayStayDailyRent: number | null;
    depositAmount: number | null;
    foodCharges: number | null;
    availableBeds: number | null;
    totalBeds: number | null;
  }[];
};

function sortResults(rows: SearchRow[], sort: SearchQuery['sort']): SearchRow[] {
  const copy = [...rows];
  switch (sort) {
    case 'price_asc':
      return copy.sort((a, b) => (a.minMonthlyRent ?? Infinity) - (b.minMonthlyRent ?? Infinity));
    case 'price_desc':
      return copy.sort((a, b) => (b.minMonthlyRent ?? -1) - (a.minMonthlyRent ?? -1));
    case 'rating':
      return copy.sort(
        (a, b) =>
          Number(b.ratingAverage ?? 0) - Number(a.ratingAverage ?? 0) || b.ratingCount - a.ratingCount,
      );
    case 'newest':
      return copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    case 'distance':
    default:
      // Hostels with no distance (no origin given) sort last rather than first,
      // so a student who did share their location sees the nearest at the top.
      return copy.sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) return 0;
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      });
  }
}

// ---------------------------------------------------------------------------
// Hostel detail
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/hostels/:slugOrId',
  validate(z.object({ params: z.object({ slugOrId: z.string().min(1) }) })),
  asyncHandler(async (req, res) => {
    const { slugOrId } = req.params as { slugOrId: string };

    const hostel = await prisma.hostel.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
      include: {
        college: { select: { id: true, name: true, slug: true, latitude: true, longitude: true } },
        roomTypes: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            sharingType: true,
            gender: true,
            monthlyRent: true,
            shortStayDailyRent: true,
            dayStayDailyRent: true,
            depositAmount: true,
            foodCharges: true,
            amenities: true,
            photos: true,
            isActive: true,
          },
          orderBy: { monthlyRent: 'asc' },
        },
      },
    });

    if (!hostel) throw AppError.notFound('HOSTEL_NOT_FOUND', 'That hostel was not found.');

    // Unpublished or unverified hostels stay hidden from students, but their
    // owner must be able to preview the page to see what a student would see.
    const isVisible =
      hostel.published && hostel.verificationStatus === VerificationStatus.APPROVED;

    res.json({
      hostel: { ...hostel, isVisible },
      verificationStatus: hostel.verificationStatus,
      published: hostel.published,
    });
  }),
);

/** Free beds for a room type in a window, with labels so a student can pick one. */
catalogRouter.get(
  '/hostels/:slugOrId/availability',
  validate(
    z.object({
      params: z.object({ slugOrId: z.string().min(1) }),
      query: z.object({ roomTypeId: z.string().min(1), checkIn: isoDate, checkOut: isoDate }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const { slugOrId } = req.params as { slugOrId: string };
    const q = req.query as unknown as { roomTypeId: string; checkIn: Date; checkOut: Date };

    if (q.checkOut.getTime() <= q.checkIn.getTime()) {
      throw AppError.badRequest('INVALID_WINDOW', 'checkOut must be after checkIn.');
    }

    const hostel = await prisma.hostel.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
      select: { id: true, roomTypes: { where: { id: q.roomTypeId }, select: { id: true } } },
    });

    if (!hostel || hostel.roomTypes.length === 0) {
      throw AppError.notFound('ROOM_TYPE_NOT_FOUND', 'That room type is not available here.');
    }

    const beds = await availableBeds(prisma, q.roomTypeId, q.checkIn, q.checkOut);

    res.json({ roomTypeId: q.roomTypeId, checkIn: q.checkIn, checkOut: q.checkOut, beds });
  }),
);

/** Every bookable bed with its current state, for the owner dashboard. */
catalogRouter.get(
  '/room-types/:roomTypeId/beds',
  validate(z.object({ params: z.object({ roomTypeId: z.string().min(1) }) })),
  asyncHandler(async (req, res) => {
    const { roomTypeId } = req.params as { roomTypeId: string };

    const beds = await prisma.bed.findMany({
      where: { roomTypeId },
      select: {
        id: true,
        label: true,
        floorLabel: true,
        status: true,
        isActive: true,
        bookings: {
          where: {
            status: { in: ['PENDING_PAYMENT', 'PENDING_OWNER', 'CONFIRMED', 'CHECKED_IN'] },
            checkOut: { gt: new Date() },
          },
          select: { id: true, bookingRef: true, checkIn: true, checkOut: true, status: true },
          orderBy: { checkIn: 'desc' },
        },
      },
      orderBy: { label: 'asc' },
    });

    res.json({ beds });
  }),
);