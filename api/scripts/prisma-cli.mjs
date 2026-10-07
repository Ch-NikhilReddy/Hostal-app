/**
 * Prisma CLI wrapper.
 *
 * Why this exists: this repo keeps a single `.env` at the repository root, because
 * Docker Compose, the API runtime and the web dashboard all need the same
 * values. Prisma, however, only looks for `.env` in the schema's own directory
 * and the current working directory — and it runs from `api/`. Copying the file
 * into `api/.env` would create a second source of truth that silently drifts,
 * which is the kind of thing that only fails in production.
 *
 * So instead: load the root `.env` into this process, then exec the real Prisma
 * CLI with the environment already populated.
 *
 * Usage: node scripts/prisma-cli.mjs db push
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '..');

// api/.env wins if it exists, so a developer can keep a local-only override there.
for (const candidate of [path.join(apiDir, '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch (err) {
      console.error(`[prisma-cli] failed to load ${candidate}:`, err.message);
      process.exit(1);
    }
    break;
  }
}

let cliEntry;
try {
  const pkgPath = require.resolve('prisma/package.json');
  const pkgDir = path.dirname(pkgPath);
  const bin = require(pkgPath).bin ?? {};
  const relative = typeof bin === 'string' ? bin : bin.prisma;
  cliEntry = path.join(pkgDir, relative);
} catch (err) {
  console.error('[prisma-cli] could not locate the Prisma CLI. Run `npm install` first.');
  console.error(err.message);
  process.exit(1);
}

const args = process.argv.slice(2);
const child = spawn(process.execPath, [cliEntry, ...args], {
  stdio: 'inherit',
  cwd: apiDir,
  env: process.env,
});

child.on('error', (err) => {
  console.error('[prisma-cli] failed to start:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});