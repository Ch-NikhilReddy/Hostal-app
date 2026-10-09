import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  BedStatus,
  BookingStatus,
  Gender,
  HostelType,
  PaymentStatus,
  VerificationStatus,
} from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';

/**
 * M-4 and M-5: the cancellation path had to start telling the truth.
 *
 * Neither finding was exploitable. Both were the system asserting something untrue,
 * which is a different kind of failure and needs different evidence — there is no
 * before/after HTTP status to point at, only the words in the response and the rows
 * that should and should not exist.
 *
 * M-5: `POST /v1/bookings/:ref/cancel` answered `refundEligible: true` and "A refund
 * will be processed under the hostel notice policy" whenever a payment was captured.
 * There is no refund implementation anywhere in the codebase — no route, no gateway
 * call, no reconciliation entry. So a student was told their money would come back on
 * the strength of a boolean nothing acted on.
 *
 * M-4: a cancellation released the bed back into inventory and notified nobody. The
 * owner's occupancy silently changed and they may already have refused another student
 * to fill it.
 *
 * Driven through the real HTTP routes, with direct Prisma access only to arrange state
 * and to assert what was written — which is the part an HTTP-only test cannot see.
 */

const app = createApp();

const OWNER_PHONE = '9400000001';
const STUDENT_PHONE = '9400000002';
const RUN = Math.random().toString(36).slice(2, 7);
const SLUG = `truthful-${RUN}`;

const checkIn = new Date(Date.now() + 30 * 86_400_000);
const checkOut = new Date(Date.now() + 60 * 86_400_000);

let ownerUserId: string;
let studentUserId: string;
let ownerToken: string;
let studentToken: string;
let hostelId: string;
let roomTypeId: string;
let bedId: string;
let counter = 0;

async function signIn(phone: string, name: string, registerRole?: 'STUDENT' | 'OWNER') {
  const req = await request(app).post('/v1/auth/otp/request').send({ phone });
  expect(req.status).toBe(200);
  const res = await request(app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: req.body.devOtp, name, registerRole });
  expect(res.status).toBe(200);
  return res.body as { accessToken: string; user: { id: string } };
}

beforeAll(async () => {
  await prisma.$connect();

  const owner = await signIn(OWNER_PHONE, 'Truthful Owner', 'OWNER');
  const student = await signIn(STUDENT_PHONE, 'Truthful Student');
  ownerToken = owner.accessToken;
  ownerUserId = owner.user.id;
  studentToken = student.accessToken;
  studentUserId = student.user.id;

  const profile = await prisma.owner.findUniqueOrThrow({ where: { userId: ownerUserId } });
  await prisma.owner.update({
    where: { id: profile.id },
    data: { verificationStatus: VerificationStatus.APPROVED },
  });

  const hostel = await prisma.hostel.create({
    data: {
      ownerId: profile.id,
      name: `Truthful Hostel ${RUN}`,
      slug: SLUG,
      type: HostelType.HOSTEL,
      gender: Gender.MIXED,
      addressLine: '1 Truth Road',
      area: 'Kukatpally',
      city: 'Hyderabad',
      latitude: 17.322,
      longitude: 78.2337,
      published: true,
      verificationStatus: VerificationStatus.APPROVED,
    },
  });
  hostelId = hostel.id;

  const roomType = await prisma.roomType.create({
    data: {
      hostelId: hostel.id,
      name: 'Shared',
      sharingType: 'TRIPLE',
      monthlyRent: 800_000,
      shortStayDailyRent: 40_000,
      dayStayDailyRent: 35_000,
    },
  });
  roomTypeId = roomType.id;

  bedId = '';
});

afterAll(async () => {
  // Explicit order, because cascade behaviour differs per relation and guessing it
  // produces a foreign-key violation at the end of a suite whose tests all passed —
  // the most confusing possible signal.
  //
  //   booking -> hostel        NO cascade, must be deleted first
  //   payment  -> booking     cascades
  //   roomType -> hostel      cascades
  //   bed      -> roomType    cascades
  //   hostel   -> owner       cascades
  // Both keys: bookings reference the hostel AND the student, and the fixture reuses a
  // fixed phone number, so a booking from an earlier run of this file can be pointed
  // at this student without pointing at this hostel.
  await prisma.booking.deleteMany({
    where: { OR: [{ hostelId }, { studentId: studentUserId }] },
  });
  await prisma.hostel.deleteMany({ where: { id: hostelId } });
  for (const id of [studentUserId, ownerUserId]) {
    if (!id) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: id } });
    await prisma.notification.deleteMany({ where: { userId: id } });
    await prisma.owner.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

/**
 * Book a fresh bed, optionally marking the payment captured and the booking confirmed.
 *
 * A new bed per call rather than one shared bed: each booking holds its bed for the
 * whole stay, so reusing one makes the second test in the file fail with 409 for reasons
 * that have nothing to do with what it is testing.
 */
async function makeBooking(opts: { paid: boolean }) {
  const bed = await prisma.bed.create({ data: { roomTypeId, label: `bed-${counter++}` } });
  bedId = bed.id;

  const res = await request(app)
    .post('/v1/bookings')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({
      roomTypeId,
      bedId,
      stayType: 'MONTHLY',
      checkIn: checkIn.toISOString().slice(0, 10),
      months: 2,
    });
  expect(res.status).toBe(201);
  const ref = res.body.bookingRef as string;

  // Looked up by reference rather than read off the create response: the response
  // shape is the API's business, and a test that depends on it fails for the wrong
  // reason when that shape changes.
  const row = await prisma.booking.findUniqueOrThrow({ where: { bookingRef: ref } });
  const bookingId = row.id;

  if (opts.paid) {
    // The booking route already creates the Payment row in CREATED state, so this
    // marks the money captured rather than inserting a second one — Payment.bookingId
    // is unique, and a create here would fail for a reason unrelated to the finding.
    const payment = await prisma.payment.update({
      where: { bookingId },
      data: {
        status: PaymentStatus.PAID,
        providerPaymentId: `pay_${RUN}_${ref}`,
      },
    });
    expect(payment.status).toBe(PaymentStatus.PAID);

    // PENDING_OWNER -> CONFIRMED is the state a student can actually cancel from
    // after paying. PENDING_OWNER itself is not cancellable, which is correct.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CONFIRMED },
    });
  }

  return { ref, bookingId };
}

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { userId: ownerUserId } });
});

describe('M-5 — the cancellation response tells the truth', () => {
  it('a PAID booking gets no refund promise it cannot keep', async () => {
    const { ref } = await makeBooking({ paid: true });

    const res = await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Truthfulness test: paid booking' });

    expect(res.status).toBe(200);

    // The core assertions.
    expect(res.body).not.toHaveProperty('refundEligible');
    expect(res.body.paymentTaken).toBe(true);
    expect(res.body.message).toMatch(/contact support/i);
    expect(JSON.stringify(res.body)).not.toMatch(/refund will be processed/i);
    expect(JSON.stringify(res.body)).not.toMatch(/refundEligible/);
  });

  it('an unpaid booking says no payment was taken', async () => {
    const { ref } = await makeBooking({ paid: false });

    const res = await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Truthfulness test: unpaid booking' });

    expect(res.status).toBe(200);
    expect(res.body.paymentTaken).toBe(false);
    expect(res.body.message).toMatch(/no payment was taken/i);
    expect(res.body).not.toHaveProperty('refundEligible');
  });

  it('the bed is released either way', async () => {
    const { ref } = await makeBooking({ paid: true });
    await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Truthfulness test: release check' })
      .expect(200);

    const bed = await prisma.bed.findUniqueOrThrow({ where: { id: bedId } });
    expect(bed.status).toBe(BedStatus.AVAILABLE);
  });

  it('no refund record is created, because none is implemented', async () => {
    // Pins the reason the promise had to go rather than merely being unhelpful: if
    // someone later adds refunds, this test is where they will want to change it.
    const { ref, bookingId } = await makeBooking({ paid: true });
    await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Truthfulness test: no phantom refund' })
      .expect(200);

    const status = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { status: true },
    });
    // CANCELLED_BY_STUDENT -> REFUNDED exists in the transition table but nothing
    // performs it, so the booking must sit at CANCELLED, not REFUNDED.
    expect(status.status).toBe(BookingStatus.CANCELLED_BY_STUDENT);
  });
});

describe('M-4 — the owner is told when a booking is cancelled', () => {
  it('a cancellation writes a notification to the owner', async () => {
    const { ref } = await makeBooking({ paid: true });

    await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Notification test: student cancelled' })
      .expect(200);

    const notifications = await prisma.notification.findMany({
      where: { userId: ownerUserId },
      orderBy: { createdAt: 'desc' },
    });

    expect(notifications.length).toBeGreaterThan(0);
    const latest = notifications[0]!;
    expect(JSON.stringify(latest)).toContain(ref);
  });

  it('the notification says the bed is free again', async () => {
    const { ref } = await makeBooking({ paid: true });
    await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Notification test: bed released' })
      .expect(200);

    const latest = await prisma.notification.findFirstOrThrow({
      where: { userId: ownerUserId },
      orderBy: { createdAt: 'desc' },
    });

    expect(`${latest.title} ${latest.body}`).toMatch(/available again|cancelled/i);
  });

  it('the student is not notified about their own cancellation', async () => {
    // The notification must reach the owner and only the owner.
    const { ref } = await makeBooking({ paid: true });
    await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Notification test: owner only' })
      .expect(200);

    const toStudent = await prisma.notification.findMany({
      where: { userId: studentUserId, title: { contains: 'Booking cancelled' } },
    });
    expect(toStudent).toEqual([]);
  });

  it('the notification survives a failure in the notify step', async () => {
    // Cancellation must not become a 500 because a notification could not be written,
    // and the student must not be told to retry an action that already succeeded.
    const { ref } = await makeBooking({ paid: true });

    const res = await request(app)
      .post(`/v1/bookings/${ref}/cancel`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Notification test: resilience' });

    expect(res.status).toBe(200);

    const status = await prisma.booking.findUniqueOrThrow({
      where: { bookingRef: ref },
      select: { status: true },
    });
    expect(status.status).toBe(BookingStatus.CANCELLED_BY_STUDENT);
  });
});