import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Role, VerificationStatus } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { actorFrom } from '../../src/lib/adminAudit.js';

/**
 * H-5: the admin audit trail.
 *
 * The finding: an admin could suspend an owner, change a commission rate, moderate a
 * hostel or trigger a settlement, and nothing recorded that it had happened. In a
 * dispute the difference is between "here is what occurred" and "we cannot tell you".
 *
 * The guarantee being tested is APPEND-ONLY, and it is enforced by a database trigger
 * rather than by application code — so these tests deliberately try to UPDATE and
 * DELETE an entry, from raw SQL, and expect the database itself to refuse. A trail that
 * application code is merely careful about is not evidence.
 */

const app = createApp();

const ADMIN_PHONE = '9600000001';
const OWNER_PHONE = '9600000002';
const RUN = Math.random().toString(36).slice(2, 7);

let adminToken: string;
let adminId: string;
let ownerProfileId: string;

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

  const admin = await signIn(ADMIN_PHONE, 'Audit Admin');
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: Role.ADMIN } });
  // Re-signed in because requireRole reads the role out of the token.
  const admin2 = await signIn(ADMIN_PHONE, 'Audit Admin');
  adminToken = admin2.accessToken;
  adminId = admin.user.id;

  const owner = await signIn(OWNER_PHONE, 'Audit Owner', 'OWNER');
  const profile = await prisma.owner.findUniqueOrThrow({ where: { userId: owner.user.id } });
  ownerProfileId = profile.id;

  // Approving requires a document on file.
  await prisma.ownerDocument.create({
    data: { ownerId: profile.id, type: 'PAN_CARD', url: 'https://example.com/pan.pdf' },
  });
});

afterAll(async () => {
  await prisma.ownerDocument.deleteMany({ where: { ownerId: ownerProfileId } });
  for (const phone of [ADMIN_PHONE, OWNER_PHONE]) {
    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await prisma.owner.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
  // Audit rows are deliberately NOT deleted — the trigger forbids it, which is the
  // point. They are left behind as evidence that this suite ran.
  await prisma.$disconnect();
});

beforeEach(async () => {
  // The trail is append-only, so rows accumulate. Recording where this run starts lets
  // each test look only at its own entries rather than at everything ever written.
});

/**
 * Entries written since a marker.
 *
 * indLast throughout, never ind: this file runs several tests that perform the
 * same OWNER_VERIFY action, and a one-second window comfortably overlaps the preceding
 * test. Taking the first match asserts against an earlier test's entry, which failed
 * with a requestId that was perfectly correct � for the wrong row.
 */
async function entriesSince(marker: Date) {
  return prisma.adminAuditLog.findMany({
    where: { createdAt: { gte: marker } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('H-5 — a privileged action is recorded', () => {
  it('verifying an owner writes an audit entry', async () => {
    const marker = new Date(Date.now() - 1000);

    const res = await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.APPROVED });

    expect(res.status).toBe(200);

    const entries = await entriesSince(marker);
    const entry = entries.findLast((e) => e.action === 'OWNER_VERIFY');

    expect(entry, 'no OWNER_VERIFY entry was written').toBeTruthy();
    expect(entry!.targetType).toBe('Owner');
    expect(entry!.targetId).toBe(ownerProfileId);
    expect(entry!.summary).toContain('APPROVED');
  });

  it('the entry identifies WHO acted', async () => {
    const marker = new Date(Date.now() - 1000);

    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.SUSPENDED })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');

    expect(entry!.actorId).toBe(adminId);
    expect(entry!.actorPhone).toBe(ADMIN_PHONE);
    expect(entry!.actorRole).toBe('ADMIN');
  });

  it('the entry carries the request id, so it can be expanded into the request log', async () => {
    const marker = new Date(Date.now() - 1000);

    const res = await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'audit-trace-123')
      .send({ status: VerificationStatus.APPROVED });

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('audit-trace-123');

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');
    expect(entry!.requestId).toBe('audit-trace-123');
  });

  it('the entry records the client address', async () => {
    const marker = new Date(Date.now() - 1000);

    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.APPROVED })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');
    expect(entry!.ipAddress).toBeTruthy();
  });

  it('a commission override is recorded too', async () => {
    const marker = new Date(Date.now() - 1000);

    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/commission-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      // basis points, not a percentage — the body is nullable because clearing the
      // override back to the platform default is a valid action worth recording.
      .send({ commissionOverrideBps: 1250 })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'COMMISSION_OVERRIDE');
    expect(entry, 'no COMMISSION_OVERRIDE entry was written').toBeTruthy();
    expect(entry!.summary).toContain('1250');
  });

  it('a READ of the audit trail is not itself recorded', async () => {
    const marker = new Date(Date.now() - 1000);

    await request(app)
      .get('/v1/admin/owners')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Only mutations belong in the trail. Logging reads would bury the entries that
    // matter under a constant stream of "an admin looked at a page".
    const entries = await entriesSince(marker);
    expect(entries.filter((e) => e.action === 'ADMIN_VIEW')).toEqual([]);
  });
});

describe('H-5 — the trail is append-only, enforced by the database', () => {
  it('UPDATE is refused by the database', async () => {
    const marker = new Date(Date.now() - 1000);
    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.APPROVED })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');
    expect(entry).toBeTruthy();

    // Raw SQL, not Prisma: the point is that the DATABASE refuses, so a test that went
    // through the client could be passing because the client chose not to try.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "admin_audit_log" SET "summary" = 'rewritten' WHERE id = '${entry!.id}'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('DELETE is refused by the database', async () => {
    const marker = new Date(Date.now() - 1000);
    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.SUSPENDED })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "admin_audit_log" WHERE id = '${entry!.id}'`),
    ).rejects.toThrow(/append-only/i);

    expect(await prisma.adminAuditLog.findUnique({ where: { id: entry!.id } })).not.toBeNull();
  });

  it('the original text survives an attempted rewrite', async () => {
    const marker = new Date(Date.now() - 1000);
    await request(app)
      .post(`/v1/admin/owners/${ownerProfileId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: VerificationStatus.APPROVED })
      .expect(200);

    const entry = (await entriesSince(marker)).findLast((e) => e.action === 'OWNER_VERIFY');
    const original = entry!.summary;

    await prisma
      .$executeRawUnsafe(`UPDATE "admin_audit_log" SET "summary" = 'x' WHERE id = '${entry!.id}'`)
      .catch(() => undefined);

    const after = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: entry!.id } });
    expect(after.summary).toBe(original);
  });
});

describe('H-5 — the actor is resolved from the token, never the request', () => {
  it('actorFrom returns the phone for a live account', async () => {
    const actor = await actorFrom(prisma, { sub: adminId, role: Role.ADMIN });
    expect(actor).toEqual({ id: adminId, phone: ADMIN_PHONE, role: Role.ADMIN });
  });

  it('and still records something identifiable for a deleted account', async () => {
    // The trail must outlive the account — that is why actorPhone is denormalised and
    // why there is no foreign key to User.
    const actor = await actorFrom(prisma, { sub: 'nonexistent-user-id', role: Role.ADMIN });
    expect(actor.id).toBe('nonexistent-user-id');
    expect(actor.role).toBe('ADMIN');
    expect(actor.phone).toBe('unknown');
  });
});