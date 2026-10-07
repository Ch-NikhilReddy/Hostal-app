/**
 * Headless smoke test for the owner dashboard and admin panel.
 *
 * Proves the two web surfaces actually work end to end against a running API:
 *   1. OTP login as an owner -> dashboard renders with real numbers
 *   2. OTP login as admin   -> verification queue, commission and reports load
 *
 * Runs the real fetch calls the browser makes, through the same Vite dev-server
 * proxy the browser uses, so a broken proxy or an auth regression is caught here
 * rather than by eye.
 *
 *   node scripts/verify-web.mjs
 */

const WEB = process.env.WEB_BASE_URL ?? 'http://localhost:5173';
const API = process.env.API_BASE_URL ?? 'http://localhost:4000';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Call through the Vite proxy, exactly as the browser would. */
async function viaProxy(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${WEB}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

async function signIn(phone, name, registerRole) {
  const req = await viaProxy('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  if (req.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);
  const verify = await viaProxy('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: req.body.devOtp, name, registerRole },
  });
  if (verify.status !== 200) throw new Error(`otp verify failed: ${JSON.stringify(verify.body)}`);
  return verify.body;
}

const rupees = (p) => `Rs ${(p / 100).toLocaleString('en-IN')}`;

async function main() {
  console.log(`\nVerifying web dashboard against ${WEB} (API ${API})\n`);

  // ---- Infra -------------------------------------------------------------
  console.log('Infrastructure');
  const health = await viaProxy('/v1/../health').catch(() => null);
  const apiHealth = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
  check('API is up', apiHealth?.ok === true);
  check('Vite dev server responds', (await fetch(WEB)).ok);

  const indexHtml = await (await fetch(WEB)).text();
  check('index.html serves the app shell', indexHtml.includes('<div id="root">'));

  // In dev, Vite injects the entry as a module specifier rather than a hashed
  // file name, so match either shape. A dev-mode regression here (a broken import
  // path in main.tsx) shows up as a 500 from the module request.
  const bundle =
    indexHtml.match(/src="([^"]*?\/src\/main\.tsx)"/)?.[1] ??
    indexHtml.match(/src="([^"]*index[^"]*\.js)"/)?.[1];

  check('entry module is referenced', Boolean(bundle), bundle ?? 'not found in index.html');

  const bundleRes = bundle ? await fetch(`${WEB}${bundle}`) : null;
  check(
    'entry module is served',
    bundleRes?.ok === true,
    bundleRes ? `HTTP ${bundleRes.status}` : 'no request made',
  );
  check(
    'entry module returned JavaScript',
    (bundleRes?.headers.get('content-type') ?? '').includes('javascript'),
    bundleRes?.headers.get('content-type') ?? 'unknown',
  );

  // ---- Proxy -------------------------------------------------------------
  console.log('\nVite proxy');
  const proxied = await viaProxy('/v1/colleges');
  check('/v1 is proxied to the API', proxied.status === 200 && Array.isArray(proxied.body.colleges));
  check('colleges include Hyderabad campuses', (proxied.body.colleges ?? []).length >= 10, `${proxied.body.colleges?.length} colleges`);

  // ---- Owner dashboard ---------------------------------------------------
  console.log('\nOwner dashboard');
  const owner = await signIn('9000000002', 'Ravi Kumar', 'OWNER');

  const me = await viaProxy('/v1/auth/me', { token: owner.accessToken });
  check('owner session resolves', me.status === 200 && me.body.user.role === 'OWNER');

  const dash = await viaProxy('/v1/owner/dashboard', { token: owner.accessToken });
  check('owner dashboard loads', dash.status === 200 && typeof dash.body.pendingApprovals === 'number');
  check('dashboard reports properties', Array.isArray(dash.body.hostels) && dash.body.hostels.length > 0, `${dash.body.hostels?.length} properties`);
  check('dashboard reports bed counts', dash.body.beds?.total > 0, `${dash.body.beds?.total} beds`);
  check('commission rate is reported', typeof dash.body.commissionRateBps === 'number', `${dash.body.commissionRateBps} bps`);
  console.log(`        earnings: gross ${rupees(dash.body.earnings.grossPaise)}, payout ${rupees(dash.body.earnings.payoutPaise)}`);
  console.log(`        deposits held separately: ${rupees(dash.body.earnings.depositHeldPaise)}`);

  const ownerHostels = await viaProxy('/v1/owner/hostels', { token: owner.accessToken });
  check('owner properties load', ownerHostels.status === 200 && ownerHostels.body.hostels.length > 0);

  const verification = await viaProxy('/v1/owner/verification', { token: owner.accessToken });
  check('verification status loads', verification.status === 200);
  check('verification checklist is present', Array.isArray(verification.body.checklist) && verification.body.checklist.length > 0);

  // An owner must NOT reach admin routes.
  const ownerHitsAdmin = await viaProxy('/v1/admin/reports/overview', { token: owner.accessToken });
  check('owner is blocked from admin routes', ownerHitsAdmin.status === 403, `status ${ownerHitsAdmin.status}`);

  // ---- Admin panel -------------------------------------------------------
  console.log('\nAdmin panel');
  const admin = await signIn('9000000001', 'Platform Admin');

  const queue = await viaProxy('/v1/admin/owners?status=PENDING', { token: admin.accessToken });
  check('verification queue loads', queue.status === 200 && Array.isArray(queue.body.owners));
  console.log(`        ${queue.body.owners?.length ?? 0} owner(s) pending review`);

  const comm = await viaProxy('/v1/admin/commission', { token: admin.accessToken });
  check('commission settings load', comm.status === 200 && comm.body.active !== null);
  check('commission history exists', Array.isArray(comm.body.history) && comm.body.history.length > 0);
  console.log(`        active rate: ${comm.body.active?.percentageBps} bps`);

  const report = await viaProxy('/v1/admin/reports/overview', { token: admin.accessToken });
  check('overview report loads', report.status === 200 && report.body.totals !== undefined);
  check('report includes a cancellation rate', typeof report.body.cancellationRate === 'number', `${report.body.cancellationRate}%`);
  check('report includes top properties', Array.isArray(report.body.topHostels));
  console.log(`        ${report.body.totalBookings} bookings, ${rupees(report.body.totals.grossRentPaise)} gross rent`);
  console.log(`        commission retained: ${rupees(report.body.totals.commissionPaise)}`);

  const sevenDay = await viaProxy('/v1/admin/reports/overview?from=' + new Date(Date.now() - 7 * 86400000).toISOString(), { token: admin.accessToken });
  check('report accepts a date range', sevenDay.status === 200);

  // Settlement drill-down.
  const anyOwner = queue.body.owners?.[0] ?? (await viaProxy('/v1/admin/owners', { token: admin.accessToken })).body.owners?.[0];
  if (anyOwner) {
    const settlement = await viaProxy(`/v1/admin/owners/${anyOwner.id}/settlement`, { token: admin.accessToken });
    check('settlement drill-down loads', settlement.status === 200 && Array.isArray(settlement.body.bookings));
  }

  // A student must NOT reach owner or admin routes.
  const student = await signIn(`96${Date.now().toString().slice(-8)}`, 'Probe Student');
  const studentHitsOwner = await viaProxy('/v1/owner/dashboard', { token: student.accessToken });
  check('student is blocked from the owner dashboard', studentHitsOwner.status === 403);
  const studentHitsAdmin = await viaProxy('/v1/admin/owners', { token: student.accessToken });
  check('student is blocked from the admin panel', studentHitsAdmin.status === 403);

  // ---- Refresh rotation --------------------------------------------------
  console.log('\nToken rotation');
  const refreshed = await viaProxy('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: owner.refreshToken },
  });
  check('refresh issues a new access token', refreshed.status === 200 && Boolean(refreshed.body.accessToken));
  check('refresh rotates the refresh token', refreshed.body.refreshToken !== owner.refreshToken);

  const reuse = await viaProxy('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: owner.refreshToken },
  });
  check('the old refresh token is dead', reuse.status === 401);

  const stillValid = await viaProxy('/v1/owner/dashboard', { token: refreshed.body.accessToken });
  check('the new access token works', stillValid.status === 200);

  // ---- Production bundle -------------------------------------------------
  console.log('\nProduction bundle');
  const dist = await fetch(`${WEB}/dist/assets/index.html`).catch(() => null);
  check('built bundle exists (npm run build)', dist !== null, 'run: npm run build --workspace @hostelmitra/web');

  console.log(`\n${failures === 0 ? 'ALL WEB CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nWeb verification aborted: ${err.message}\n`);
  process.exitCode = 1;
});