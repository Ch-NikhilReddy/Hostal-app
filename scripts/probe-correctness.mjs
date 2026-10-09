/**
 * Live probe for the correctness findings: M-4, M-5, M-8.
 *
 *   node scripts/probe-correctness.mjs
 *
 * None of these were exploitable. All three were the system asserting something
 * untrue, which needs different evidence from a vulnerability: there is no
 * before/after status code to point at, only the words in a response and the rows
 * that should and should not exist.
 *
 * M-5 mattered most. `POST /cancel` answered `refundEligible: true` and "A refund will
 * be processed under the hostel notice policy" whenever a payment was captured, and no
 * refund code exists anywhere in the codebase. A student had no way to distinguish a
 * refund system from a promise.
 *
 * M-8: /health disclosed NODE_ENV and paymentProvider, and on failure the raw driver
 * error — connection string and all.
 *
 * SCOPE, stated plainly: this probe covers M-8 and the M-5 response shape over HTTP.
 * M-4 (the owner notification) and the paid-and-cancelled path are NOT checked here,
 * because reaching them over HTTP needs a five-step owner/payment dance that is
 * brittle to set up and easy to get wrong — an earlier version of this file skipped
 * every check while reporting success, which is worse than not checking.
 *
 * Those are covered properly in
 * api/tests/integration/cancellation-truthfulness.test.ts, which drives the real
 * routes and asserts the notification row with direct database access.
 *
 * Requires ENABLE_DEV_OTP=true. Leaves a throwaway student behind; run
 * `npm run db:residue -- --purge` afterwards.
 */
const BASE = process.env.PROBE_BASE ?? 'http://localhost:4000';
const ADMIN_PHONE = '9000000001'; // seeded platform admin

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
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  return res.body;
}

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const iso = (d) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\nCorrectness probe — M-5 and M-8 (M-4 lives in the integration test)\n`);
  console.log(`Target: ${BASE}\n`);

  // ---- M-8 ---------------------------------------------------------------
  console.log('M-8 — /health discloses nothing useful');
  const health = await api('/health');
  check('health responds', health.status === 200);
  const leaked = JSON.stringify(health.body);
  check('no NODE_ENV / env field', !/"env"|NODE_ENV/i.test(leaked), leaked);
  check('no paymentProvider field', !/paymentProvider|razorpay|mock|msg91/i.test(leaked));
  check('no driver error or connection string', !/prisma|postgres|ECONNREFUSED|password/i.test(leaked));
  check('it still answers the operational question', health.body.ok === true && health.body.db === true);

  // ---- M-5 ---------------------------------------------------------------
  console.log('\nM-5 — the API no longer promises a refund it cannot deliver');

  const checkIn = iso(new Date(Date.now() + 30 * 86_400_000));
  const checkOut = iso(new Date(Date.now() + 60 * 86_400_000));

  // The collection is `results`; `hostels` is the key inside a single hostel's detail
  // response. Reading the wrong one silently reported "no hostel available" and skipped
  // everything below it.
  const search = await api(`/v1/hostels?checkIn=${checkIn}&checkOut=${checkOut}&pageSize=10`);
  const hostel = search.body?.results?.[0];

  if (!hostel) {
    console.log(`  SKIP  no hostel returned: ${JSON.stringify(search.body).slice(0, 140)}`);
  } else {
    const roomType = hostel.roomTypes?.[0];

    if (!roomType) {
      console.log('  SKIP  the first hostel has no room types');
    } else {
      const avail = await api(
        `/v1/hostels/${hostel.slug}/availability?roomTypeId=${roomType.id}&checkIn=${checkIn}&checkOut=${checkOut}`,
      );
      const bed = avail.body?.beds?.[0];

      if (!bed) {
        console.log('  SKIP  no free bed on the first hostel');
      } else {
        const student = await signIn(phone(), 'Probe Student');
        await signIn(ADMIN_PHONE, 'Platform Admin');

        const created = await api('/v1/bookings', {
          method: 'POST',
          token: student.accessToken,
          body: {
            roomTypeId: roomType.id,
            bedId: bed.id,
            stayType: 'MONTHLY',
            checkIn,
            months: 2,
          },
        });
        check('a booking was created', created.status === 201, `-> ${created.status}`);

        if (created.status === 201) {
          const ref = created.body.bookingRef;

          // Cancelled while still PENDING_PAYMENT, which is a state every booking
          // passes through and the one a student can always cancel from.
          const cancelled = await api(`/v1/bookings/${ref}/cancel`, {
            method: 'POST',
            token: student.accessToken,
            body: { reason: 'Probe: verifying the cancellation response is truthful' },
          });

          check('cancellation succeeds', cancelled.status === 200, `-> ${cancelled.status}`);

          const body = JSON.stringify(cancelled.body);
          check('refundEligible is gone', !/refundEligible/.test(body), body.slice(0, 200));
          check(
            'no claim that a refund "will be processed"',
            !/will be processed|refund (will|is being) (processed|issued)/i.test(body),
          );
          check(
            'it reports whether money was taken',
            typeof cancelled.body.paymentTaken === 'boolean',
            `paymentTaken=${cancelled.body.paymentTaken}`,
          );
          check(
            'and does not promise an outcome',
            cancelled.body.paymentTaken === true
              ? /contact support/i.test(cancelled.body.message ?? '')
              : /no payment was taken/i.test(cancelled.body.message ?? ''),
            cancelled.body.message,
          );
          check(
            'cancellation still returns the reference and status',
            cancelled.body.bookingRef === ref && cancelled.body.status === 'CANCELLED_BY_STUDENT',
          );
        }
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CORRECTNESS CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exitCode = 1;
});