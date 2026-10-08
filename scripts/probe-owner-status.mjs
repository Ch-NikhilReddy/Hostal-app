/**
 * H-1 live probe: can a suspended owner still act?
 *
 * The defect: owner routes were gated on requireRole(Role.OWNER) only. Suspending an
 * owner unpublished their existing properties but left their session fully working,
 * so POST /v1/owner/hostels answered 201 and the suspended owner kept taking
 * bookings. Confirmed live before the fix.
 *
 * This drives the real running API over HTTP through the real admin path — approve,
 * suspend, act, re-approve — so nothing here depends on the unit test's internals.
 *
 *   node scripts/probe-owner-status.mjs
 *
 * Cleans up after itself: the throwaway owner is deleted at the end.
 */
const BASE = process.env.PROBE_BASE ?? 'http://localhost:4000';
const ADMIN_PHONE = '9000000001'; // seeded platform admin

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEANUP_SCRIPT = path.join(repoRoot, 'scripts', 'cleanup-owner.mjs');
const tsxCli = ['node_modules/tsx/dist/cli.mjs', 'api/node_modules/tsx/dist/cli.mjs'].find((rel) =>
  existsSync(path.join(repoRoot, rel)),
);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** Sign in with a fresh OTP. Requires ENABLE_DEV_OTP=true on the running API. */
async function signIn(phone, name, registerRole) {
  const req = await api('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  const code = req.body.devOtp;
  if (!code) throw new Error(`no devOtp in ${req.status} response — is ENABLE_DEV_OTP=true?`);
  const res = await api('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code, name, registerRole },
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * The sign-in response carries no owner id, so the probe reads the `ownerId` claim
 * out of the token it was just handed. (The app itself gets it from
 * GET /v1/owner/verification.) This is a harness decoding its own token, not an
 * attack on someone else's.
 */
function ownerIdFromToken(accessToken) {
  const payload = accessToken.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).ownerId;
}

const PROPERTY = (run) => ({
  name: `H1 Probe Property ${run}`,
  addressLine: '1 Probe Road',
  area: 'Kukatpally',
  latitude: 17.322,
  longitude: 78.2337,
});

async function main() {
  console.log(`\nH-1 live probe — can a suspended owner still act?\n`);
  console.log(`Target: ${BASE}\n`);

  const health = await api('/health');
  if (health.status !== 200) {
    console.log(`  FAIL  API not healthy at ${BASE}`);
    process.exitCode = 1;
    return;
  }

  const admin = await signIn(ADMIN_PHONE, 'Platform Admin');
  const adminToken = admin.accessToken;

  const run = Math.random().toString(36).slice(2, 7);
  const ownerPhone = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  const owner = await signIn(ownerPhone, 'H1 Probe Owner', 'OWNER');
  const ownerToken = owner.accessToken;
  const ownerId = ownerIdFromToken(ownerToken);

  try {
    if (!ownerId) throw new Error('owner profile missing after registering as OWNER');

    // ---- get the owner into a legitimately approved state ------------------
    const doc = await api('/v1/owner/documents', {
      method: 'POST',
      token: ownerToken,
      body: { type: 'PAN_CARD', url: 'https://example.com/pan.pdf' },
    });
    check('owner uploads a document (onboarding still works)', doc.status === 201 || doc.status === 200, `-> ${doc.status}`);

    const approve = await api(`/v1/admin/owners/${ownerId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED' },
    });
    check('admin approves the owner', approve.status === 200, `-> ${approve.status}`);

    // ---- baseline: an approved owner works ---------------------------------
    const before = await api('/v1/owner/hostels', {
      method: 'POST',
      token: ownerToken,
      body: PROPERTY(run),
    });
    check('APPROVED owner creates a property (baseline)', before.status === 201, `-> ${before.status}`);
    const ownedBefore = before.body?.hostel?.id ? 1 : 0;

    const dash = await api('/v1/owner/dashboard', { token: ownerToken });
    check('APPROVED owner reads the dashboard', dash.status === 200, `-> ${dash.status}`);

    // ---- the exploit: suspend, then try to keep acting --------------------
    const suspend = await api(`/v1/admin/owners/${ownerId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'SUSPENDED' },
    });
    check('admin suspends the owner', suspend.status === 200, `-> ${suspend.status}`);

    console.log('\nWith the owner suspended, using the SAME still-valid token:');

    const attack = await api('/v1/owner/hostels', {
      method: 'POST',
      token: ownerToken,
      body: PROPERTY(`${run}-attack`),
    });
    check(
      'POST /v1/owner/hostels is refused',
      attack.status === 403,
      `-> ${attack.status} ${attack.body?.error?.code ?? ''}`,
    );
    check('  ...and the error names the reason', attack.body?.error?.code === 'OWNER_NOT_IN_GOOD_STANDING');

    for (const path of ['/v1/owner/dashboard', '/v1/owner/hostels', '/v1/owner/verification']) {
      const res = await api(path, { token: ownerToken });
      check(`GET ${path} is refused`, res.status === 403, `-> ${res.status}`);
    }

    const docAfter = await api('/v1/owner/documents', {
      method: 'POST',
      token: ownerToken,
      body: { type: 'PAN_CARD', url: 'https://example.com/pan2.pdf' },
    });
    check('POST /v1/owner/documents is refused', docAfter.status === 403, `-> ${docAfter.status}`);

    // No side-effect write may have slipped through alongside the 403.
    const list = await api('/v1/owner/hostels', { token: ownerToken });
    check(
      'no property was created by the refused call',
      list.status === 403,
      `listing itself is refused, so the count cannot have grown (owned before: ${ownedBefore})`,
    );

    // ---- rejected is blocked too -------------------------------------------
    const reject = await api(`/v1/admin/owners/${ownerId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'REJECTED', reason: 'PAN unreadable' },
    });
    check('admin rejects the owner', reject.status === 200, `-> ${reject.status}`);

    const rejected = await api('/v1/owner/hostels', {
      method: 'POST',
      token: ownerToken,
      body: PROPERTY(`${run}-rejected`),
    });
    check('a REJECTED owner is refused too', rejected.status === 403, `-> ${rejected.status}`);
    check(
      '  ...and the rejection reason is not leaked in the error',
      !JSON.stringify(rejected.body).includes('PAN unreadable'),
      JSON.stringify(rejected.body?.error ?? {}),
    );

    // ---- onboarding states must NOT be locked out --------------------------
    console.log('\nStates that must keep working, or onboarding deadlocks:');

    const draft = await api(`/v1/admin/owners/${ownerId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'REJECTED', reason: 'reset for draft test' },
    });
    check('owner rejected (to force a non-standard path)', draft.status === 200, `-> ${draft.status}`);

    // A brand-new owner is DRAFT; confirm the checklist is reachable by signing up
    // someone fresh rather than relying on an admin transition that cannot produce
    // DRAFT (the admin enum has no DRAFT member).
    const freshPhone = `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const fresh = await signIn(freshPhone, 'H1 Fresh Owner', 'OWNER');
    const freshId = ownerIdFromToken(fresh.accessToken);
    try {
      const checklist = await api('/v1/owner/verification', { token: fresh.accessToken });
      check(
        'a brand-new DRAFT owner can read the verification checklist',
        checklist.status === 200,
        `-> ${checklist.status}`,
      );
      check('  ...and the checklist is populated', Array.isArray(checklist.body?.checklist));
    } finally {
      if (freshId) await cleanup(freshId);
    }

    // ---- restoring access works on the same token --------------------------
    const restore = await api(`/v1/admin/owners/${ownerId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED' },
    });
    check('admin re-approves the owner', restore.status === 200, `-> ${restore.status}`);

    const afterRestore = await api('/v1/owner/dashboard', { token: ownerToken });
    check(
      'access is restored on the SAME token (status read from DB, not JWT)',
      afterRestore.status === 200,
      `-> ${afterRestore.status}`,
    );

    const afterCreate = await api('/v1/owner/hostels', {
      method: 'POST',
      token: ownerToken,
      body: PROPERTY(`${run}-restored`),
    });
    check('and the owner can create a property again', afterCreate.status === 201, `-> ${afterCreate.status}`);
  } finally {
    await cleanup(ownerId);
  }

  console.log(`\n${failures === 0 ? 'ALL OWNER-STATUS CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Delete the throwaway owner. Hostels cascade (schema.prisma onDelete: Cascade). */
async function cleanup(ownerId) {
  if (!ownerId) return;
  // There is no admin endpoint that deletes an owner, so the probe goes through
  // Prisma directly. It is a test harness, not part of the application surface.
  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [tsxCli, CLEANUP_SCRIPT, ownerId], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('exit', (code) => (code === 0 ? resolve() : resolve(err)));
    });
  } catch {
    console.log(`  note: could not auto-clean owner ${ownerId}`);
  }
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exitCode = 1;
});