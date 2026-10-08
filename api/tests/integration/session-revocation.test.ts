import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { requireAuth, requireRole, signAccessToken } from '../../src/http/auth.js';
import { AppError } from '../../src/lib/errors.js';

/**
 * H-2 regression: a deactivated account must stop working IMMEDIATELY.
 *
 * The defect: requireAuth verified the JWT signature and nothing else. An admin
 * setting isActive = false had no effect on an already-issued access token —
 * GET /v1/auth/me answered 200 for a deleted account until the 15-minute token
 * expired on its own. Confirmed live before the fix.
 *
 * These drive the real HTTP routes. A unit test on the middleware would not prove
 * the middleware is reached by the routes that use it, and the set of routes matters:
 * /v1/auth/me and /v1/notifications use requireAuth ALONE, which is exactly where
 * the old code did no database read at all.
 */

const app = createApp();
const RUN = Math.random().toString(36).slice(2, 7);

const createdUserIds: string[] = [];

/**
 * Ten digits beginning with 9, matching the signup validator.
 *
 * The index is taken mod 10 so it always occupies exactly one digit — an earlier
 * version appended the raw number, so phoneFor(10) produced an 11-digit string and
 * the signup validator answered 400.
 */
const phoneFor = (n: number) => `9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}${n % 10}`;

async function makeUser(index: number, name: string, role: 'STUDENT' | 'OWNER' = 'STUDENT') {
  const phone = phoneFor(index);
  const req = await request(app).post('/v1/auth/otp/request').send({ phone });
  expect(req.status).toBe(200);
  const res = await request(app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: req.body.devOtp, name, registerRole: role });
  expect(res.status).toBe(200);
  createdUserIds.push(res.body.user.id);
  return { token: res.body.accessToken as string, userId: res.body.user.id as string };
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await prisma.refreshToken.deleteMany({ where: { userId: id } });
    await prisma.notification.deleteMany({ where: { userId: id } });
    await prisma.owner.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe('H-2 — a deactivated account loses access at once', () => {
  it('GET /v1/auth/me returns 403 once isActive is false (the H-2 exploit)', async () => {
    const { token, userId } = await makeUser(1, 'H2 Victim');

    const before = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    // This exact call answered 200 before the fix.
    const after = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('the notification routes are refused too — they used requireAuth on its own', async () => {
    // This is the route family that previously did NO database read whatsoever:
    // notificationsRouter.use(requireAuth) with no requireRole after it.
    const { token, userId } = await makeUser(2, 'H2 Notifications');
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    const list = await request(app)
      .get('/v1/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const read = await request(app)
      .post('/v1/notifications/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [] });
    expect(read.status).toBe(403);

    const retry = await request(app)
      .post('/v1/notifications/retry-push')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(retry.status).toBe(403);
  });

  it('an owner route is refused for a deactivated owner', async () => {
    const { token, userId } = await makeUser(3, 'H2 Owner', 'OWNER');
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    const res = await request(app)
      .get('/v1/owner/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('a booking route is refused for a deactivated student', async () => {
    const { token, userId } = await makeUser(4, 'H2 Student');
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    const res = await request(app)
      .get('/v1/bookings/')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('an admin route is refused for a deactivated admin', async () => {
    const { token, userId } = await makeUser(5, 'H2 Admin');
    await prisma.user.update({ where: { id: userId }, data: { role: Role.ADMIN, isActive: false } });

    const res = await request(app)
      .get('/v1/admin/owners')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('a DELETED account is 401, not 403', async () => {
    // A valid signature for a row that no longer exists must not be treated as a
    // working session. 401 rather than 403 because there is no account to appeal to.
    const { token, userId } = await makeUser(6, 'H2 Deleted');
    await prisma.user.delete({ where: { id: userId } });
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    const res = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('re-activating restores access on the SAME token', async () => {
    // The proof that the decision comes from the database rather than the token:
    // nothing about the token changes across the two calls.
    const { token, userId } = await makeUser(7, 'H2 Reactivated');

    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    const blocked = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);

    await prisma.user.update({ where: { id: userId }, data: { isActive: true } });
    const restored = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(restored.status).toBe(200);
  });

  it('an active account is completely unaffected', async () => {
    const { token } = await makeUser(8, 'H2 Active');

    const res = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
  });
});

describe('H-2 — requireRole fails closed when requireAuth did not run', () => {
  // A misordered middleware chain must not become a way around the check. This is
  // exercised directly because no route does it today, and the point is to keep that
  // true: it is a regression guard on the wiring, not a live behaviour.
  it('refuses when req.user is absent', () => {
    const req = {
      auth: { sub: 'someone', role: Role.ADMIN },
    } as unknown as Request;
    const next = vi.fn();

    requireRole(Role.ADMIN)(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
  });

  it('refuses when req.auth is absent too', () => {
    const req = { user: { id: 'x', role: Role.ADMIN, isActive: true } } as unknown as Request;
    const next = vi.fn();

    requireRole(Role.ADMIN)(req, {} as Response, next);

    expect(next.mock.calls[0]![0]).toBeInstanceOf(AppError);
    expect((next.mock.calls[0]![0] as AppError).status).toBe(401);
  });

  it('still enforces the role when both are present', () => {
    const req = {
      auth: { sub: 'x', role: Role.STUDENT },
      user: { id: 'x', role: Role.STUDENT, isActive: true },
    } as unknown as Request;
    const next = vi.fn();

    requireRole(Role.ADMIN)(req, {} as Response, next);

    expect((next.mock.calls[0]![0] as AppError).status).toBe(403);
  });
});

describe('H-3 — the role in the token is a snapshot', () => {
  // H-3 is a documentation finding, not a code defect: role is read from the JWT, so
  // a promotion does not reach an existing token. That is the accepted trade-off,
  // and it is pinned here so a future change to requireRole either keeps the
  // behaviour and the documentation, or updates both.
  it('a promotion does NOT reach an already-issued token', async () => {
    const { token, userId } = await makeUser(9, 'H3 Promoted');

    // Token says STUDENT.
    const before = await request(app).get('/v1/admin/owners').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(403);

    await prisma.user.update({ where: { id: userId }, data: { role: Role.ADMIN } });

    // Database says ADMIN. The token still does not.
    const after = await request(app).get('/v1/admin/owners').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('a demotion does NOT revoke an already-issued admin token either', async () => {
    const { userId } = await makeUser(10, 'H3 Demoted');
    await prisma.user.update({ where: { id: userId }, data: { role: Role.ADMIN } });

    // Minted while ADMIN, so it says ADMIN.
    const adminToken = signAccessToken({ sub: userId, role: Role.ADMIN });
    const before = await request(app).get('/v1/admin/owners').set('Authorization', `Bearer ${adminToken}`);
    expect(before.status).toBe(200);

    // Demoted in the database. The token is unaffected — this is the documented gap.
    await prisma.user.update({ where: { id: userId }, data: { role: Role.STUDENT } });
    const after = await request(app).get('/v1/admin/owners').set('Authorization', `Bearer ${adminToken}`);
    expect(after.status).toBe(200);

    // isActive still revokes immediately, which is why it is read from the database.
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    const disabled = await request(app).get('/v1/admin/owners').set('Authorization', `Bearer ${adminToken}`);
    expect(disabled.status).toBe(403);
  });
});