import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Role, VerificationStatus } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';

/**
 * H-1 regression: a suspended or rejected owner must not be able to act.
 *
 * The defect: owner routes were gated on requireRole(Role.OWNER), which checks the
 * user's role but never the OWNER record's verificationStatus. Suspending an owner
 * unpublished their existing properties and did nothing else — the owner could
 * still POST /v1/owner/hostels and received 201.
 *
 * These tests drive the real HTTP routes. A unit test on the guard function would
 * not prove the guard is actually reached by every handler.
 */

const app = createApp();
const RUN = Math.random().toString(36).slice(2, 7);

let adminToken: string;
/** The promoted admin's User row, or undefined if the fixture never ran. */
let adminId: { id: string } | undefined;
let ownerToken: string;
let ownerId: string;
let userId: string;

/**
 * Phone numbers unique per run, so a fixture can never collide with a rerun.
 *
 * Ten digits beginning with 9, matching the signup validator. The low digit is the
 * fixture index, which is what keeps the admin and the owner distinct: an earlier
 * version built the number by truncation, where phoneFor(0) and phoneFor(1) both
 * produced 9700000000 and the two "different" accounts silently became one user.
 */
const phoneFor = (n: number) =>
  `9${String(hash(RUN) % 100_000_000).padStart(8, '0')}${n % 10}`;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function signIn(phone: string, name: string, registerRole?: 'OWNER') {
  const req = await request(app).post('/v1/auth/otp/request').send({ phone });
  expect(req.status).toBe(200);
  const res = await request(app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: req.body.devOtp, name, registerRole });
  expect(res.status).toBe(200);
  return res.body as { accessToken: string; user: { id: string; ownerProfile?: { id: string } | null } };
}

async function setStatus(status: VerificationStatus) {
  await prisma.owner.update({ where: { id: ownerId }, data: { verificationStatus: status } });
}

beforeEach(async () => {
  // One owner, one admin, reused across the cases. Each test sets the status it
  // needs, so ordering cannot mask a failure.

  // The admin is PROMOTED here rather than borrowed from the seed. Self-
  // registration only accepts STUDENT or OWNER, so there is no way to obtain an
  // admin token over HTTP, and depending on seeded phone 9000000001 existing would
  // make this suite fail on a freshly migrated database. Writing the role directly
  // is the same thing an operator does.
  //
  // The promotion is followed by a SECOND sign-in because requireRole reads the
  // role out of the JWT, not the database. A role change does not reach an
  // already-issued token — which is the reason H-1 reads owner status from the
  // database rather than trusting the token, and worth pinning down here too.
  const adminPhone = phoneFor(0);
  await signIn(adminPhone, 'H1 Admin');
  adminId = await prisma.user.findUniqueOrThrow({ where: { phone: adminPhone } });
  await prisma.user.update({ where: { id: adminId.id }, data: { role: Role.ADMIN } });
  adminToken = (await signIn(adminPhone, 'H1 Admin')).accessToken;

  const owner = await signIn(phoneFor(1), 'H1 Owner', 'OWNER');
  ownerToken = owner.accessToken;
  userId = owner.user.id;

  const profile = await prisma.owner.findUniqueOrThrow({ where: { userId } });
  ownerId = profile.id;

  await setStatus(VerificationStatus.APPROVED);
});

afterAll(async () => {
  for (const id of [userId, adminId?.id]) {
    if (!id) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: id } });
    await prisma.notification.deleteMany({ where: { userId: id } });
    // Hostels cascade from the owner (schema.prisma onDelete: Cascade), so the
    // properties these tests create are removed along with it.
    await prisma.owner.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe('H-1 — suspended and rejected owners are refused', () => {
  it('a SUSPENDED owner cannot create a property (the H-1 exploit)', async () => {
    await setStatus(VerificationStatus.SUSPENDED);

    // This exact call returned 201 before the fix.
    const res = await request(app)
      .post('/v1/owner/hostels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Suspended Owner Property',
        addressLine: '1 Suspended Road',
        area: 'Kukatpally',
        latitude: 17.322,
        longitude: 78.2337,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_NOT_IN_GOOD_STANDING');

    const created = await prisma.hostel.count({
      where: { ownerId, name: 'Suspended Owner Property' },
    });
    expect(created).toBe(0);
  });

  it('a SUSPENDED owner is refused on every owner read route', async () => {
    await setStatus(VerificationStatus.SUSPENDED);

    for (const path of [
      '/v1/owner/dashboard',
      '/v1/owner/hostels',
      '/v1/owner/verification',
    ]) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status, `${path} should be 403`).toBe(403);
      expect(res.body.error.code).toBe('OWNER_NOT_IN_GOOD_STANDING');
    }
  });

  it('a SUSPENDED owner cannot upload a verification document', async () => {
    await setStatus(VerificationStatus.SUSPENDED);

    const res = await request(app)
      .post('/v1/owner/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'PAN_CARD', url: 'https://example.com/pan.pdf' });

    expect(res.status).toBe(403);
  });

  it('a REJECTED owner is refused too', async () => {
    await setStatus(VerificationStatus.REJECTED);

    const res = await request(app)
      .post('/v1/owner/hostels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Rejected Owner Property',
        addressLine: '2 Rejected Road',
        area: 'Kukatpally',
        latitude: 17.322,
        longitude: 78.2337,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_NOT_IN_GOOD_STANDING');
  });

  it('the error message does not leak the rejection reason', async () => {
    await prisma.owner.update({
      where: { id: ownerId },
      data: { verificationStatus: VerificationStatus.REJECTED, rejectionReason: 'PAN unreadable' },
    });

    const res = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(403);
    // The reason is shown inside the dashboard, which the rejected owner can no
    // longer reach — so it must not be smuggled out through the error instead.
    expect(JSON.stringify(res.body)).not.toContain('PAN unreadable');
  });
});

describe('H-1 — owners in good standing are unaffected', () => {
  it('an APPROVED owner can still use every owner route', async () => {
    await setStatus(VerificationStatus.APPROVED);

    for (const path of [
      '/v1/owner/dashboard',
      '/v1/owner/hostels',
      '/v1/owner/verification',
    ]) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status, `${path} should be 200`).toBe(200);
    }
  });

  it('an APPROVED owner can still create a property', async () => {
    await setStatus(VerificationStatus.APPROVED);

    const res = await request(app)
      .post('/v1/owner/hostels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: `H1 Approved Property ${RUN}`,
        addressLine: '3 Approved Road',
        area: 'Kukatpally',
        latitude: 17.322,
        longitude: 78.2337,
      });

    expect(res.status).toBe(201);
  });

  it('a DRAFT owner can still read the verification checklist', async () => {
    // Blocking DRAFT would deadlock onboarding: the only screen that explains what
    // to upload would be the one screen a new owner cannot open.
    await setStatus(VerificationStatus.DRAFT);

    const res = await request(app)
      .get('/v1/owner/verification')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checklist)).toBe(true);
  });

  it('a PENDING owner can still read the verification checklist', async () => {
    // PENDING means "submitted, awaiting review". It must not become a lockout.
    await setStatus(VerificationStatus.PENDING);

    const res = await request(app)
      .get('/v1/owner/verification')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
  });

  it('re-approving a suspended owner restores access immediately', async () => {
    await setStatus(VerificationStatus.SUSPENDED);
    const blocked = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(blocked.status).toBe(403);

    // An admin restoring the owner must take effect on the same token, which
    // proves the status is read from the database rather than the JWT.
    await setStatus(VerificationStatus.APPROVED);
    const restored = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(restored.status).toBe(200);
  });
});

describe('H-1 — other roles are still refused', () => {
  it('a student cannot reach owner routes', async () => {
    const student = await signIn(phoneFor(7), 'H1 Student');

    const res = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${student.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('a student cannot create a property', async () => {
    const student = await signIn(phoneFor(8), 'H1 Student 2');

    const res = await request(app)
      .post('/v1/owner/hostels')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({
        name: 'Student Property',
        addressLine: '4 Student Road',
        area: 'Kukatpally',
        latitude: 17.322,
        longitude: 78.2337,
      });

    expect(res.status).toBe(403);
  });

  it('an ADMIN is refused owner routes (the guard is owner-specific)', async () => {
    // Admins have their own surface. Letting them through here would blur the
    // boundary between "acting as yourself" and "acting as the platform".
    const res = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });
});

describe('H-1 — suspension still unpublishes existing properties', () => {
  it('suspending an owner hides their live listings from search', async () => {
    // The pre-existing behaviour this fix must not regress: suspending is meant to
    // take a property off the market, not just revoke the API.
    const created = await request(app)
      .post('/v1/owner/hostels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: `H1 Suspend Visibility ${RUN}`,
        addressLine: '5 Visibility Road',
        area: 'Kukatpally',
        latitude: 17.322,
        longitude: 78.2337,
      })
      .expect(201);

    await request(app)
      .patch(`/v1/owner/hostels/${created.body.hostel.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ published: true })
      .expect(200);

    const visibleBefore = await request(app).get(`/v1/hostels/${created.body.hostel.slug}`);
    expect(visibleBefore.body.hostel.published).toBe(true);

    await setStatus(VerificationStatus.SUSPENDED);
    await request(app)
      .post(`/v1/admin/owners/${ownerId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'SUSPENDED' })
      .expect(200);

    const visibleAfter = await prisma.hostel.findUniqueOrThrow({
      where: { id: created.body.hostel.id },
      select: { published: true },
    });
    expect(visibleAfter.published).toBe(false);
  });
});