/**
 * Phase 14 — the final security re-verification.
 *
 *   node scripts/final-audit.mjs
 *
 * Runs every check that matters and prints one verdict. Deliberately NOT a unit test:
 * it exercises the running system and the built image, and its output is meant to be
 * read by a person deciding whether to ship, not asserted on in CI.
 *
 * What it re-checks, and why each one earns its place:
 *
 *   1. The original 26 probes, unchanged.        — regression, not improvement
 *   2. Booking concurrency.                      — the guarantee that must never break
 *   3. Every finding's regression probe.         — a fix with no probe is a hope
 *   4. Build, image, and runtime audit.           — the artifact, not the source
 *   5. Backup -> restore.                        — a backup never restored is a guess
 *   6. Security headers and CORS.                — including inside the container
 *   7. The startup guards still refuse to boot.  — they are the reason prod is safe
 *
 * Exit code is non-zero if anything regressed.
 */
import { spawnSync } from 'node:child_process';

const BASE = 'http://localhost:4000';
let failures = 0;
const results = [];

function record(area, label, ok, detail = '') {
  results.push({ area, label, ok, detail });
  if (!ok) failures += 1;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: false, ...opts });
}

function probeScript(name) {
  const r = run(process.execPath, [name], { cwd: process.cwd() });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const passed = (out.match(/\bPASS\b/g) ?? []).length;
  const failed = (out.match(/\bFAIL\b/g) ?? []).length;
  return { code: r.status, out, passed, failed };
}

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  HostelMitra — final security audit                                ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// ---- 0. is anything running? ---------------------------------------------
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.log('  The API is not running. Start it with: npm run api\n');
  console.log('  Nothing below can be verified, and reporting success anyway would be');
  console.log('  the one outcome worse than reporting nothing.\n');
  process.exit(1);
}

// ---- 1. the original probes ----------------------------------------------
{
  const r = run(process.execPath, ['scripts/security-probe.mjs']);
  const out = `${r.stdout ?? ''}`;
  const total = /Probes:\s*(\d+)/.exec(out)?.[1] ?? '?';
  const flagged = /Flagged:\s*(\d+)/.exec(out)?.[1] ?? '?';
  record('regression', `original security probes (${flagged} flagged of ${total})`, flagged === '0', `Flagged: ${flagged}`);
}

// ---- 2. booking concurrency ----------------------------------------------
// Asserted by booking-flow.test.ts, which fires several simultaneous bookings at one
// bed and requires exactly one 201 and the rest 409. It is a test rather than a probe
// because the guarantee is about transaction serialisation (SELECT ... FOR UPDATE) and
// only a real transaction proves that.
//
// The first version of this script pointed at scripts/probe-load.mjs, which is a
// LATENCY probe — it reports p50/p95 and error counts and never mentions 201 or 409. It
// failed here for entirely the wrong reason, which is a good illustration of why a
// check that looks right and measures nothing is worse than no check.
{
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // fileURLToPath, not `new URL(...).pathname`: on Windows the latter yields "/C:/..."
  // and the child process cannot find anything at that path.
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, '..');
  const apiDir = path.join(repoRoot, 'api');

  // vitest is hoisted to the workspace root, not api/node_modules, so the binary is
  // resolved from repoRoot while the working directory stays in api/ so vitest picks up
  // that workspace's config and setup file.
  const r = run(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/integration/booking-flow.test.ts'],
    { cwd: apiDir },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // ANSI stripped first: vitest colourises its summary, so the literal text is not
  // contiguous and every regex against it silently fails.
  const plain = out.replace(/\[[0-9;]*m/g, '');
  const passed = /Tests\s+(\d+)\s+passed/.exec(plain)?.[1];
  const failed = /(\d+)\s+failed/.exec(plain)?.[1] ?? '0';
  record(
    'concurrency',
    'one bed, N simultaneous bookings: exactly one winner',
    r.status === 0,
    failed === '0' && passed ? `${passed} tests passed` : `${failed} failing, count=${passed ?? 'unparsed'}`,
  );

  // The latency baseline is worth having on the record too, just not as a correctness
  // gate. Reported, not asserted.
  const load = run(process.execPath, ['scripts/probe-load.mjs']);
  const lat = /search \(browse\)\s+(.+)/.exec(`${load.stdout ?? ''}`)?.[1];
  if (lat) console.log(`  note: search latency baseline — ${lat.trim()}`);
}

// ---- 3. a regression probe per fixed finding -----------------------------
for (const [finding, script, what] of [
  ['C-1', 'scripts/probe-otp.mjs', 'OTP echo requires an opt-in'],
  ['C-2', 'scripts/probe-ttl-boot.mjs', 'token TTL units are parsed'],
  ['C-3', 'scripts/probe-otp-default.mjs', 'shipped .env.example is safe by default'],
  ['H-1', 'scripts/probe-owner-status.mjs', 'suspended/rejected owners refused'],
  ['H-2', 'scripts/probe-session-revocation.mjs', 'deactivated accounts revoked at once'],
  ['M-4/M-5/M-8', 'scripts/probe-correctness.mjs', 'truthful cancellation and health'],
]) {
  const r = probeScript(script);
  record('regression', `${finding} — ${what}`, r.failed === 0 && r.code === 0, `${r.passed} passed, ${r.failed} failed`);
}

// ---- 4. build and image ---------------------------------------------------
{
  const build = run('docker', ['build', '-f', 'api/Dockerfile', '-t', 'hostelmitra-api:audit', '.']);
  record('build', 'production image builds', build.status === 0, build.status === 0 ? 'Dockerfile' : 'build failed');

  if (build.status === 0) {
    // The tag must be passed explicitly. probe-image.mjs defaults to a different
    // image, so without this it audits whatever happens to be lying around — which
    // produced six failures that looked like regressions and were not.
    const r = run(process.execPath, ['scripts/probe-image.mjs', 'hostelmitra-api:audit']);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const passed = (out.match(/\bPASS\b/g) ?? []).length;
    const failed = (out.match(/\bFAIL\b/g) ?? []).length;
    record('build', 'image audit', failed === 0 && r.status === 0, `${passed} passed, ${failed} failed`);
    run('docker', ['rmi', '-f', 'hostelmitra-api:audit']);
  }
}

// ---- 5. backup and restore ----------------------------------------------
{
  const backup = run(process.execPath, ['scripts/db-backup.mjs']);
  record('recovery', 'backup taken', backup.status === 0);

  const listDir = 'api/backups';
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(listDir).filter((f) => f.endsWith('.dump')).sort().reverse();
  if (files.length) {
    const v = run(process.execPath, ['scripts/db-backup.mjs', '--verify', `${listDir}/${files[0]}`]);
    record('recovery', 'backup restored into a scratch database and verified', v.status === 0);
  } else {
    record('recovery', 'backup restored into a scratch database and verified', false, 'no backup file');
  }
}

// ---- 6. headers and CORS -------------------------------------------------
{
  const h = await fetch(`${BASE}/health`);
  const csp = h.headers.get('content-security-policy') ?? '';
  record('headers', 'CSP present on the API origin', csp.includes("default-src 'none'"));
  record('headers', 'frame-ancestors denies framing', csp.includes("frame-ancestors 'none'"));
  record('headers', 'X-Content-Type-Options', h.headers.get('x-content-type-options') === 'nosniff');
  record('headers', 'X-Request-Id on every response', Boolean(h.headers.get('x-request-id')));

  const attacker = await fetch(`${BASE}/v1/hostels?pageSize=1`, {
    headers: { Origin: 'https://evil.example' },
  });
  record('cors', 'untrusted origin refused', attacker.status === 403, `-> ${attacker.status}`);

  const allowlisted = await fetch(`${BASE}/v1/hostels?pageSize=1`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  record('cors', 'allowlisted origin permitted', allowlisted.status === 200, `-> ${allowlisted.status}`);

  const native = await fetch(`${BASE}/v1/hostels?pageSize=1`);
  record('cors', 'no-Origin request (native app) permitted', native.status === 200, `-> ${native.status}`);
}

// ---- 7. startup guards still refuse -------------------------------------
{
  const bad = run(process.execPath, ['scripts/probe-ttl-boot.mjs']);
  const out = `${bad.stdout ?? ''}${bad.stderr ?? ''}`;
  record('startup guards', 'invalid configuration refuses to boot', bad.status === 0 && !/FAIL/.test(out));
}

// ---- verdict --------------------------------------------------------------
const byArea = new Map();
for (const r of results) {
  if (!byArea.has(r.area)) byArea.set(r.area, []);
  byArea.get(r.area).push(r);
}

console.log('');
for (const [area, rows] of byArea) {
  console.log(`  ${area}`);
  for (const r of rows) {
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log('');
}

const total = results.length;
console.log(`  ${'-'.repeat(66)}`);
console.log(
  failures === 0
    ? `  ${total}/${total} checks passed — nothing regressed.\n`
    : `  ${total - failures}/${total} passed. ${failures} REGRESSION(S).\n`,
);

console.log(`  Still open, and not fixable by code alone:`);
console.log(`    - production hosting target, so the dashboard CSP is unapplied`);
console.log(`    - real SMS (MSG91) and real payments (Razorpay) credentials`);
console.log(`    - production backup destination and failure alerting`);
console.log(`    - a git remote, so CI has never actually run`);
console.log(`    - a physical Android device for the mobile test phase\n`);

process.exitCode = failures === 0 ? 0 : 1;