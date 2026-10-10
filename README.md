# HostelMitra

Student hostel / PG booking platform for Hyderabad.

Three surfaces over one API: an **Android app** (student, with an owner view),
a **web owner dashboard**, and a **web admin panel**. Built entirely on
free-tier tools, so running the whole thing costs nothing until real users arrive.

---

## What works right now

| Requirement | Status |
| --- | --- |
| Android student app | Expo / React Native, runs on a phone today |
| Hostel / PG search and filters | rent, gender, sharing, area, amenities, meals, stay type, sort |
| College / location-based search | 15 real Hyderabad campuses, distance + travel time |
| Monthly + short stay + day stay | three independent rate cards per room type |
| Hostel details, photos, rent, deposit, amenities | full detail screen with tabs |
| Availability / bed management | per-bed inventory, real overlap detection, row locking |
| Booking and online payment | full lifecycle on a mock gateway; Razorpay adapter ready |
| Booking confirmation and notifications | in-app + FCM + SMS, with an audit trail |
| Student "My Bookings" | upcoming / past / all, with a status timeline |
| Owner dashboard | earnings, bed counts, verification checklist, booking queue |
| Admin web panel | owner verification, commission, reports, moderation |
| Hostel / owner verification | document workflow; publishing is gated on approval |
| Commission management | platform rate + per-owner override, snapshotted per booking |
| Basic reports | funnel, cancellation rate, gross rent, commission, top properties |

Not built yet, and named so they are not mistaken for done: real gateway
capture, SMS delivery, photo upload, refunds, and the Google Maps view.

---

## Prerequisites

- **Node 20+** — check with `node -v`
- **Docker Desktop** — only for the local Postgres

You do **not** need Android Studio, the Android SDK, Java or Flutter.

---

## First run

```bash
cd hostel-app
cp .env.example .env          # Windows: Copy-Item .env.example .env

npm install                   # ~5 minutes first time
npm run install-scripts approve prisma @prisma/client @prisma/engines esbuild
npm install                   # again, so the approved scripts actually run

npm run db:up                 # start Postgres 16 on :5432 and wait for healthy
npm run db:migrate            # push the schema
npm run db:seed               # Hyderabad colleges, hostels, beds, a demo booking
```

`db:seed` prints the demo accounts:

| Role | Phone | Notes |
| --- | --- | --- |
| Admin | `9000000001` | verification, commission, reports |
| Owner | `9000000002` | approved, has live properties |
| Owner | `9000000003` | pending — approve them in the admin panel |
| Student | `9876543210` | has one confirmed booking |

Start the three surfaces in three terminals:

```bash
npm run api     # http://localhost:4000
npm run web     # http://localhost:5173  (owner dashboard + admin panel)
npm run app     # Metro bundler; scan the QR with Expo Go
```

### Trying the app without a second phone

`npm run app` prints a QR code. Install **Expo Go** on an Android phone and scan
it. The app runs on a real device with no Android Studio and no build step.

To produce an installable APK or AAB, see [Building a release](#building-a-release).

---

## Testing

```bash
npm test              # 137 unit + integration tests against real Postgres
npm run test:smoke    # end-to-end HTTP walk of the whole booking lifecycle
```

With the API and web running:

```bash
node scripts/verify-web.mjs   # owner dashboard + admin panel, end to end
```

The integration suite is not mocked. It creates a hostel, books the only bed in
it from two students simultaneously, and asserts that exactly one request wins —
that test is the reason the availability engine has a `SELECT … FOR UPDATE`
lock in it.

---

## How it is put together

```
hostel-app/
├── api/          Node + Express + Prisma + PostgreSQL
│   ├── prisma/schema.prisma   the whole data model
│   ├── prisma/seed.ts         Hyderabad seed data
│   ├── src/lib/pricing.ts     all three stay types, money in paise
│   ├── src/services/
│   │   ├── availability.ts    bed locking and overlap rules
│   │   ├── payments.ts        gateway interface, mock + Razorpay
│   │   ├── commission.ts      rate resolution and settlement
│   │   └── notifications.ts   in-app + push + SMS
│   └── src/modules/           routes by domain
├── app/          Expo / React Native (student + owner)
│   ├── src/api/               typed client, one money formatter
│   ├── src/components/        design system and booking panel
│   └── app/                   expo-router screens
├── web/          React + Vite (owner dashboard + admin panel)
├── scripts/      smoke-test.mjs, verify-web.mjs
└── docker-compose.yml         Postgres 16
```

---

## Decisions worth knowing about

**Money is always integer paise.** Not rupees, not decimals. Every monetary column
in the schema, every API response, and every client formatter works in paise and
converts exactly once for display. `quotePrice` asserts that the components sum
to the total on every quote, so a mismatch fails loudly in development instead of
becoming a support ticket.

**Commission is snapshotted onto each booking.** Raising the platform rate today
does not change what an owner was paid on a booking settled last month. The rate
that produced each booking's commission is stored on the row.

**Deposits are never the owner's money.** `ownerPayout` is rent plus food less
commission. The security deposit is held separately and is refunded on checkout —
paying it to the owner would mean the platform was holding a deposit on their
behalf with no regulatory basis.

**A booking holds one specific bed for a specific window.** Availability is
derived from overlapping bookings, never from a counter that can drift. A bed
under an unpaid booking is released after 15 minutes, without needing a cron job.

**Checkout is half-open.** A stay ending on the 1st and one starting on the 1st do
not conflict, because checkout is morning and check-in is evening. An inclusive
end date would make every turn-over day unbookable.

**The gateway is an interface, not a vendor.** With no Razorpay keys configured,
an internal mock gateway runs the complete payment lifecycle — order, capture,
webhook verification, failure. Every test exercises real money logic with no
gateway account and no money.

---

## Free-tier stack

| Need | Tool | Cost |
| --- | --- | --- |
| Database | Postgres 16 (local Docker) | ₹0 |
| API hosting | any small VPS | ~$5/mo |
| App build | Expo + EAS free tier | ₹0 |
| Push notifications | Firebase Cloud Messaging | ₹0 |
| Payments | Razorpay | 2% + GST per txn |
| SMS | MSG91 | ~₹0.17/SMS + DLT setup |
| Hosting | Vercel / Cloudflare Pages (web) | ₹0 |

---

## Building a release

### Android (AAB for Play Store)

```bash
npm install -g eas-cli
cd app
eas login
eas build --platform android --profile production
```

Requires an Expo account. `app.json` already sets the package name
`com.hostelmitra.app`.

Play Store checklist that is **not** code:

- US$25 one-time developer fee
- D-U-N-S number for an organisation account
- Privacy policy URL — required, and the DPDP Act 2023 applies if you collect
  student ID documents
- **New personal accounts need 12 testers for 14 consecutive days** before they
  can publish. Budget two weeks for this.

### Deploying the API

Any Node host works. The requirements are Node 20+, a managed Postgres, and
`DATABASE_URL` pointing at it. Set `NODE_ENV=production`, generate a long random
`JWT_SECRET`, and configure `CORS_ORIGINS`.

---

## Environment variables

See `.env.example`. The ones that change behaviour:

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL` | local Postgres | required |
| `JWT_SECRET` | dev placeholder | required, and the app refuses to boot in production on the example value |
| `RAZORPAY_KEY_ID` / `_SECRET` | empty | empty means the mock gateway is used |
| `OTP_PROVIDER` | `console` | `console` prints OTPs; production refuses to boot on it without an explicit override |
| `STORAGE_DRIVER` | `local` | `local` writes photos to `var/uploads`; `s3` is stubbed |
| `DEFAULT_COMMISSION_PERCENT` | `10` | fallback when no `CommissionConfig` exists |
| `OTP_MAX_PER_WINDOW` | `3` | OTP sends per phone per 10 minutes. Only enforced when an SMS provider is configured — there are no credits to protect when codes are printed to the console |

The wrong-code attempt limit (5 per issued code) always applies, whatever the SMS
provider, because that one protects the account rather than the budget.

---

## Known gaps

These are deliberate omissions, not oversights. Each is listed so nothing here
reads as working when it does not.

- **Real payment capture.** The Razorpay adapter builds orders and verifies
  signatures, but no checkout sheet is opened. Adding keys without wiring the
  client would mark bookings paid that were never charged.
- **SMS delivery.** `OTP_PROVIDER=console` logs codes. Live SMS needs a DLT
  registration and a pre-approved template in India.
- **Photo upload.** Photos are stored as URL strings. Seed data uses placeholder
  images.
- **Refunds.** Cancellation records eligibility and returns a message. Moving
  money back is a separate, deliberate accounting step that is not implemented.
- **Google Maps.** No map view. Distance and travel time are computed server-side,
  so search results are correct, but there is no map to look at.
- **OTP send-rate limiting is in-process.** It resets on restart and does not
  coordinate across replicas, so it must move to Redis before a second instance
  runs. It is only enforced when a billed SMS provider is configured. The
  per-code wrong-attempt limit is enforced regardless.
- **Owner profile editing.** Owners can review and publish, but adding and editing
  properties is API-only in this build.

---

## Where to go next

See [docs/roadmap.md](docs/roadmap.md) for the ordered path from this MVP to a
Play Store launch, including what each step unlocks and what it costs in time."# Hostal-app" 
