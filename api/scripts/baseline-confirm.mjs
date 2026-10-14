/**
 * PHASE 0 BASELINE — Finding confirmation.
 *
 * Confirms each audit finding against the current source, read-only. Prints
 * CONFIRMED / NOT-REPRODUCIBLE / PARTIAL per finding so remediation does not chase
 * a finding that no longer applies.
 *
 *   node api/scripts/baseline-confirm.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Read a repo-relative text file, or '' when it is missing.
 * statSync guards against being handed a directory, which readFileSync treats as
 * a fatal EISDIR rather than a miss.
 */
const read = (rel) => {
  const abs = path.join(repoRoot, rel);
  try {
    if (!existsSync(abs) || statSync(abs).isDirectory()) return '';
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
};

/** Concatenate every .ts file under a repo-relative directory. */
const readDir = (rel) => {
  const abs = path.join(repoRoot, rel);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.ts')) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(abs);
  return out.join('\n');
};

const app = read('api/src/app.ts');
const config = read('api/src/config.ts');
const authRoutes = read('api/src/modules/auth.routes.ts');
const httpAuth = read('api/src/http/auth.ts');
const ownerRoutes = read('api/src/modules/owner.routes.ts');
const adminRoutes = read('api/src/modules/admin.routes.ts');
const catalogRoutes = read('api/src/modules/catalog.routes.ts');
const bookingsRoutes = read('api/src/modules/bookings.routes.ts');
const apiPkg = read('api/package.json');

const rows = [];
const add = (id, status, finding, evidence) => rows.push({ id, status, finding, evidence });

// ---- C-1 CORS -------------------------------------------------------------
{
  const reflects = /origin:\s*config\.isProduction[\s\S]{0,120}:\s*true/.test(app);
  const credentials = /credentials:\s*true/.test(app);
  add(
    'C-1',
    reflects && credentials ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'CORS reflects any Origin while allowing credentials',
    `app.ts: origin:${reflects ? ' conditional -> true in non-prod' : ' not reflective'}, credentials:${credentials}`,
  );
}

// ---- C-2 TTL parser -------------------------------------------------------
{
  const bad = /Number\.parseInt\(config\.JWT_REFRESH_TTL, 10\)\s*\*\s*86_400_000/.test(authRoutes);
  const count = (authRoutes.match(/parseInt\(config\.JWT_REFRESH_TTL/g) ?? []).length;
  add(
    'C-2',
    bad ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'Refresh-token TTL discards the unit suffix',
    `auth.routes.ts: ${count} occurrence(s) of parseInt(JWT_REFRESH_TTL) * 86_400_000`,
  );
}

// ---- C-3 dev OTP ----------------------------------------------------------
{
  const gated = /isProduction\s*\?\s*\{\}\s*:\s*\{\s*devOtp/.test(authRoutes);
  const explicitFlag = /ENABLE_DEV_OTP/.test(authRoutes) || /ENABLE_DEV_OTP/.test(config);
  add(
    'C-3',
    gated && !explicitFlag ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'OTP returned in the response body, gated only on NODE_ENV',
    `auth.routes.ts: gated on isProduction=${gated}; explicit ENABLE_DEV_OTP flag present=${explicitFlag}`,
  );
}

// ---- H-1 suspended owner --------------------------------------------------
{
  const routerUse = /ownerRouter\.use\(requireAuth, requireRole\(Role\.OWNER\)\)/.test(ownerRoutes);
  const checksStatus = /requireOwner[\s\S]{0,900}SUSPENDED/.test(ownerRoutes);
  add(
    'H-1',
    routerUse && !checksStatus ? 'CONFIRMED' : 'PARTIAL',
    'Suspended owner retains owner-route access',
    `owner.routes.ts: router-level role check=${routerUse}; requireOwner checks SUSPENDED=${checksStatus}`,
  );
}

// ---- H-2 deactivated user -------------------------------------------------
{
  const requireAuthHitsDb = /export function requireAuth[\s\S]{0,600}prisma\./.test(httpAuth);
  add(
    'H-2',
    requireAuthHitsDb ? 'NOT-REPRODUCIBLE' : 'CONFIRMED',
    'requireAuth validates signature only; inactive users keep access until expiry',
    `http/auth.ts: requireAuth queries the database=${requireAuthHitsDb}`,
  );
}

// ---- H-3 role from JWT ----------------------------------------------------
{
  const fromClaim = /role:\s*decoded\.role as Role/.test(httpAuth);
  add(
    'H-3',
    fromClaim ? 'CONFIRMED (by design)' : 'NOT-REPRODUCIBLE',
    'Role comes from the JWT claim, not the database',
    `http/auth.ts: role sourced from decoded claim=${fromClaim}`,
  );
}

// ---- H-4 rate limiting ----------------------------------------------------
{
  // Only a real limiter counts. Comments and the OTP helper's own prose must not
  // register as HTTP middleware, or this reports a false PARTIAL.
  const pkgText = read('api/package.json');
  const hasMiddleware =
    /express-rate-limit/.test(pkgText) ||
    /from ['"]express-rate-limit['"]|require\(['"]express-rate-limit['"]\)/.test(readDir('api/src'));
  const otpOnly = /otpAttempts/.test(authRoutes);
  add(
    'H-4',
    hasMiddleware ? 'NOT-REPRODUCIBLE' : 'CONFIRMED',
    'No HTTP rate limiting beyond the in-process OTP helper',
    `express-rate-limit installed=${hasMiddleware}; only an OTP counter exists=${otpOnly}`,
  );
}

// ---- H-5 admin audit ------------------------------------------------------
{
  const audit = /audit|actorLog|activityLog|adminAudit/i.test(adminRoutes);
  add('H-5', audit ? 'PARTIAL' : 'CONFIRMED', 'No audit trail for admin mutations', `admin.routes.ts references an audit mechanism=${audit}`);
}

// ---- H-6 prisma CLI -------------------------------------------------------
{
  let version = 'unknown';
  const pj = JSON.parse(apiPkg || '{}');
  version = pj.devDependencies?.prisma ?? 'not declared';
  const inRuntime = Boolean(pj.dependencies?.prisma);
  add(
    'H-6',
    inRuntime ? 'CONFIRMED' : 'PARTIAL (dev-only)',
    'prisma CLI is in the flagged advisory range',
    `declared as ${inRuntime ? 'runtime dependency' : 'devDependency'}: ${version}`,
  );
}

// ---- M-1 backups ----------------------------------------------------------
{
  // The audit scripts added during the audit are themselves named probe-*, so
  // check the repo layout rather than trusting a filename match alone.
  const candidateDirs = ['scripts', 'api/scripts'].map((d) => path.join(repoRoot, d)).filter(existsSync);
  const names = candidateDirs.flatMap((d) => readdirSync(d));
  const hasBackup = names.some((f) => /backup|restore|dump/i.test(f));
  add('M-1', hasBackup ? 'PARTIAL' : 'CONFIRMED', 'No backup or restore tooling', `backup/restore/dump script found=${hasBackup}`);
}

// ---- M-2 migrations -------------------------------------------------------
{
  const mig = existsSync(path.join(repoRoot, 'api/prisma/migrations'));
  add('M-2', mig ? 'NOT-REPRODUCIBLE' : 'CONFIRMED', 'No Prisma migration history', `api/prisma/migrations exists=${mig}`);
}

// ---- M-3 CI ---------------------------------------------------------------
{
  const ci = existsSync(path.join(repoRoot, '.github'));
  add('M-3', ci ? 'NOT-REPRODUCIBLE' : 'CONFIRMED', 'No CI pipeline', `.github exists=${ci}`);
}

// ---- M-4 owner notified on cancel -----------------------------------------
{
  const start = bookingsRoutes.indexOf("'/:ref/cancel'");
  const segment = start > -1 ? bookingsRoutes.slice(start, start + 2600) : '';
  const notifies = /notify\(/.test(segment);
  add('M-4', notifies ? 'NOT-REPRODUCIBLE' : 'CONFIRMED', 'Owner is not notified when a student cancels', `cancel handler calls notify()=${notifies}`);
}

// ---- M-5 refunds ----------------------------------------------------------
{
  const claimsRefund = /refundEligible/.test(bookingsRoutes);
  const refundImpl = /refundRoutes|refundPayment|razorpay.*refund/i.test(bookingsRoutes + read('api/src/services/payments.ts'));
  add(
    'M-5',
    claimsRefund && !refundImpl ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'API advertises refunds that no code performs',
    `refundEligible returned=${claimsRefund}; refund implementation present=${refundImpl}`,
  );
}

// ---- M-6 retention --------------------------------------------------------
{
  const purge = /deleteMany[\s\S]{0,200}otpCode|pruneOtps|cleanupOtps/i.test(read('api/src/services/availability.ts') + authRoutes + read('api/src/services/sms.ts'));
  add('M-6', purge ? 'PARTIAL' : 'CONFIRMED', 'No OTP / refresh-token retention job', `purging routine present=${purge}`);
}

// ---- M-7 postgres exposure ------------------------------------------------
{
  const compose = read('docker-compose.yml');
  const bindAll = /ports:\s*\n\s*-\s*'\$\{POSTGRES_PORT[^}]*\}:5432'/.test(compose);
  const localhostOnly = /127\.0\.0\.1:\$\{POSTGRES_PORT/.test(compose);
  add('M-7', bindAll && !localhostOnly ? 'CONFIRMED' : 'NOT-REPRODUCIBLE', 'Postgres published on all interfaces', `compose binds 0.0.0.0=${bindAll && !localhostOnly}`);
}

// ---- M-8 health -----------------------------------------------------------
{
  const leaks = /paymentProvider:\s*config\.paymentProvider/.test(app) && /env:\s*config\.NODE_ENV/.test(app);
  add('M-8', leaks ? 'CONFIRMED' : 'NOT-REPRODUCIBLE', '/health reveals env and payment provider', `app.ts health handler exposes env+provider=${leaks}`);
}

// ---- M-9 headers ----------------------------------------------------------
{
  const cspDisabled = /contentSecurityPolicy:\s*false/.test(app);
  const perms = /Permissions-Policy/.test(app);
  add('M-9', cspDisabled || !perms ? 'CONFIRMED' : 'NOT-REPRODUCIBLE', 'CSP disabled; no Permissions-Policy', `csp:false=${cspDisabled}; permissions-policy=${perms}`);
}

// ---- NEW: build entrypoint ------------------------------------------------
{
  const pj = JSON.parse(apiPkg || '{}');
  const start = pj.scripts?.start ?? '';
  const emitted = existsSync(path.join(repoRoot, 'api/dist/server.js'));
  const nested = existsSync(path.join(repoRoot, 'api/dist/src/server.js'));
  add(
    'NEW-1',
    start.includes('dist/server.js') && !emitted && nested ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    '"npm start" points at a path tsc never emits (rootDir "." keeps src/)',
    `start="${start}"; dist/server.js=${emitted}; dist/src/server.js=${nested}`,
  );
}

// ---- NEW: tests shipped ---------------------------------------------------
{
  const testsShipped = existsSync(path.join(repoRoot, 'api/dist/tests'));
  const seedShipped = existsSync(path.join(repoRoot, 'api/dist/prisma/seed.js'));
  add(
    'NEW-2',
    testsShipped ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'Production build emits tests and the seed script',
    `dist/tests=${testsShipped}; dist/prisma/seed.js=${seedShipped}`,
  );
}

// ---- NEW: unused deps -----------------------------------------------------
{
  const all = readDir('api/src') + readDir('api/prisma');
  const bcrypt = /from 'bcryptjs'|require\(['"]bcryptjs/.test(all);
  const multer = /from 'multer'|require\(['"]multer/.test(all);
  add(
    'NEW-3',
    !bcrypt && !multer ? 'CONFIRMED' : 'NOT-REPRODUCIBLE',
    'Declared dependencies that are never imported',
    `bcryptjs used=${bcrypt}; multer used=${multer}`,
  );
}

// ---- Report ---------------------------------------------------------------
console.log('\nPHASE 0 — audit finding confirmation\n');
console.log('ID      STATUS                      FINDING');
console.log('-'.repeat(100));
for (const r of rows) {
  console.log(`${r.id.padEnd(7)} ${r.status.padEnd(27)} ${r.finding}`);
  console.log(`        └─ ${r.evidence}`);
}
const confirmed = rows.filter((r) => r.status.startsWith('CONFIRMED') || r.status.startsWith('PARTIAL')).length;
console.log('-'.repeat(100));
console.log(`${rows.length} findings re-checked: ${confirmed} still applicable, ${rows.length - confirmed} not reproduced.\n`);