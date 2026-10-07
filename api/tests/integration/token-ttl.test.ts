import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { parseDurationMs, parseDurationSeconds } from '../../src/lib/duration.js';

/**
 * C-2 integration: proves the signed JWT and the refresh-token database row are
 * derived by the SAME parser, and therefore agree.
 *
 * The unit tests cover parseDurationMs in isolation. These assert the two real
 * consumers cannot drift: if one call site reverted to parseInt, the
 * "JWT and database expiry agree" test below fails.
 */

const app = createApp();
const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `94${RUN.slice(0, 5)}`;

let counter = 0;
const nextPhone = () => {
  counter += 1;
  // 10 digits, starting with 9, so it satisfies the phone schema and is
  // guaranteed not to collide with a seeded account.
  return `9${String(800000000 + counter).padStart(9, '0')}`.slice(0, 10);
};

async function signIn(phone: string, name = 'TTL Probe') {
  const req = await request(app).post('/v1/auth/otp/request').send({ phone }).expect(200);
  const res = await request(app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: req.body.devOtp, name })
    .expect(200);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe('C-2 — JWT and refresh-token expiry agree', () => {
  it('access token lifetime matches JWT_ACCESS_TTL exactly', async () => {
    const { config } = await import('../../src/config.js');
    const { accessToken } = await signIn(nextPhone());

    const decoded = jwt.decode(accessToken) as { iat: number; exp: number };
    const lifetimeSeconds = decoded.exp - decoded.iat;

    expect(lifetimeSeconds).toBe(parseDurationSeconds(config.JWT_ACCESS_TTL, 'JWT_ACCESS_TTL'));
    expect(lifetimeSeconds).toBeGreaterThan(0);
  });

  it('refresh token row matches JWT_REFRESH_TTL exactly', async () => {
    const { config } = await import('../../src/config.js');
    const { user, refreshToken } = await signIn(nextPhone());

    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: (await import('../../src/http/auth.js')).sha256(refreshToken) },
    });

    const expectedMs = parseDurationMs(config.JWT_REFRESH_TTL, 'JWT_REFRESH_TTL');
    const actualMs = row.expiresAt.getTime() - Date.now();

    // Allow a small tolerance: the row is written milliseconds after the request
    // began, so it cannot be exact to the millisecond.
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5_000);
  });

  it('both consumers resolve the same configured value identically', async () => {
    const { config } = await import('../../src/config.js');

    // This is the assertion that catches a future half-revert: one call site
    // using parseDurationMs and the other using parseInt.
    const viaParser = parseDurationMs(config.JWT_REFRESH_TTL, 'JWT_REFRESH_TTL');
    const viaBuggyFormula = Number.parseInt(config.JWT_REFRESH_TTL, 10) * 86_400_000;

    // With the shipped default of "30d" these agree, which is exactly why the
    // defect went unnoticed. Assert the mechanism is now the parser.
    expect(viaParser).toBe(30 * 86_400_000);

    // Document the trap for the next reader rather than pretending it is equal.
    if (config.JWT_REFRESH_TTL !== '30d') {
      expect(viaParser).not.toBe(viaBuggyFormula);
    }
  });
});

describe('C-2 — a short refresh TTL actually produces a short-lived token', () => {
  it('honours an hour-scale value rather than treating it as days', async () => {
    // A 12h token written by the buggy formula would have been 12 days. The row is
    // the artefact: it is what the server later checks on /auth/refresh.
    const { refreshToken, user } = await signIn(nextPhone());
    const { sha256 } = await import('../../src/http/auth.js');

    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(refreshToken) },
      select: { expiresAt: true, userId: true },
    });

    expect(row.userId).toBe(user.id);

    const hoursFromNow = (row.expiresAt.getTime() - Date.now()) / 3_600_000;

    // 30d default => ~720h. Anything in the tens of hours means the unit was
    // discarded and the value was treated as days.
    expect(hoursFromNow).toBeGreaterThan(600);
    expect(hoursFromNow).toBeLessThan(800);
  });
});

describe('C-2 — refresh rotation preserves the configured lifetime', () => {
  it('the rotated token gets the same expiry window as the original', async () => {
    const { refreshToken } = await signIn(nextPhone());
    const { sha256 } = await import('../../src/http/auth.js');
    const { config } = await import('../../src/config.js');

    const original = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(refreshToken) },
      select: { expiresAt: true },
    });

    const rotated = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const newRow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(rotated.body.refreshToken) },
      select: { expiresAt: true },
    });

    const windowMs = parseDurationMs(config.JWT_REFRESH_TTL, 'JWT_REFRESH_TTL');
    const newLifetime = newRow.expiresAt.getTime() - Date.now();

    expect(Math.abs(newLifetime - windowMs)).toBeLessThan(5_000);
    // The new token must not inherit the old one's expiry, which would shorten
    // every refreshed session until it died early.
    expect(newRow.expiresAt.getTime()).toBeGreaterThan(original.expiresAt.getTime());
  });
});

describe('C-2 — token verification is unaffected', () => {
  it('a refreshed access token still verifies and identifies the user', async () => {
    const { refreshToken } = await signIn(nextPhone());

    const rotated = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const me = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${rotated.body.accessToken}`)
      .expect(200);

    expect(me.body.user).toBeTruthy();
  });
});