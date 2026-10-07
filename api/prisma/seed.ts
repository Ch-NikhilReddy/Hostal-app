/**
 * Seed data: real Hyderabad colleges, plausible hostels around them, room
 * inventory, and a couple of bookings that have already progressed through the
 * lifecycle so the admin dashboard and reports have something to show.
 *
 * Idempotent: safe to run repeatedly. Every write is an upsert on a stable key.
 *
 *   npm run db:seed
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient, BedStatus, BookingStatus, Gender, HostelType, PaymentProvider, PaymentStatus, Role, SharingType, StayType, VerificationStatus } from '@prisma/client';

// Load the repo-root .env before Prisma reads it. config.ts cannot be imported
// here: it validates the JWT secret and would make the seed fail for an unrelated
// reason.
//
// The path is relative to api/prisma/, so the repo root is two levels up. This is
// walked rather than hard-coded so the seed keeps working if the file moves.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
for (const candidate of [path.join(repoRoot, 'api', '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const prisma = new PrismaClient();

/** Base rent bands are kept in whole rupees and converted to paise on write. */
const rupees = (n: number) => n * 100;

// ---------------------------------------------------------------------------
// Colleges
// ---------------------------------------------------------------------------

const colleges = [
  { name: 'Osmania University', slug: 'osmania-university', address: 'Main Campus, Arts College Rd, Tarnaka', latitude: 17.3086, longitude: 78.4405 },
  { name: 'JNTUH College of Engineering Hyderabad', slug: 'jntuh-kukatpally', address: 'Kukatpally, Hyderabad', latitude: 17.322, longitude: 78.2337 },
  { name: 'Chaitanya Bharathi Institute of Technology', slug: 'cbit-gachibowli', address: 'Gachibowli, Hyderabad', latitude: 17.3206, longitude: 78.3796 },
  { name: 'VIT Hyderabad', slug: 'vit-hyderabad', address: 'Knowledge City, Gachibowli', latitude: 17.3725, longitude: 78.2819 },
  { name: 'Woxsen University', slug: 'woxsen-university', address: 'Thumbsirallam, Himayatnagar', latitude: 17.3483, longitude: 78.2223 },
  { name: 'Mahatma Gandhi University', slug: 'mgu-nalgonda', address: 'Nalgonda, Telangana', latitude: 17.0575, longitude: 79.2688 },
  { name: 'Mahindra University', slug: 'mahindra-university', address: 'Siddhigiri Hills, Mulugu', latitude: 17.5408, longitude: 78.457 },
  { name: 'Maulana Azad National Urdu University', slug: 'manu-hyderabad', address: 'Gachibowli, Hyderabad', latitude: 17.4265, longitude: 78.5125 },
  { name: 'Acharya N. G. Ranga Agricultural University', slug: 'angrau-hyderabad', address: 'Rajendranagar, Hyderabad', latitude: 17.325, longitude: 78.688 },
  { name: 'Anurag University', slug: 'anurag-university', address: 'Anekal, Bangalore Highway', latitude: 17.4073, longitude: 78.4899 },
  { name: 'IIT Hyderabad', slug: 'iit-hyderabad', address: 'Edulagunta, Kandi, Sangareddy', latitude: 17.2473, longitude: 78.5309 },
  { name: 'University of Hyderabad', slug: 'university-of-hyderabad', address: 'Gachibowli Main Campus', latitude: 17.4126, longitude: 78.5683 },
  { name: 'Malla Reddy University', slug: 'malla-reddy-university', address: 'Nacharam, Hyderabad', latitude: 17.262, longitude: 78.4585 },
  { name: 'Telangana University', slug: 'telangana-university', address: 'Irrigation Colony, Khairatabad', latitude: 17.2676, longitude: 78.36 },
  { name: 'St. Josephs Degree and PG College', slug: 'st-josephs-hyderabad', address: '5-9-22, Abids', latitude: 17.4096, longitude: 78.5036 },
] as const;

// ---------------------------------------------------------------------------
// Hostels
// ---------------------------------------------------------------------------

type HostelSeed = {
  name: string;
  area: string;
  addressLine: string;
  latitude: number;
  longitude: number;
  collegeSlug: string;
  gender: Gender;
  type: HostelType;
  foodIncluded: boolean;
  amenities: string[];
  description: string;
  depositAmount: number;
  roomTypes: {
    name: string;
    sharingType: SharingType;
    monthlyRent: number;
    shortStayDailyRent: number | null;
    dayStayDailyRent: number | null;
    foodCharges: number | null;
    bedCount: number;
    floorLabel: string;
  }[];
};

const hostels: HostelSeed[] = [
  {
    name: 'Sai Balaji PG for Boys',
    area: 'Tarnaka',
    addressLine: '4-5-6/2, Babu Jagjivan Ram Colony, Tarnaka',
    latitude: 17.3045,
    longitude: 78.4498,
    collegeSlug: 'osmania-university',
    gender: Gender.MALE,
    type: HostelType.PG,
    foodIncluded: false,
    depositAmount: 8000,
    amenities: ['wifi', 'attached_bathroom', 'geyser', 'laundry', 'desk', 'wardrobe', 'power_backup', 'security', 'bike_parking'],
    description:
      'Boys-only PG three lanes from the OU main campus. South-facing rooms, individual cupboards and desks, and a warden on site every night. Food is available on order through the attached mess; we do not force a monthly plan.',
    roomTypes: [
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 7500, shortStayDailyRent: 400, dayStayDailyRent: 350, foodCharges: 3500, bedCount: 12, floorLabel: 'G' },
      { name: 'Non-AC 4-Sharing', sharingType: SharingType.FOUR_OR_MORE, monthlyRent: 5500, shortStayDailyRent: 300, dayStayDailyRent: 250, foodCharges: null, bedCount: 16, floorLabel: 'G' },
    ],
  },
  {
    name: 'Ananya PG for Girls',
    area: 'Tarnaka',
    addressLine: '2-9-51, Hill Colony, Tarnaka',
    latitude: 17.3072,
    longitude: 78.4561,
    collegeSlug: 'osmania-university',
    gender: Gender.FEMALE,
    type: HostelType.PG,
    foodIncluded: true,
    depositAmount: 10000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'meal_included', 'geyser', 'laundry', 'fridge', 'cctv', 'security', 'housekeeping', 'gym'],
    description:
      'Girls-only PG with an in-house kitchen serving two meals a day. CCTV at every entry, a lady warden, and a common study room that stays open until 11pm. Around a ten-minute walk to the OU Arts College gate.',
    roomTypes: [
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 9500, shortStayDailyRent: 500, dayStayDailyRent: 450, foodCharges: 0, bedCount: 9, floorLabel: '1' },
      { name: 'AC 2-Sharing', sharingType: SharingType.DOUBLE, monthlyRent: 12000, shortStayDailyRent: 650, dayStayDailyRent: 550, foodCharges: 0, bedCount: 6, floorLabel: '2' },
    ],
  },
  {
    name: 'JNTUH Boys Hostel Block A',
    area: 'Kukatpally',
    addressLine: 'Plot 22, Road No. 5, Kukatpally',
    latitude: 17.3248,
    longitude: 78.2391,
    collegeSlug: 'jntuh-kukatpally',
    gender: Gender.MALE,
    type: HostelType.HOSTEL,
    foodIncluded: true,
    depositAmount: 12000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'meal_included', 'laundry', 'power_backup', 'lift', 'cctv', 'security', 'common_room', 'housekeeping', 'study_room'],
    description:
      'Purpose-built student hostel five minutes from the JNTUH main gate. Mess included, study hall on each floor, and a lift, which matters more in June than any other month.',
    roomTypes: [
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 11000, shortStayDailyRent: 600, dayStayDailyRent: 500, foodCharges: 0, bedCount: 24, floorLabel: 'A' },
      { name: 'Non-AC 4-Sharing', sharingType: SharingType.FOUR_OR_MORE, monthlyRent: 8000, shortStayDailyRent: 450, dayStayDailyRent: 400, foodCharges: 0, bedCount: 20, floorLabel: 'B' },
    ],
  },
  {
    name: 'Orion Residency for Men',
    area: 'Gachibowli',
    addressLine: '3rd Floor, Ayodhya Residency, Sarath Nagar, Gachibowli',
    latitude: 17.4381,
    longitude: 78.3487,
    collegeSlug: 'cbit-gachibowli',
    gender: Gender.MALE,
    type: HostelType.PG,
    foodIncluded: false,
    depositAmount: 9000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'fridge', 'tv', 'geyser', 'laundry', 'lift', 'power_backup', 'gym', 'bike_parking'],
    description:
      'Independent boys PG aimed at CBIT and IIT-H students doing internships in the financial district. Fully furnished, single occupancy option available, and a fifteen-minute ride to Financial District in the morning.',
    roomTypes: [
      { name: 'AC 2-Sharing', sharingType: SharingType.DOUBLE, monthlyRent: 13500, shortStayDailyRent: 750, dayStayDailyRent: 650, foodCharges: null, bedCount: 10, floorLabel: '3' },
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 10500, shortStayDailyRent: 600, dayStayDailyRent: 500, foodCharges: null, bedCount: 12, floorLabel: '2' },
    ],
  },
  {
    name: 'Vidya Sagar Boys Hostel',
    area: 'Madhapur',
    addressLine: 'Plot 8, Road No. 5, Green Park Colony, Madhapur',
    latitude: 17.4355,
    longitude: 78.4475,
    collegeSlug: 'woxsen-university',
    gender: Gender.MALE,
    type: HostelType.HOSTEL,
    foodIncluded: true,
    depositAmount: 11000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'meal_included', 'meals_available', 'laundry', 'lift', 'power_backup', 'cctv', 'security', 'study_room', 'balcony'],
    description:
      'Close to Hitech City and Madhapur. Mess with both Veg and non-Veg options, a rooftop eating area, and 24-hour power backup on every floor.',
    roomTypes: [
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 12500, shortStayDailyRent: 700, dayStayDailyRent: 600, foodCharges: 0, bedCount: 15, floorLabel: '1' },
      { name: 'AC 4-Sharing', sharingType: SharingType.FOUR_OR_MORE, monthlyRent: 10000, shortStayDailyRent: 600, dayStayDailyRent: 500, foodCharges: 0, bedCount: 18, floorLabel: '2' },
    ],
  },
  {
    name: 'Green Nest PG for Girls',
    area: 'Kondapur',
    addressLine: 'Flat 301, Sai Residency, Botla Road, Kondapur',
    latitude: 17.4612,
    longitude: 78.4436,
    collegeSlug: 'vit-hyderabad',
    gender: Gender.FEMALE,
    type: HostelType.PG,
    foodIncluded: false,
    depositAmount: 10000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'fridge', 'geyser', 'laundry', 'desk', 'wardrobe', 'cctv', 'security', 'housekeeping'],
    description:
      'Girls-only PG with single and double occupancy, popular with VIT Hyderabad students. No fixed food plan; the mess is open to residents and non-residents alike.',
    roomTypes: [
      { name: 'AC 2-Sharing', sharingType: SharingType.DOUBLE, monthlyRent: 14000, shortStayDailyRent: 800, dayStayDailyRent: 700, foodCharges: null, bedCount: 8, floorLabel: '3' },
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 11000, shortStayDailyRent: 650, dayStayDailyRent: 550, foodCharges: null, bedCount: 12, floorLabel: '3' },
    ],
  },
  {
    name: 'Sunrise Boys Stay',
    area: 'Ameerpet',
    addressLine: '12-2-1/3, Panjagutta Road, Ameerpet',
    latitude: 17.3896,
    longitude: 78.4553,
    collegeSlug: 'st-josephs-hyderabad',
    gender: Gender.MALE,
    type: HostelType.PG,
    foodIncluded: true,
    depositAmount: 7000,
    amenities: ['wifi', 'attached_bathroom', 'non_ac', 'meal_included', 'laundry', 'fridge', 'desk', 'power_backup', 'security', 'housekeeping'],
    description:
      'Budget-friendly option near Ameerpet metro station and St Josephs college. Two meals included, best value in this part of the city for a student who does not need AC.',
    roomTypes: [
      { name: 'Non-AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 6500, shortStayDailyRent: 350, dayStayDailyRent: 300, foodCharges: 0, bedCount: 14, floorLabel: '1' },
      { name: 'Non-AC 2-Sharing', sharingType: SharingType.DOUBLE, monthlyRent: 8000, shortStayDailyRent: 450, dayStayDailyRent: 350, foodCharges: 0, bedCount: 8, floorLabel: '2' },
    ],
  },
  {
    name: 'Trinity Girls Hostel',
    area: 'Yousufguda',
    addressLine: '12-9-27/3, Yousufguda Main Road',
    latitude: 17.4164,
    longitude: 78.4556,
    collegeSlug: 'manu-hyderabad',
    gender: Gender.FEMALE,
    type: HostelType.HOSTEL,
    foodIncluded: true,
    depositAmount: 9000,
    amenities: ['wifi', 'attached_bathroom', 'ac', 'meal_included', 'geyser', 'laundry', 'fridge', 'cctv', 'security', 'common_room', 'study_room', 'hot_water'],
    description:
      'Walkable to MANU Gachibowli and a short metro ride to Secunderabad. Vegetarian mess, a reading room, and strict visitor entry with photo ID.',
    roomTypes: [
      { name: 'AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 9000, shortStayDailyRent: 500, dayStayDailyRent: 450, foodCharges: 0, bedCount: 12, floorLabel: '2' },
    ],
  },
  {
    name: 'Meyya Mens PG',
    area: 'Kompally',
    addressLine: '4-1-118/2, Petmeda, Kompally',
    latitude: 17.3221,
    longitude: 78.1345,
    collegeSlug: 'iit-hyderabad',
    gender: Gender.MALE,
    type: HostelType.PG,
    foodIncluded: false,
    depositAmount: 7500,
    amenities: ['wifi', 'attached_bathroom', 'geyser', 'laundry', 'desk', 'wardrobe', 'bike_parking', 'security', 'power_backup'],
    description:
      'Quiet residential lane in Petmeda, well away from the Kompally main road noise. Popular with IIT-H and MGU students who want a peaceful place to study at night.',
    roomTypes: [
      { name: 'Non-AC 3-Sharing', sharingType: SharingType.TRIPLE, monthlyRent: 6000, shortStayDailyRent: 330, dayStayDailyRent: 280, foodCharges: null, bedCount: 12, floorLabel: '1' },
      { name: 'AC 2-Sharing', sharingType: SharingType.DOUBLE, monthlyRent: 9500, shortStayDailyRent: 550, dayStayDailyRent: 480, foodCharges: null, bedCount: 6, floorLabel: '2' },
    ],
  },
  {
    name: 'Nizam Residency',
    area: 'Old City',
    addressLine: '18-8-40, Charminar Road, Old City',
    latitude: 17.3616,
    longitude: 78.4747,
    collegeSlug: 'telangana-university',
    gender: Gender.MIXED,
    type: HostelType.PG,
    foodIncluded: true,
    depositAmount: 6000,
    amenities: ['wifi', 'attached_bathroom', 'meal_included', 'fridge', 'desk', 'common_room', 'security'],
    description:
      'An old-city building with thick walls and high ceilings that stay cool without AC. Five minutes from Charminar metro and close to several OU-affiliated colleges. Non-AC rooms only by design.',
    roomTypes: [
      { name: 'Non-AC 4-Sharing', sharingType: SharingType.FOUR_OR_MORE, monthlyRent: 5000, shortStayDailyRent: 280, dayStayDailyRent: 240, foodCharges: 0, bedCount: 16, floorLabel: '2' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const ADMIN_PHONE = '9000000001';
const OWNER_PHONE = '9000000002';
const STUDENT_PHONE = '9876543210';

async function upsertUsers() {
  const admin = await prisma.user.upsert({
    where: { phone: ADMIN_PHONE },
    update: {},
    create: {
      phone: ADMIN_PHONE,
      name: 'Platform Admin',
      role: Role.ADMIN,
      verified: true,
      verifiedAt: new Date(),
    },
  });

  const ownerUser = await prisma.user.upsert({
    where: { phone: OWNER_PHONE },
    update: {},
    create: {
      phone: OWNER_PHONE,
      name: 'Ravi Kumar',
      role: Role.OWNER,
      verified: true,
      verifiedAt: new Date(),
    },
  });

  const owner = await prisma.owner.upsert({
    where: { userId: ownerUser.id },
    update: {},
    create: {
      userId: ownerUser.id,
      legalName: 'Ravi Kumar',
      businessName: 'Ravi Kumar Hostels',
      contactPhone: OWNER_PHONE,
      panLast4: '4821',
      gstin: '36AABCR4821K1Z5',
      bankAccountName: 'Ravi Kumar',
      bankIfsc: 'HDFC0001234',
      upiId: 'ravihostels@upi',
      verificationStatus: VerificationStatus.APPROVED,
      verifiedAt: new Date(),
    },
  });

  // Second owner, left PENDING on purpose so the admin verification queue has a
  // real row in it the moment the dashboard opens.
  const owner2User = await prisma.user.upsert({
    where: { phone: '9000000003' },
    update: {},
    create: {
      phone: '9000000003',
      name: 'Sameer Sheikh',
      role: Role.OWNER,
      verified: true,
      verifiedAt: new Date(),
    },
  });

  const owner2 = await prisma.owner.upsert({
    where: { userId: owner2User.id },
    update: {},
    create: {
      userId: owner2User.id,
      legalName: 'Sameer Sheikh',
      businessName: 'Sheikh Hostels',
      contactPhone: '9000000003',
      verificationStatus: VerificationStatus.PENDING,
    },
  });

  const student = await prisma.user.upsert({
    where: { phone: STUDENT_PHONE },
    update: {},
    create: {
      phone: STUDENT_PHONE,
      name: 'Ayesha Khan',
      role: Role.STUDENT,
      verified: true,
      verifiedAt: new Date(),
    },
  });

  // ownerUser is the User row for the owner; notifications reference users, not
  // Owner records, so callers need both ids.
  return { admin, owner, owner2, ownerUser, student };
}

async function main() {
  console.log('Seeding HostelMitra...');

  // ---- Colleges -----------------------------------------------------------
  const collegeBySlug = new Map<string, string>();
  for (const c of colleges) {
    const row = await prisma.college.upsert({
      where: { slug: c.slug },
      update: { name: c.name, address: c.address, latitude: c.latitude, longitude: c.longitude },
      create: {
        name: c.name,
        slug: c.slug,
        city: 'Hyderabad',
        district: c.slug.includes('nalgonda') ? 'Nalgonda' : 'Hyderabad',
        address: c.address,
        latitude: c.latitude,
        longitude: c.longitude,
      },
    });
    collegeBySlug.set(c.slug, row.id);
  }
  console.log(`  colleges      ${colleges.length}`);

  // ---- Users --------------------------------------------------------------
  const { admin, owner, owner2, ownerUser, student } = await upsertUsers();

  // Give the demo student a campus, so "search near my college" has a
  // meaningful default on first launch.
  await prisma.user.update({
    where: { id: student.id },
    data: { collegeId: collegeBySlug.get('osmania-university') ?? null },
  });

  console.log('  users         4 (admin, 2 owners, 1 student)');

  // ---- Commission ---------------------------------------------------------
  const existingConfig = await prisma.commissionConfig.findFirst({ where: { effectiveTo: null } });
  if (!existingConfig) {
    await prisma.commissionConfig.create({
      data: { percentageBps: 1000, label: 'Default 2026 — 10%', createdById: admin.id },
    });
  }

  // ---- Hostels ------------------------------------------------------------
  let hostelCount = 0;
  let bedCount = 0;

  for (const [index, h] of hostels.entries()) {
    // Split ownership so the owner dashboard has more than one property, and the
    // second owner keeps their listings unreviewed.
    const propertyOwner = index % 4 === 3 ? owner2 : owner;
    const slug = h.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const hostel = await prisma.hostel.upsert({
      where: { slug },
      update: {
        name: h.name,
        amenities: h.amenities,
        depositAmount: rupees(h.depositAmount),
      },
      create: {
        ownerId: propertyOwner.id,
        name: h.name,
        slug,
        description: h.description,
        type: h.type,
        gender: h.gender,
        addressLine: h.addressLine,
        area: h.area,
        city: 'Hyderabad',
        pincode: '5000' + String(10 + (index % 89)).padStart(2, '0'),
        latitude: h.latitude,
        longitude: h.longitude,
        contactPhone: propertyOwner.contactPhone,
        amenities: h.amenities,
        // Placeholder stock photos. Real listings need owner-uploaded photos;
        // these keep the grid from rendering empty during development.
        photos: [
          `https://images.unsplash.com/photo-1555854877-bab0e564b8d5?w=800&q=70`,
          `https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=70`,
          `https://images.unsplash.com/photo-1562774053-701939374585?w=800&q=70`,
        ],
        foodIncluded: h.foodIncluded,
        depositAmount: rupees(h.depositAmount),
        noticePeriodDays: 7,
        collegeId: collegeBySlug.get(h.collegeSlug) ?? null,
        verificationStatus: propertyOwner.verificationStatus,
        published: propertyOwner.verificationStatus === VerificationStatus.APPROVED,
        publishedAt: propertyOwner.verificationStatus === VerificationStatus.APPROVED ? new Date() : null,
        ratingAverage: new Prisma.Decimal((3.8 + (index % 3) * 0.3).toFixed(1)),
        ratingCount: 12 + index * 7,
        reviewCount: 8 + index * 3,
      },
    });

    if (propertyOwner.verificationStatus === VerificationStatus.APPROVED) hostelCount += 1;

    for (const rt of h.roomTypes) {
      const roomType = await prisma.roomType.upsert({
        where: { id: `${hostel.id}-${rt.name}` },
        update: {},
        create: {
          // Deterministic surrogate id makes the seed idempotent without a
          // separate natural key.
          id: `${hostel.id}-${rt.name}`,
          hostelId: hostel.id,
          name: rt.name,
          sharingType: rt.sharingType,
          gender: h.gender === Gender.MIXED ? Gender.MIXED : h.gender,
          monthlyRent: rupees(rt.monthlyRent),
          shortStayDailyRent: rt.shortStayDailyRent ? rupees(rt.shortStayDailyRent) : null,
          dayStayDailyRent: rt.dayStayDailyRent ? rupees(rt.dayStayDailyRent) : null,
          depositAmount: rupees(h.depositAmount),
          foodCharges: rt.foodCharges ? rupees(rt.foodCharges) : null,
          amenities: h.amenities.slice(0, 8),
          photos: [],
        },
      });

      // Beds are created only when absent, so re-seeding never renumbers or
      // duplicates inventory that bookings already reference.
      const existingBeds = await prisma.bed.count({ where: { roomTypeId: roomType.id } });
      if (existingBeds === 0) {
        await prisma.bed.createMany({
          data: Array.from({ length: rt.bedCount }, (_, i) => ({
            roomTypeId: roomType.id,
            label: `${rt.floorLabel}-${String(i + 1).padStart(2, '0')}`,
            floorLabel: rt.floorLabel,
          })),
        });
        bedCount += rt.bedCount;
      }
    }
  }
  console.log(`  hostels       ${hostels.length} (${hostelCount} live)`);
  console.log(`  beds          +${bedCount}`);

  // ---- Bookings -----------------------------------------------------------
  // A few bookings in different states so the owner's queue, the student's
  // "My Bookings" screen and the admin reports are all populated.
  const demoHostel = await prisma.hostel.findFirst({
    where: { slug: 'sai-balaji-pg-for-boys' },
    include: { roomTypes: { include: { beds: { take: 2 } } } },
  });

  if (demoHostel && demoHostel.roomTypes[0]?.beds[0]) {
    const bed = demoHostel.roomTypes[0].beds[0];
    const checkIn = new Date();
    checkIn.setUTCDate(checkIn.getUTCDate() + 10);
    const checkOut = new Date(checkIn);
    checkOut.setUTCMonth(checkOut.getUTCMonth() + 3);

    const baseRent = rupees(7500) * 3;
    const foodCharges = rupees(3500) * 3;
    const deposit = rupees(8000);
    const commissionAmount = Math.floor(((baseRent + foodCharges) * 1000 + 5000) / 10000);
    const total = baseRent + foodCharges + deposit;

    const ref = 'HM-DEMO001';

    const existing = await prisma.booking.findUnique({ where: { bookingRef: ref } });
    if (!existing) {
      const booking = await prisma.booking.create({
        data: {
          bookingRef: ref,
          studentId: student.id,
          hostelId: demoHostel.id,
          roomTypeId: bed.roomTypeId,
          bedId: bed.id,
          ownerId: demoHostel.ownerId,
          stayType: StayType.MONTHLY,
          checkIn,
          checkOut,
          months: 3,
          days: 92,
          baseRent,
          foodCharges,
          depositAmount: deposit,
          serviceFee: 0,
          taxes: 0,
          commissionAmount,
          commissionRateBps: 1000,
          ownerPayout: baseRent + foodCharges - commissionAmount,
          totalAmount: total,
          status: BookingStatus.CONFIRMED,
          confirmedAt: new Date(),
          statusHistory: {
            create: [
              { toStatus: BookingStatus.PENDING_PAYMENT, actorRole: 'STUDENT', reason: 'Bed held for 3 month(s).' },
              { toStatus: BookingStatus.PENDING_OWNER, actorRole: 'SYSTEM', reason: 'Payment captured.' },
              { toStatus: BookingStatus.CONFIRMED, actorRole: 'OWNER', reason: 'Owner confirmed.' },
            ],
          },
        },
      });

      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: PaymentProvider.MOCK,
          providerOrderId: `order_seed_${ref}`,
          providerPaymentId: `pay_seed_${ref}`,
          amount: total,
          status: PaymentStatus.PAID,
          method: 'upi',
          commissionAmount,
          capturedAt: new Date(),
        },
      });

      await prisma.bed.update({ where: { id: bed.id }, data: { status: BedStatus.OCCUPIED } });
    }
  }

  await prisma.notification.deleteMany({
    where: { userId: { in: [student.id, owner.id] } },
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: student.id,
        title: 'Booking confirmed',
        body: 'Sai Balaji PG for Boys confirmed your booking HM-DEMO001.',
        data: { type: 'BOOKING_CONFIRMED', bookingRef: 'HM-DEMO001' },
      },
      {
        userId: ownerUser.id,
        title: 'Verification approved',
        body: 'Ravi Kumar Hostels is verified. You can now publish your properties.',
        data: { type: 'VERIFICATION_UPDATE', status: 'APPROVED' },
      },
    ],
  });

  console.log('  bookings      1 demo booking (CONFIRMED)');
  console.log('');
  console.log('Seed complete. Sign in with any 10-digit number; the OTP is printed');
  console.log('to the API console in development.');
  console.log('');
  console.log(`  Admin   ${ADMIN_PHONE}`);
  console.log(`  Owner   ${OWNER_PHONE}  (Ravi Kumar Hostels, APPROVED)`);
  console.log(`  Owner   9000000003  (Sheikh Hostels, PENDING — approve in admin)`);
  console.log(`  Student ${STUDENT_PHONE}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });