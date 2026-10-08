/**
 * Verifies the ENABLE_DEV_OTP default against the shipped .env.example.
 *
 * Runs the real config module with only the example file's values, to prove a
 * fresh clone does NOT echo login codes by default. A unit test on the boolean
 * would not catch an accidental default flip in the shipped example.
 *
 *   node scripts/probe-otp-default.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const apiDir = path.join(repoRoot, 'api');
const tsxCli = ['node_modules/tsx/dist/cli.mjs', '../node_modules/tsx/dist/cli.mjs'].find((rel) =>
  existsSync(path.join(apiDir, rel)),
);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Boot config.ts with the given ENABLE_DEV_OTP value and report the resolved flag. */
function resolveDevOtpEnabled(value, nodeEnv = 'development') {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        '-e',
        `import {config} from './src/config.ts'; console.log('FLAG:' + config.devOtpEnabled);`,
      ],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          CORS_ORIGINS: 'http://localhost:5173',
          JWT_SECRET: 'probe-secret-at-least-32-characters-long',
          DATABASE_URL: 'postgresql://hostelmitra:hostelmitra@localhost:5432/hostelmitra?schema=public',
          // The value is ALWAYS written explicitly. Passing `undefined` would make spawn drop
  // the key entirely, and config.ts then calls process.loadEnvFile, which re-reads the
  // developer's own repo-root .env — where ENABLE_DEV_OTP=true is set so the smoke
  // scripts can sign in. The "absent" row would then silently resolve to TRUE and
  // this probe would prove the opposite of its own point.
  //
  // An EMPTY value is the honest stand-in for absent: it is what .env.example ships
  // and what a line with no `=` produces. The genuinely-undefined case is covered by
  // the unit tests on boolDefault, where no .env file is in scope.
  ENABLE_DEV_OTP: value === undefined ? '' : value,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', () => {
      const m = /FLAG:(true|false)/.exec(out);
      resolve(m ? m[1] === 'true' : null);
    });
  });
}

async function main() {
  console.log('\nC-3 — the shipped .env.example must default to NOT echoing OTPs\n');

  // What a fresh clone actually gets.
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-env-'));
  const envPath = path.join(dir, '.env');
  try {
    copyFileSync(path.join(repoRoot, '.env.example'), envPath);
    const example = (await import('node:fs')).readFileSync(envPath, 'utf8');
    const line = example.split('\n').find((l) => l.startsWith('ENABLE_DEV_OTP'));

    console.log(`  .env.example contains: ${JSON.stringify(line)}`);

    // Parse it the way process.loadEnvFile would, and feed that value through.
    const raw = line === undefined ? undefined : line.slice('ENABLE_DEV_OTP='.length);

    const resolved = await resolveDevOtpEnabled(raw);
    check('a fresh clone resolves devOtpEnabled=false', resolved === false, `got ${resolved}`);

    const withTrue = await resolveDevOtpEnabled('true');
    check('explicitly setting true still works', withTrue === true);

    const withEmpty = await resolveDevOtpEnabled('');
    check('an empty value resolves to false, not true', withEmpty === false, `got ${withEmpty}`);

    const unset = await resolveDevOtpEnabled(undefined);
    check('an empty/absent value resolves to false', unset === false, `got ${unset}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'DEFAULT IS SAFE' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('probe failed:', e); process.exitCode = 1; });