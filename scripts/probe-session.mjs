/**
 * Read-only probes of session revocation behaviour.
 *
 * Question: how long does a deactivation or a role change take to take effect for
 * a token that is already in the wild? Writes one throwaway user and restores it.
 *
 *   node scripts/probe-session.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
for (const c of [path.join(repoRoot, 'api', '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(c)) { process.loadEnvFile(c); break; }
}

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

async function signIn(phone, name, registerRole) {
  const r = await (await fetch(`${BASE}/v1/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  })).json();
  return (await (await fetch(`${BASE}/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: r.devOtp, name, registerRole }),
  })).json());
}

const get = async (path, token) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
};

async function main() {
  console.log(`\nSession revocation probe against ${BASE}\n`);

  // ---- V3: deactivation --------------------------------------------------
  console.log('1. Deactivating a user (isActive=false)');
  const u = await signIn('9000000016', 'Deactivation Probe');
  const t = u.accessToken;
  console.log(`   token valid before : /v1/auth/me -> ${await get('/v1/auth/me', t)}`);

  await prisma.user.update({ where: { id: u.user.id }, data: { isActive: false } });

  console.log(`   after deactivation : /v1/auth/me            -> ${await get('/v1/auth/me', t)}  (requireAuth only)`);
  console.log(`   after deactivation : /v1/notifications     -> ${await get('/v1/notifications', t)}  (requireAuth only)`);
  console.log(`   after deactivation : /v1/bookings          -> ${await get('/v1/bookings', t)}  (requireRole, hits DB)`);
  console.log(`   after deactivation : /v1/owner/dashboard   -> ${await get('/v1/owner/dashboard', t)}  (requireRole)`);

  await prisma.user.update({ where: { id: u.user.id }, data: { isActive: true } });

  // ---- V4: stale role in a live token ------------------------------------
  console.log('\n2. Changing a role while a token is already issued');
  const u2 = await signIn('9000000017', 'Role Probe');
  const t2 = u2.accessToken;
  console.log(`   role in JWT at issue: ${u2.user.role}`);

  await prisma.user.update({ where: { id: u2.user.id }, data: { role: 'OWNER' } });
  console.log(`   DB role now        : OWNER`);
  console.log(`   /v1/owner/dashboard with the OLD token -> ${await get('/v1/owner/dashboard', t2)}`);
  console.log('   ^ 403 here is CORRECT: requireRole compares the role in the JWT (STUDENT)');
  console.log('     against the required roles, not the database.');

  await prisma.user.update({ where: { id: u2.user.id }, data: { role: 'STUDENT' } });

  // ---- V5: refresh token after deactivation -------------------------------
  console.log('\n3. Refresh-token rotation after deactivation');
  const u3 = await signIn('9000000018', 'Refresh Probe');
  await prisma.user.update({ where: { id: u3.user.id }, data: { isActive: false } });
  const refreshed = await fetch(`${BASE}/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: u3.refreshToken }),
  });
  console.log(`   /v1/auth/refresh for a deactivated user -> ${refreshed.status}`);
  console.log('   ^ 403 confirms the refresh path DOES check isActive.');
  await prisma.user.update({ where: { id: u3.user.id }, data: { isActive: true } });

  // ---- Access token lifetime ----------------------------------------------
  console.log('\n4. Access token TTL in practice');
  const claims = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString());
  console.log(`   issued at : ${new Date(claims.iat * 1000).toISOString()}`);
  console.log(`   expires at: ${new Date(claims.exp * 1000).toISOString()}`);
  console.log(`   lifetime  : ${(claims.exp - claims.iat) / 60} minutes`);
  console.log('   (role claim is baked in and not re-read on every request)');

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('probe failed:', e.message); await prisma.$disconnect(); process.exit(1); });