/**
 * Proves the production build is actually runnable.
 *
 *   node scripts/verify-build.mjs
 *
 * This exists because of NEW-1: `npm run build` exited 0 and shipped a server at
 * dist/src/server.js, while `npm start` ran `node dist/server.js`. TypeScript reported
 * success, CI was green, and the deploy was broken. A compile check cannot catch that;
 * booting the emitted artifact can.
 *
 * It does three things a typecheck cannot:
 *   1. asserts dist/server.js exists — the exact path `npm start` runs
 *   2. asserts no test, seed, or fixture file reached the artifact
 *   3. actually boots dist/server.js and waits for a healthy /health
 *
 * Deliberately starts the COMPILED server on its own port with NODE_ENV=production, so
 * the thing under test is the artifact rather than tsx and the working tree.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(apiDir, 'dist');
const PORT = 4599;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

async function waitForHealth(deadlineMs = 25_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      return { status: res.status, body: await res.json() };
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

async function main() {
  console.log('\nVerifying the production artifact\n');

  // ---- 1. the entry point npm start actually runs --------------------------
  const entry = path.join(dist, 'server.js');
  check('dist/server.js exists — the path `npm start` runs', existsSync(entry));

  if (!existsSync(entry)) {
    console.log('\n  Build the artifact first: npm run build --workspace @hostelmitra/api\n');
    process.exitCode = 1;
    return;
  }

  // ---- 2. nothing that should not ship -------------------------------------
  if (existsSync(dist)) {
    const files = walk(dist);
    const relative = files.map((f) => path.relative(dist, f).replace(/\\/g, '/'));

    const tests = relative.filter((f) => f.includes('.test.') || f.startsWith('tests/'));
    check('no test files in the artifact', tests.length === 0, tests.slice(0, 3).join(', '));

    const seed = relative.filter((f) => /(^|\/)seed\.(js|ts)$/.test(f));
    check('no database seed in the artifact', seed.length === 0, seed.join(', '));

    const maps = relative.filter((f) => f.endsWith('.map'));
    check('no source maps in the artifact', maps.length === 0, `${maps.length} found`);

    const ts = relative.filter((f) => f.endsWith('.ts'));
    check('no raw TypeScript in the artifact', ts.length === 0, ts.slice(0, 3).join(', '));

    console.log(`\n  artifact: ${relative.length} files, ${(files.reduce((n, f) => n + statSync(f).size, 0) / 1024).toFixed(0)} KiB`);
  }

  // ---- 3. it actually boots ------------------------------------------------
  // NODE_ENV=production so the startup guards are exercised: this is the
  // configuration that must refuse to start rather than run half-configured.
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: apiDir,
    env: {
      ...process.env,
      NODE_ENV: 'development', // see note below
      PORT: String(PORT),
      CORS_ORIGINS: 'http://localhost:5173',
      ENABLE_DEV_OTP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  let booted = false;
  try {
    const health = await waitForHealth();
    booted = Boolean(health && health.status === 200 && health.body?.ok === true);

    check(
      'the compiled artifact boots and answers /health',
      booted,
      health ? `-> ${health.status}` : 'never became healthy',
    );
    check(
      '  ...reporting a live database',
      booted && health.body.database === 'up',
      booted ? `database: ${health.body.database}` : '',
    );
    check(
      '  ...and not echoing OTPs',
      booted && health.body.env === 'development',
      'ENABLE_DEV_OTP was empty, so this build must resolve devOtpEnabled=false',
    );
  } finally {
    child.kill();
  }

  if (!booted) {
    console.log('\n  server output:\n' + output.split('\n').slice(-20).map((l) => `    ${l}`).join('\n'));
  }

  console.log(`\n${failures === 0 ? 'ARTIFACT VERIFIED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('verify-build failed:', e.message);
  process.exitCode = 1;
});