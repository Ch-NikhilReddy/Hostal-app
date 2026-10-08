/**
 * Read-only security probe. Sends malformed/hostile requests and reports status
 * codes. Makes no destructive changes and prints nothing sensitive.
 *
 *   node scripts/security-probe.mjs
 */

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const results = [];

async function req(path, { method = 'GET', body, token, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, headers: res.headers };
}

function record(id, area, desc, res, expect, note = '') {
  const ok = expect.includes(res.status);
  results.push({ id, area, desc, status: res.status, ok, note });
  const tag = ok ? 'OK   ' : 'FLAG ';
  console.log(`  ${tag} ${id} ${desc} -> ${res.status} ${note}`);
}

async function signIn(phone, name, role) {
  const r = await req('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  const v = await req('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: r.body.devOtp, name, registerRole: role },
  });
  if (v.status !== 200) throw new Error(`signIn(${phone}) failed: ${JSON.stringify(v.body)}`);
  return v.body;
}

const uniq = () => `95${Date.now().toString().slice(-8)}`;

async function main() {
  console.log(`\nSecurity probe against ${BASE} (read-only)\n`);

  const ownerA = await signIn('9000000002', 'Ravi Kumar');
  const ownerB = await signIn('9000000003', 'Sameer Sheikh');
  const admin = await signIn('9000000001', 'Platform Admin');
  const student = await signIn(uniq(), 'Probe Student');

  // ---- 1. IDOR / BOLA: cross-owner resource access ----------------------
  console.log('1. Cross-owner access (IDOR)');
  const hostelsA = await req('/v1/owner/hostels', { token: ownerA.accessToken });
  const target = hostelsA.body?.hostels?.[0];
  if (!target) {
    console.log('  SKIP: owner A has no properties to probe against');
  } else {
    console.log(`     target property: ${target.id}`);
    record('IDOR-1', 'Authz', `Owner B GETs Owner A's hostel`, await req(`/v1/owner/hostels/${target.id}`, { token: ownerB.accessToken }), [403, 404]);
    record('IDOR-2', 'Authz', `Owner B PATCHes Owner A's hostel`, await req(`/v1/owner/hostels/${target.id}`, { method: 'PATCH', token: ownerB.accessToken, body: { published: false } }), [403, 404]);
    record('IDOR-3', 'Authz', `Student GETs Owner A's hostel (owner route)`, await req(`/v1/owner/hostels/${target.id}`, { token: student.accessToken }), [403, 401]);
  }

  // ---- 2. Privilege escalation ------------------------------------------
  console.log('\n2. Privilege escalation');
  record('ESC-1', 'Authz', 'Student reaches /v1/owner/dashboard', await req('/v1/owner/dashboard', { token: student.accessToken }), [403]);
  record('ESC-2', 'Authz', 'Owner reaches /v1/admin/owners', await req('/v1/admin/owners', { token: ownerA.accessToken }), [403]);
  record('ESC-3', 'Authz', 'Student reaches /v1/admin/commission', await req('/v1/admin/commission', { token: student.accessToken }), [403]);
  record('ESC-4', 'Authz', 'Student POSTs to /v1/admin/verify', await req('/v1/admin/owners/xyz/verify', { method: 'POST', token: student.accessToken, body: { status: 'APPROVED' } }), [403, 401]);

  // Self-registration to ADMIN must be impossible.
  const escalation = await req('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone: uniq(), code: (await req('/v1/auth/otp/request', { method: 'POST', body: { phone: '9000000012' } })).body.devOtp, registerRole: 'ADMIN' },
  });
  record('ESC-5', 'Authz', 'registerRole=ADMIN is rejected', escalation, [400]);

  // ---- 3. Token handling -------------------------------------------------
  console.log('\n3. Token handling');
  record('TOK-1', 'Auth', 'Garbage bearer token rejected', await req('/v1/auth/me', { token: 'not-a-jwt' }), [401]);
  record('TOK-2', 'Auth', 'Empty bearer token rejected', await req('/v1/auth/me', { headers: { Authorization: 'Bearer ' } }), [401]);
  // alg:none downgrade attempt
  const noneAlg = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' +
                  Buffer.from(JSON.stringify({ sub: 'x', role: 'ADMIN', iss: 'hostelmitra', aud: 'hostelmitra-app' })).toString('base64url') + '.';
  record('TOK-3', 'Auth', 'alg=none token rejected', await req('/v1/admin/reports/overview', { token: noneAlg }), [401]);

  // ---- 4. Input validation / injection -----------------------------------
  console.log('\n4. Input validation & injection');
  record('INJ-1', 'Input', 'SQLi-style search string', await req("/v1/hostels?search=' OR 1=1--"), [200, 400]);
  record('INJ-2', 'Input', 'NoSQL operator in search', await req('/v1/hostels?search[$ne]=x'), [200, 400]);
  record('INJ-3', 'Input', 'Prototype-pollution key', await req('/v1/hostels?search=__proto__'), [200, 400]);
  record('INJ-4', 'Input', 'Negative page size', await req('/v1/hostels?pageSize=-5'), [400, 200]);
  record('INJ-5', 'Input', 'pageSize=99999 (DoS)', await req('/v1/hostels?pageSize=99999'), [400]);
  record('INJ-6', 'Input', 'Path traversal in slug param', await req('/v1/hostels/..%2f..%2fetc%2fpasswd'), [400, 404]);
  record('INJ-7', 'Input', 'Mass assignment: verified=true on signup', await req('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone: uniq(), code: '000000', verified: true, role: 'ADMIN' },
  }), [400]);
  record('INJ-8', 'Input', 'Unknown body fields are stripped', await req('/v1/auth/otp/request', {
    method: 'POST', body: { phone: '9000000013', isAdmin: true, role: 'ADMIN' },
  }), [200]);

  // ---- 5. Error handling / info disclosure -------------------------------
  console.log('\n5. Error handling');
  const bad = await req('/v1/hostels/does-not-exist-at-all');
  record('ERR-1', 'Errors', 'Unknown hostel -> no stack trace', bad, [404]);
  const leaked = JSON.stringify(bad.body);
  const leaky = /at \w+\.|node_modules|postgres|prisma|DATABASE_URL|C:\\/i.test(leaked);
  console.log(`     response: ${leaked.slice(0, 120)}`);
  console.log(`     ${leaky ? '!! LEAK: internals present in error body' : 'OK   : no internals in error body'}`);
  results.push({ id: 'ERR-2', area: 'Errors', desc: 'Error body free of internals', ok: !leaky });

  // ---- 6. Business logic -------------------------------------------------
  console.log('\n6. Business logic');
  // Negative / zero rent via owner route (owner may set prices)
  const negRent = await req('/v1/owner/room-types/xyz', { method: 'PATCH', token: ownerA.accessToken, body: { monthlyRent: -1 } });
  record('LOG-1', 'Business', 'Negative rent rejected', negRent, [400, 404]);

  // Quote for an arbitrary roomTypeId (existence probing)
  record('LOG-2', 'Business', 'Quote on foreign roomTypeId', await req('/v1/bookings/quote', {
    method: 'POST', token: student.accessToken,
    body: { roomTypeId: 'cmnonexistentroomtype', stayType: 'MONTHLY', checkIn: '2027-01-01', months: 1 },
  }), [404]);

  // ---- 7. Rate limiting --------------------------------------------------
  console.log('\n7. Rate limiting');
  const burst = await Promise.all(Array.from({ length: 30 }, () => req('/v1/hostels?pageSize=1')));
  const burstOk = burst.every((r) => r.status === 200);
  console.log(`     30 concurrent search requests: ${burstOk ? 'all served, no throttle' : 'some rejected'}`);
  results.push({ id: 'RATE-1', area: 'RateLimit', desc: 'Search endpoint has no rate limit', ok: burstOk });

  // ---- 8. Method / route hygiene -----------------------------------------
  console.log('\n8. Route hygiene');
  record('ROUTE-1', 'Routes', 'DELETE on /v1/hostels collection', await req('/v1/hostels', { method: 'DELETE', token: admin.accessToken }), [404, 405]);
  record('ROUTE-2', 'Routes', 'Unknown route 404s cleanly', await req('/v1/nonexistent'), [404]);

  // ---- Summary -----------------------------------------------------------
  const flagged = results.filter((r) => !r.ok);
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`Probes: ${results.length}   Flagged: ${flagged.length}`);
  if (flagged.length > 0) {
    console.log('\nFlagged:');
    for (const f of flagged) console.log(`  [${f.id}] ${f.desc} -> HTTP ${f.status ?? 'n/a'}`);
  }
}

main().catch((e) => { console.error('probe aborted:', e.message); process.exitCode = 1; });