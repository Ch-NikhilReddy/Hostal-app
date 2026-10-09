/**
 * NEW-4: what is actually inside the production API image?
 *
 *   node scripts/probe-image.mjs [image]
 *
 * Built and run the image, then report what is inside it. Written because "the
 * Dockerfile looks right" and "the image is minimal" are different claims, and only
 * one of them is checkable.
 *
 * What this found, and why it matters beyond disk space: because the repository is an
 * npm workspace, `npm ci --omit=dev` in the runtime stage resolves every workspace,
 * not just the API. The result was a 494 MB image containing React Native (83 MB),
 * @expo (35 MB) and TypeScript (23 MB) — none of which the API imports, and none of
 * which belongs in a container reachable from the internet. If anything achieves code
 * execution in the API, that code also reaches a JavaScript engine and a native build
 * toolchain it has no business touching.
 *
 * The security properties that ARE correct are asserted too, so a regression in them
 * is caught even while the size problem is open.
 *
 * Exit code is non-zero when a must-not-be-present package is found.
 */
import { spawnSync } from 'node:child_process';

const IMAGE = process.argv[2] ?? 'hostelmitra-api:check';
const PORT = 4011;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function inImage(sh) {
  const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', sh]);
  return (r.stdout ?? '').trim();
}

const exists = (sh) => inImage(sh) === 'yes';

console.log(`\nProduction image audit — ${IMAGE}\n`);

/** Packages with no business in a server container. */
const MUST_NOT_BE_PRESENT = [
  { pkg: 'react-native', why: 'the Expo app dependency tree — the API never imports it' },
  { pkg: 'expo', why: 'mobile build tooling' },
  { pkg: '@expo', why: 'mobile build tooling' },
  { pkg: 'typescript', why: 'a build-time compiler' },
  { pkg: 'prisma', why: 'the CLI carries an advisory with no fixed stable version (H-6)' },
  { pkg: 'vitest', why: 'test runner' },
  { pkg: 'supertest', why: 'test-only' },
];

console.log('  Security properties — must hold');
check(
  'prisma CLI is absent (H-6)',
  !exists('test -d /app/node_modules/prisma && echo yes'),
  'devDependency, kept out of the runtime stage',
);
check(
  'tests are absent from the artifact',
  !exists('test -d /app/dist/tests && echo yes'),
);
check(
  'the database seed is absent',
  !exists('test -f /app/dist/prisma/seed.js && echo yes'),
);
check(
  'no source maps',
  inImage('find /app/dist -name "*.map" | wc -l | tr -d " "') === '0',
);
check(
  'the server entry point is where npm start expects it',
  exists('test -f /app/dist/server.js && echo yes'),
);
check(
  'runs as a non-root user',
  inImage('test "$(id -u)" = "1000" && echo yes') === 'yes',
  `uid=${inImage('id -u')}`,
);

console.log('\n  NEW-4 — packages that should not be here');
for (const { pkg, why } of MUST_NOT_BE_PRESENT) {
  const present = exists(`test -d "/app/node_modules/${pkg}" && echo yes`);
  check(`${pkg} is absent`, !present, present ? why : '');
}

const size = inImage('du -sh /app/node_modules 2>/dev/null | cut -f1');
const distSize = inImage('du -sh /app/dist 2>/dev/null | cut -f1');
console.log(`\n  node_modules ${size} · dist ${distSize}`);

// ---- does it actually run? ------------------------------------------------
console.log('\n  Runtime behaviour');
const dbUrl =
  process.env.DATABASE_URL ??
  'postgresql://hostelmitra:hostelmitra@host.docker.internal:5432/hostelmitra?schema=public';

docker(['rm', '-f', 'hm-image-probe']);
docker([
  'run', '-d', '--name', 'hm-image-probe',
  '-p', `${PORT}:4000`,
  '-e', `DATABASE_URL=${dbUrl}`,
  '-e', `JWT_SECRET=${'image-probe-secret-at-least-32-chars'}`,
  '-e', 'CORS_ORIGINS=http://localhost:5173',
  '-e', 'OTP_PROVIDER=console',
  '-e', 'ALLOW_CONSOLE_OTP_IN_PROD=1',
  IMAGE,
]);

let health = null;
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    health = await res.json();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

check('the image boots and answers /health', Boolean(health?.ok), health ? JSON.stringify(health) : 'never healthy');
check('and reaches the database', health?.db === true);

if (health) {
  try {
    const hostels = await fetch(`http://127.0.0.1:${PORT}/v1/hostels?pageSize=2`);
    const body = await hostels.json();
    check('serves real traffic, not just /health', hostels.status === 200, `total=${body.total}`);
  } catch {
    check('serves real traffic, not just /health', false);
  }

  try {
    // C-1 must hold inside the image, not just in the dev server.
    const attacker = await fetch(`http://127.0.0.1:${PORT}/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    check('CORS still refuses an untrusted origin', attacker.status === 403, `-> ${attacker.status}`);
  } catch {
    check('CORS still refuses an untrusted origin', false);
  }
}

docker(['stop', '--time', '15', 'hm-image-probe']);
const logs = docker(['logs', 'hm-image-probe']).stdout ?? '';
check(
  'handles SIGTERM gracefully rather than being killed',
  /SIGTERM received/.test(logs) && /Closed cleanly/.test(logs),
  'an ungraceful stop drops in-flight payment webhooks',
);

docker(['rm', '-f', 'hm-image-probe']);

console.log(
  `\n${failures === 0 ? 'IMAGE AUDIT PASSED' : `${failures} CHECK(S) FAILED — see NEW-4`}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;