/**
 * H-2 live probe: does deactivating an account take effect immediately?
 *
 * The defect: requireAuth verified the JWT signature and nothing else. An admin
 * setting isActive = false did nothing to an access token that had already been
 * issued, so GET /v1/auth/me answered 200 for a deactivated account until the
 * 15-minute token expired on its own. No code path could revoke a token early.
 *
 *   node scripts/probe-session-revocation.mjs
 *
 * Requires the running API to have ENABLE_DEV_OTP=true so the probe can sign in.
 * Cleans up after itself.
 */
const BASE = process.env.PROBE_BASE ?? 'http://localhost:4000';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEANUP_SCRIPT = path.join(repoRoot, 'scripts', 'cleanup-user.mjs');
const tsxCli = ['node_modules/tsx/dist/cli.mjs', 'api/node_modules/tsx/dist/cli.mjs'].find((rel) =>
  existsSync(path.join(repoRoot, rel)),
);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
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

async function signIn(phone, name) {
  const req = await api('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  if (!req.body.devOtp) throw new Error(`no devOtp — is ENABLE_DEV_OTP=true? (got ${req.status})`);
  const res = await api('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: req.body.devOtp, name },
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return { token: res.body.accessToken, userId: res.body.user.id };
}

/** Run the cleanup helper and report loudly if it failed. */
function runCleanup(userId, isActive) {
  return new Promise((resolve) => {
    const args = [tsxCli, CLEANUP_SCRIPT, userId];
    if (isActive !== null) args.push('--is-active', isActive);
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      // Surfaced rather than swallowed: a helper that fails quietly makes every
      // probe that uses it quietly wrong.
      if (code !== 0) {
        console.log(`  note: cleanup-user.mjs exited ${code}${err ? ` — ${err.split('\n')[0].trim()}` : ''}`);
      }
      resolve({ code, out: out.trim(), err });
    });
  });
}

/** Flip isActive on a throwaway user, the way an admin would, then confirm it took. */
async function setActive(userId, isActive) {
  const r = await runCleanup(userId, String(isActive));
  const applied = r.out === String(isActive);
  check(
    `harness: isActive set to ${isActive}`,
    r.code === 0 && applied,
    r.code === 0 ? `read back "${r.out}"` : r.err.split('\n')[0],
  );
  return applied;
}

/** Ten digits beginning with 9. Nine after the leading 9, not eight. */
const newPhone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

async function main() {
  console.log(`\nH-2 live probe — does deactivating an account take effect at once?\n`);
  console.log(`Target: ${BASE}\n`);

  const health = await api('/health');
  if (health.status !== 200 || health.body?.ok !== true) {
    console.log('  FAIL  API not healthy');
    process.exitCode = 1;
    return;
  }

  const { token, userId } = await signIn(newPhone(), 'H2 Probe Victim');

  try {
    const active = await api('/v1/auth/me', { token });
    check('an active account works', active.status === 200, `-> ${active.status}`);

    await setActive(userId, false);
    console.log('\nAfter isActive = false, using the SAME still-unexpired token:');

    const me = await api('/v1/auth/me', { token });
    check('GET /v1/auth/me is refused', me.status === 403, `-> ${me.status} ${me.body?.error?.code ?? ''}`);
    check('  ...and the code names the reason', me.body?.error?.code === 'ACCOUNT_DISABLED');

    // /v1/notifications uses requireAuth ALONE, which is where the old code did no
    // database read at all.
    const notif = await api('/v1/notifications', { token });
    check('GET /v1/notifications is refused', notif.status === 403, `-> ${notif.status}`);

    const read = await api('/v1/notifications/read', { method: 'POST', token, body: { ids: [] } });
    check('POST /v1/notifications/read is refused', read.status === 403, `-> ${read.status}`);

    // Public endpoints must stay public. A deactivated session must not become a
    // blanket outage.
    const publicOk = await api('/v1/hostels');
    check('public browsing is unaffected by any of this', publicOk.status === 200, `-> ${publicOk.status}`);

    console.log('\nRestoring the account:');
    await setActive(userId, true);
    const restored = await api('/v1/auth/me', { token });
    check(
      'access returns on the SAME token (decision read from the DB)',
      restored.status === 200,
      `-> ${restored.status}`,
    );

    console.log('\nDeleting the account outright:');
    const del = await signIn(newPhone(), 'H2 Probe Deleted');
    const delActive = await api('/v1/auth/me', { token: del.token });
    check('  ...it worked first', delActive.status === 200, `-> ${delActive.status}`);
    await runCleanup(del.userId, null);
    const afterDelete = await api('/v1/auth/me', { token: del.token });
    check('a token for a deleted account is 401', afterDelete.status === 401, `-> ${afterDelete.status}`);
    check('  ...with a distinct code', afterDelete.body?.error?.code === 'ACCOUNT_NOT_FOUND');
  } finally {
    await runCleanup(userId, null);
  }

  console.log(`\n${failures === 0 ? 'ALL SESSION-REVOCATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exitCode = 1;
});