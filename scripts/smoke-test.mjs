/**
 * End-to-end smoke test against a running API.
 *
 * Drives the whole booking lifecycle with real HTTP calls and prints the money
 * figures so they can be eyeballed:
 *
 *   node scripts/smoke-test.mjs
 *
 * Requires the API on :4000 and a seeded database. Uses the mock gateway, so no
 * money moves and no Razorpay account is needed.
 */

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

const rupees = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function signIn(phone, name, registerRole) {
  const req = await api('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  if (req.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);

  const verify = await api('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code: req.body.devOtp, name, registerRole },
  });
  if (verify.status !== 200) throw new Error(`otp verify failed: ${JSON.stringify(verify.body)}`);
  return verify.body;
}

const isoDate = (offsetDays) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function main() {
  console.log(`\nHostelMitra smoke test against ${BASE}\n`);

  // ---- Health ------------------------------------------------------------
  console.log('Health');
  const health = await api('/health');
  check('API is up and the database answers', health.status === 200 && health.body.database === 'up');
  check('running on the mock gateway', health.body.paymentProvider === 'mock');

  // ---- Auth --------------------------------------------------------------
  console.log('\nAuth');
  const admin = await signIn('9000000001', 'Smoke Admin');
  check('owner/admin session obtained', Boolean(admin.accessToken));
  const student = await signIn(`98${Date.now().toString().slice(-8)}`, 'Smoke Student');
  check('student session obtained', Boolean(student.accessToken));

  const badOtp = await api('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone: '9876500000', code: '000000' },
  });
  check('a wrong OTP is rejected', badOtp.status === 400 || badOtp.status === 400);

  const noAuth = await api('/v1/auth/me');
  check('an unauthenticated request is refused', noAuth.status === 401);

  // ---- Colleges ----------------------------------------------------------
  console.log('\nColleges');
  const colleges = await api('/v1/colleges?city=Hyderabad&limit=50');
  check('colleges are listed', colleges.body.colleges?.length > 0, `${colleges.body.colleges?.length} found`);

  const ou = await api('/v1/colleges/osmania-university');
  check('a college resolves by slug', ou.status === 200 && Boolean(ou.body.college?.id));

  // ---- Search ------------------------------------------------------------
  console.log('\nSearch');
  const checkIn = isoDate(20);
  const checkOut = isoDate(110);

  const bySlug = await api(`/v1/hostels?collegeId=osmania-university&radiusKm=5&checkIn=${checkIn}&checkOut=${checkOut}`);
  check('search by college slug finds hostels', bySlug.body.total > 0, `total=${bySlug.body.total}`);
  check('the origin college is echoed back', bySlug.body.origin?.name === 'Osmania University');

  const byId = await api(`/v1/hostels?collegeId=${ou.body.college.id}&radiusKm=5&checkIn=${checkIn}&checkOut=${checkOut}`);
  check('search by college id returns the same results', byId.body.total === bySlug.body.total);

  const capped = await api(`/v1/hostels?collegeId=osmania-university&radiusKm=5&maxRent=6000&checkIn=${checkIn}&checkOut=${checkOut}`);
  check('a price filter is applied', capped.body.results.every((h) => h.minMonthlyRent <= 600000));

  const far = await api('/v1/hostels?collegeId=osmania-university&lat=28.6139&lng=77.209&radiusKm=5');
  check('a distant origin excludes nearby hostels', far.body.total === 0, `total=${far.body.total}`);

  const badCollege = await api('/v1/hostels?collegeId=does-not-exist');
  check('an unknown college returns a clear 404', badCollege.status === 404);

  // ---- Hostel detail and stay types --------------------------------------
  console.log('\nHostel detail');
  const slug = bySlug.body.results[0]?.slug;
  if (!slug) throw new Error('no hostel available to test against; run npm run db:seed');

  const detail = await api(`/v1/hostels/${slug}`);
  const roomType = detail.body.hostel.roomTypes[0];
  check('hostel detail loads', detail.status === 200 && Boolean(roomType));
  console.log(`        ${detail.body.hostel.name} — ${roomType.name}`);
  console.log(`        monthly ${rupees(roomType.monthlyRent)}, short ${rupees(roomType.shortStayDailyRent ?? 0)}/day, deposit ${rupees(roomType.depositAmount ?? 0)}`);

  const monthRoom = detail.body.hostel.roomTypes.find((rt) => rt.monthlyRent > 0);

  // ---- Quote -------------------------------------------------------------
  console.log('\nPricing (all amounts in paise; paise are integers)');
  const monthly = await api('/v1/bookings/quote', {
    method: 'POST',
    token: student.accessToken,
    body: { roomTypeId: monthRoom.id, stayType: 'MONTHLY', checkIn, months: 3 },
  });
  if (monthly.status !== 200) throw new Error(`quote failed: ${JSON.stringify(monthly.body)}`);

  const m = monthly.body.quote;
  const mAmt = m.amounts;
  const sum = mAmt.baseRent + mAmt.foodCharges + mAmt.depositAmount + mAmt.serviceFee + mAmt.taxes - mAmt.discountAmount;
  check('components sum to the total', sum === mAmt.totalAmount, `${sum} vs ${mAmt.totalAmount}`);
  check('every amount is a whole number of paise', Object.values(mAmt).every(Number.isInteger));
  check('owner payout is rent less commission', mAmt.ownerPayout === mAmt.baseRent + mAmt.foodCharges - mAmt.commissionAmount);
  check('the deposit is excluded from the owner payout', mAmt.ownerPayout < mAmt.totalAmount);
  check('check-out is after check-in', m.checkOut > m.checkIn);
  check('three months were charged', m.months === 3);
  console.log(`        3 months: rent ${rupees(mAmt.baseRent)} + deposit ${rupees(mAmt.depositAmount)} = ${rupees(mAmt.totalAmount)}`);
  console.log(`        commission ${rupees(mAmt.commissionAmount)}, owner receives ${rupees(mAmt.ownerPayout)}`);

  const short = await api('/v1/bookings/quote', {
    method: 'POST',
    token: student.accessToken,
    body: { roomTypeId: monthRoom.id, stayType: 'SHORT_STAY', checkIn, days: 5 },
  });
  if (short.status === 200) {
    check('a short stay uses its own daily rate', short.body.quote.amounts.baseRent === (monthRoom.shortStayDailyRent ?? 0) * 5);
    console.log(`        5-day short stay: ${rupees(short.body.quote.amounts.baseRent)}`);
  }

  const tooLong = await api('/v1/bookings/quote', {
    method: 'POST',
    token: student.accessToken,
    body: { roomTypeId: monthRoom.id, stayType: 'SHORT_STAY', checkIn, days: 30 },
  });
  check('a 30-day "short stay" is rejected', tooLong.status === 400 && tooLong.body.error.code === 'DAYS_OUT_OF_RANGE');

  // ---- Availability ------------------------------------------------------
  console.log('\nAvailability and booking');
  const avail = await api(`/v1/hostels/${slug}/availability?roomTypeId=${monthRoom.id}&checkIn=${checkIn}&checkOut=${checkOut}`);
  check('free beds are listed', Array.isArray(avail.body.beds) && avail.body.beds.length > 0, `${avail.body.beds?.length} free`);

  const bedId = avail.body.beds[0].id;

  const created = await api('/v1/bookings', {
    method: 'POST',
    token: student.accessToken,
    body: { roomTypeId: monthRoom.id, bedId, stayType: 'MONTHLY', checkIn, months: 3 },
  });
  if (created.status !== 201) throw new Error(`booking failed: ${JSON.stringify(created.body)}`);
  const ref = created.body.bookingRef;
  check('a booking is created and holds the bed', created.body.status === 'PENDING_PAYMENT');
  check('a public booking reference is issued', /^HM-[2-9A-HJ-NP-Z]{8}$/.test(ref), ref);
  console.log(`        booking ${ref} total ${rupees(created.body.amount)}`);

  // A second student must be refused the same bed and dates.
  const student2 = await signIn(`97${Date.now().toString().slice(-8)}`, 'Smoke Student 2');
  const clash = await api('/v1/bookings', {
    method: 'POST',
    token: student2.accessToken,
    body: { roomTypeId: monthRoom.id, bedId, stayType: 'MONTHLY', checkIn, days: undefined, months: 2 },
  });
  check('the same bed cannot be double-booked', clash.status === 409 && clash.body.error.code === 'BED_UNAVAILABLE');

  // ---- Payment -----------------------------------------------------------
  console.log('\nPayment');
  const paid = await api(`/v1/bookings/${ref}/mock-authorize`, {
    method: 'POST',
    token: admin.accessToken,
    body: { outcome: 'paid' },
  });
  check('payment capture moves the booking to PENDING_OWNER', paid.status === 200 && paid.body.status === 'PENDING_OWNER');

  const repeat = await api(`/v1/bookings/${ref}/mock-authorize`, {
    method: 'POST',
    token: admin.accessToken,
    body: { outcome: 'paid' },
  });
  check('capturing twice is idempotent', repeat.status === 200 && repeat.body.alreadyCaptured === true);

  // ---- Owner decision ----------------------------------------------------
  console.log('\nOwner decision');
  const owner = await signIn('9000000002', 'Ravi Kumar', 'OWNER');
  const ownerToken = owner.accessToken;

  const accepted = await api(`/v1/bookings/${ref}/respond`, {
    method: 'POST',
    token: ownerToken,
    body: { action: 'accept' },
  });
  check('the owner can accept', accepted.status === 200 && accepted.body.status === 'CONFIRMED');

  const lateOut = await api(`/v1/bookings/${ref}/lifecycle`, {
    method: 'POST',
    token: ownerToken,
    body: { action: 'check-out' },
  });
  check('checking out before checking in is refused', lateOut.status === 409 && lateOut.body.error.code === 'INVALID_TRANSITION');

  const checkInRes = await api(`/v1/bookings/${ref}/lifecycle`, {
    method: 'POST',
    token: ownerToken,
    body: { action: 'check-in' },
  });
  check('check-in works', checkInRes.status === 200 && checkInRes.body.status === 'CHECKED_IN');

  const checkOutRes = await api(`/v1/bookings/${ref}/lifecycle`, {
    method: 'POST',
    token: ownerToken,
    body: { action: 'check-out' },
  });
  check('check-out works and settles the deposit', checkOutRes.status === 200 && checkOutRes.body.status === 'CHECKED_OUT');

  // ---- Student's view ----------------------------------------------------
  console.log('\nStudent "My Bookings"');
  const mine = await api('/v1/bookings', { token: student.accessToken });
  check('the student sees their own bookings', mine.body.bookings?.some((b) => b.bookingRef === ref));

  const intruder = await api(`/v1/bookings/${ref}`, { token: student2.accessToken });
  check("another student cannot read someone else's booking", intruder.status === 403);

  const detailRes = await api(`/v1/bookings/${ref}`, { token: student.accessToken });
  check('the audit trail is recorded', (detailRes.body.booking.statusHistory?.length ?? 0) >= 4, `${detailRes.body.booking.statusHistory?.length} events`);
  console.log(`        history: ${detailRes.body.booking.statusHistory.map((e) => e.toStatus).join(' -> ')}`);

  // ---- Failed payment releases the bed -----------------------------------
  console.log('\nFailed payment releases the bed');
  const avail2 = await api(`/v1/hostels/${slug}/availability?roomTypeId=${monthRoom.id}&checkIn=${isoDate(150)}&checkOut=${isoDate(240)}`);
  const bed2 = avail2.body.beds[0].id;
  const doomed = await api('/v1/bookings', {
    method: 'POST',
    token: student2.accessToken,
    body: { roomTypeId: monthRoom.id, bedId: bed2, stayType: 'MONTHLY', checkIn: isoDate(150), months: 1 },
  });
  check('a second booking is created', doomed.status === 201);
  await api(`/v1/bookings/${doomed.body.bookingRef}/mock-authorize`, {
    method: 'POST',
    token: admin.accessToken,
    body: { outcome: 'failed' },
  });
  const avail3 = await api(`/v1/hostels/${slug}/availability?roomTypeId=${monthRoom.id}&checkIn=${isoDate(150)}&checkOut=${isoDate(180)}`);
  check('a declined payment frees the bed again', avail3.body.beds.some((b) => b.id === bed2));

  // ---- Commission --------------------------------------------------------
  console.log('\nCommission management');
  const comm = await api('/v1/admin/commission', { token: admin.accessToken });
  check('the active commission rate is readable', comm.status === 200 && Boolean(comm.body.active));
  console.log(`        active: ${comm.body.active?.percentageBps} bps (${comm.body.active?.percentageBps / 100}%)`);

  const before = detailRes.body.booking.commissionRateBps;
  await api('/v1/admin/commission', {
    method: 'POST',
    token: admin.accessToken,
    body: { percent: 15, label: 'Smoke test rate' },
  });
  const after = await api(`/v1/bookings/${ref}`, { token: student.accessToken });
  check('a settled booking keeps its original commission rate', after.body.booking.commissionRateBps === before, `${before} bps`);

  // Restore, so the smoke test is safe to run twice.
  await api('/v1/admin/commission', {
    method: 'POST',
    token: admin.accessToken,
    body: { percent: comm.body.active.percentageBps / 100, label: 'Restored after smoke test' },
  });

  // ---- Permissions -------------------------------------------------------
  console.log('\nPermissions');
  const ownerTriesAdmin = await api('/v1/admin/reports/overview', { token: ownerToken });
  check('an owner cannot reach admin routes', ownerTriesAdmin.status === 403);

  const studentTriesOwner = await api('/v1/owner/dashboard', { token: student.accessToken });
  check('a student cannot reach the owner dashboard', studentTriesOwner.status === 403);

  const ownerBooks = await api('/v1/bookings', {
    method: 'POST',
    token: ownerToken,
    body: { roomTypeId: monthRoom.id, bedId, stayType: 'MONTHLY', checkIn, months: 1 },
  });
  check('an owner cannot use the student booking route', ownerBooks.status === 403);

  // ---- Notifications -----------------------------------------------------
  console.log('\nNotifications');
  const notifs = await api('/v1/notifications', { token: student.accessToken });
  check('notifications are recorded', notifs.body.total > 0, `${notifs.body.total} total`);
  check('an unread count is provided', typeof notifs.body.unreadCount === 'number');

  const readAll = await api('/v1/notifications/read', { method: 'POST', token: student.accessToken, body: {} });
  check('notifications can be marked read', readAll.status === 200 && readAll.body.updated > 0);

  // ---- Reports -----------------------------------------------------------
  console.log('\nAdmin reports');
  const report = await api('/v1/admin/reports/overview', { token: admin.accessToken });
  check('the overview report renders', report.status === 200 && report.body.totals !== undefined);
  console.log(`        ${report.body.totalBookings} bookings, ${report.body.lostBookings} lost, ${report.body.cancellationRate}% cancellation`);
  console.log(`        commission retained: ${rupees(report.body.totals.commissionPaise)} on ${rupees(report.body.totals.grossRentPaise)} of rent`);

  const pendingOwners = await api('/v1/admin/owners?status=PENDING', { token: admin.accessToken });
  check('the verification queue is readable', pendingOwners.status === 200 && Array.isArray(pendingOwners.body.owners));

  // ---- Result ------------------------------------------------------------
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nSmoke test aborted: ${err.message}\n`);
  process.exitCode = 1;
});