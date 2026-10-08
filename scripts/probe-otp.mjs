/**
 * C-3 live probe: is the OTP echoed in the API response?
 *
 * Boots the real server under each configuration combination and reports whether
 * the login code appears in the body. The pre-fix build answered `true` for every
 * combination except NODE_ENV=production.
 *
 *   node scripts/probe-otp.mjs
 *
 * Read-only apart from throwaway accounts under a 95xxxxxx prefix.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

let counter = 0;
const nextPhone = () => {
  counter += 1;
  return `9${String(750000000 + counter).padStart(9, '0')}`.slice(0, 10);
};

function attempt({ nodeEnv, enableDevOtp, port }) {
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: nodeEnv,
    CORS_ORIGINS: 'http://localhost:5173',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    // Satisfy the other production guards so a failure can only be about the flag.
    JWT_SECRET: 'probe-secret-at-least-32-characters-long',
    OTP_PROVIDER: nodeEnv === 'production' ? 'msg91' : 'console',
    MSG91_AUTH_KEY: nodeEnv === 'production' ? 'probe-key' : '',
    // The value is ALWAYS set explicitly, including for the "fresh clone" row.
    //
    // Omitting the variable does not simulate its absence: config.ts calls
    // process.loadEnvFile, which re-reads the developer's own repo-root .env. That
    // file carries ENABLE_DEV_OTP=true so the smoke scripts and the Expo app can
    // sign in, so an omitted key silently inherits it and this probe starts
    // asserting the opposite of what it means.
    //
    // An EMPTY value stands in for absent, and is exactly what .env.example ships
    // and what process.loadEnvFile yields for a line with no `=`.
    ENABLE_DEV_OTP: enableDevOtp === undefined ? '' : enableDevOtp,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'src/server.ts'], {
      cwd: apiDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ ...result, output });
    };

    const deadline = Date.now() + 30_000;
    const poll = async () => {
      if (Date.now() > deadline) return finish({ booted: false, body: null, phone: null });
      try {
        const phone = nextPhone();
        const res = await fetch(`http://127.0.0.1:${port}/v1/auth/otp/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });
        const body = await res.json();
        return finish({ booted: true, body, phone });
      } catch {
        setTimeout(() => void poll(), 350);
      }
    };
    setTimeout(() => void poll(), 700);

    child.on('exit', () => finish({ booted: false, body: null, phone: null }));
  });
}

async function main() {
  console.log(`\nC-3 live probe — is the login code echoed in the response?\n`);

  console.log('The pre-fix build echoed the OTP for every row marked "now absent".\n');

  const cases = [
    { label: 'development, flag empty      ', nodeEnv: 'development', enableDevOtp: undefined, wantEcho: false, wantBoot: true },
    { label: 'development, flag=false      ', nodeEnv: 'development', enableDevOtp: 'false', wantEcho: false, wantBoot: true },
    { label: 'development, flag=true       ', nodeEnv: 'development', enableDevOtp: 'true', wantEcho: true, wantBoot: true },
    { label: 'production,  flag=false      ', nodeEnv: 'production', enableDevOtp: 'false', wantEcho: false, wantBoot: true },
    { label: 'production,  flag=true       ', nodeEnv: 'production', enableDevOtp: 'true', wantEcho: false, wantBoot: false },
    { label: 'staging,     flag=true       ', nodeEnv: 'staging', enableDevOtp: 'true', wantEcho: false, wantBoot: false },
  ];

  let port = 4300;
  for (const c of cases) {
    const r = await attempt({ ...c, port: port++ });
    const echoed = r.booted && r.body ? 'devOtp' in r.body : false;

    const bootOk = r.booted === c.wantBoot;
    const echoOk = !c.wantBoot || echoed === c.wantEcho;

    check(
      c.label + ` -> boot=${r.booted}, OTP echoed=${echoed}`,
      bootOk && echoOk,
      r.booted ? '' : 'refused to start (expected for some rows)',
    );
  }

  // The headline: an attacker POSTing a victim's number must not learn the code.
  console.log('\nAttack simulation: request an OTP for a number I do not own');
  {
    const r = await attempt({ nodeEnv: 'development', enableDevOtp: undefined, port: port++ });
    if (!r.booted) {
      check('server reachable', false);
    } else {
      check('OTP for an arbitrary number is NOT in the response', !('devOtp' in r.body), JSON.stringify(r.body));
    }
  }

  console.log('\nDeveloper convenience is preserved when explicitly opted in');
  {
    const r = await attempt({ nodeEnv: 'development', enableDevOtp: 'true', port: port++ });
    const echoed = r.booted && r.body && 'devOtp' in r.body;
    check('flag=true still returns the code for local development', Boolean(echoed));
    check('and warns loudly at boot', /DEV OTP ECHO IS ENABLED/.test(r.output));
  }

  console.log(`\n${failures === 0 ? 'ALL OTP CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('probe failed:', e); process.exitCode = 1; });