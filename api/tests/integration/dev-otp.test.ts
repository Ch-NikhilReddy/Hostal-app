import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/**
 * C-3 regression: the OTP echo must be an explicit opt-in.
 *
 * The defect: `...(config.isProduction ? {} : { devOtp: code })` meant ANY
 * environment that was not exactly NODE_ENV=production returned every login code
 * in the response. A staging host, a typo in NODE_ENV, a missing variable — each
 * was a full account-takeover path.
 *
 * These tests boot the REAL API under each combination of NODE_ENV and
 * ENABLE_DEV_OTP, because the defect lived in a conditional that only exists once
 * the config module and the route are wired together. Unit-testing the boolean
 * would not have caught it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const apiDir = path.join(repoRoot, 'api');

const tsxCli = ['node_modules/tsx/dist/cli.mjs', '../node_modules/tsx/dist/cli.mjs'].find((rel) =>
  existsSync(path.join(apiDir, rel)),
);

const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;

type BootResult = { booted: boolean; body: Record<string, unknown>; output: string };

let counter = 0;
const nextPhone = () => {
  counter += 1;
  return `9${String(700000000 + counter).padStart(9, '0')}`.slice(0, 10);
};

function boot(nodeEnv: string, enableDevOtp: string | undefined): Promise<BootResult> {
  const port = PORT + (counter % 20) + 1;

  // A production boot has several independent reasons to refuse. To assert the
  // reason specific to ENABLE_DEV_OTP, the other production guards are satisfied
  // first: a real-looking SMS provider key, so OTP_PROVIDER is not the blocker.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: nodeEnv,
    CORS_ORIGINS: 'http://localhost:5173',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    JWT_SECRET: 'production-shaped-secret-at-least-32-chars',
    OTP_PROVIDER: nodeEnv === 'production' ? 'msg91' : 'console',
    MSG91_AUTH_KEY: nodeEnv === 'production' ? 'test-key-not-used' : '',
    // Undefined means the variable is absent, which is the important case:
    // absence must behave as false.
    ...(enableDevOtp === undefined ? { ENABLE_DEV_OTP: undefined } : { ENABLE_DEV_OTP: enableDevOtp }),
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli!, 'src/server.ts'], {
      cwd: apiDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));

    let settled = false;
    const finish = (booted: boolean, body: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ booted, body, output });
    };

    const deadline = Date.now() + 30_000;
    const poll = async () => {
      if (Date.now() > deadline) {
        finish(false, {});
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/auth/otp/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: nextPhone() }),
        });
        const json = (await res.json()) as Record<string, unknown>;
        finish(true, json);
        return;
      } catch {
        setTimeout(() => void poll(), 350);
      }
    };
    setTimeout(() => void poll(), 700);

    child.on('exit', () => finish(false, {}));
  });
}

describe('C-3 — OTP is never echoed unless explicitly opted in', () => {
  it('production + ENABLE_DEV_OTP=false -> boots, and echoes no OTP', async () => {
    // With the other production guards satisfied, a correct production config
    // starts normally. The assertion is on the payload, not on a refusal.
    const r = await boot('production', 'false');
    expect(r.booted).toBe(true);
    expect('devOtp' in r.body).toBe(false);
  });

  it('production + ENABLE_DEV_OTP=true -> server refuses to start', async () => {
    // The whole point of C-3. Previously this combination booted and returned
    // every login code to the public.
    const r = await boot('production', 'true');
    expect(r.booted).toBe(false);
    expect(r.output).toMatch(/ENABLE_DEV_OTP must not be true in production/);
  });

  it('production + ENABLE_DEV_OTP unset -> boots, and echoes no OTP', async () => {
    const r = await boot('production', undefined);
    expect(r.booted).toBe(true);
    expect('devOtp' in r.body).toBe(false);
  });

  it('staging + ENABLE_DEV_OTP=false -> server refuses to start', async () => {
    // Staging is not a valid NODE_ENV in this codebase (zod allows
    // development | test | production), so a host configured that way already
    // fails closed. Asserted so a future widening of that enum cannot silently
    // reopen this.
    const r = await boot('staging', 'false');
    expect(r.booted).toBe(false);
  });

  it('development + ENABLE_DEV_OTP=false -> no OTP in the response', async () => {
    const r = await boot('development', 'false');
    expect(r.booted).toBe(true);
    expect(r.body).not.toHaveProperty('devOtp');
    // The field must be absent, not null or empty: an empty string would still be
    // a usable shape change for a client.
    expect('devOtp' in r.body).toBe(false);
  });

  it('development + ENABLE_DEV_OTP unset -> no OTP in the response', async () => {
    // Absence of the variable must behave as false. This is the default path for
    // anyone who copies .env.example.
    const r = await boot('development', undefined);
    expect(r.booted).toBe(true);
    expect('devOtp' in r.body).toBe(false);
  });

  it('development + ENABLE_DEV_OTP=true -> OTP is returned', async () => {
    // The one supported case: a developer on a laptop with no SMS provider.
    const r = await boot('development', 'true');
    expect(r.booted).toBe(true);
    expect(r.body.devOtp).toMatch(/^\d{6}$/);
  });

  it('logs a loud warning whenever the echo is enabled', async () => {
    const r = await boot('development', 'true');
    expect(r.output).toMatch(/DEV OTP ECHO IS ENABLED/);
  });

  it('does NOT log the warning when the echo is off', async () => {
    const r = await boot('development', 'false');
    expect(r.output).not.toMatch(/DEV OTP ECHO IS ENABLED/);
  });
});

describe('C-3 — response shape is otherwise unchanged', () => {
  it('returns the same keys whether or not the OTP is echoed', async () => {
    // A client must not be able to distinguish the two cases from the payload
    // beyond the presence of devOtp itself.
    const off = await boot('development', 'false');
    const on = await boot('development', 'true');

    expect(off.booted && on.booted).toBe(true);
    expect(Object.keys(off.body).sort()).toEqual(['expiresInSeconds', 'ok']);
    expect(Object.keys(on.body).sort()).toEqual(['devOtp', 'expiresInSeconds', 'ok']);
    expect(off.body.ok).toBe(true);
    expect(on.body.ok).toBe(true);
  });
});

afterAll(() => {
  // No shared resources to tear down: each boot used its own port and was killed.
});