# Roadmap: MVP to Play Store launch

Ordered by what blocks what. Each step lists what it unlocks, so the sequence is
driven by dependency rather than by what looks most valuable.

The estimate assumes one full-time developer. In part-time hours, double these.

---

## Phase 1 — Make the money path real

Nothing else matters until a real student can pay real money and the money
reaches an owner.

### 1a. Razorpay checkout

Add `razorpay` keys and open the checkout sheet from
`app/app/booking/payment.tsx`. The server side is done: `RazorpayGateway` creates
orders and verifies signatures, and the webhook route is mounted with the raw body
it needs.

- Post the returned `razorpay_payment_id` + `signature` to
  `POST /v1/bookings/:ref/pay`
- Handle the case where the app is killed mid-payment — the webhook is the source
  of truth, not the client
- Enable the webhook in the Razorpay dashboard for
  `payment.captured` and `payment.failed`

**Unlocks:** real revenue.
**Watch for:** the 15-minute bed hold expiring while the student is on a slow
UPI. Show the countdown in the UI.

### 1b. Payouts to owners

The platform holds the student's money and owes the owner. This needs a
compliant split — RazorpayX or a route-to-bank arrangement — and a decision about
who bears a refund.

This is the point to talk to a CA and to read RBI's guidance on holding customer
funds. Do not improvise a wallet balance.

**Unlocks:** an owner can be paid without an engineer wiring bank transfers.

### 1c. Refunds

Cancelling records eligibility and shows a message, but does not move money.
A refund is an accounting action: it needs an audit entry, a gateway call, and a
decision about the cancellation window per property (`noticePeriodDays` is
already on the model).

**Unlocks:** students trusting the platform with a deposit.

**Estimate: 8–10 days.**

---

## Phase 2 — Launch-blocking gaps

### 2a. SMS OTP

`OTP_PROVIDER=console` logs codes to the terminal. Students will not accept that.
Needs a MSG91 account, a DLT sender registration, and an approved OTP template.

The DLT registration is a procurement task with a lead time — start it before the
code work, or you will finish the code and wait a week for the sender id.

**Estimate: 3 days of code, plus however long DLT takes (1–2 weeks).**

### 2b. Photo upload

Photos are URL strings today; owners need to upload. The storage driver already
branches between `local` and `s3`, so this is an upload endpoint plus a picker in
the owner flow.

**Estimate: 3–4 days.**

### 2c. Redis rate limiting

OTP limiting is an in-process `Map`. It resets on restart and does not coordinate
across replicas. Fine for one instance, wrong the moment there are two.

**Estimate: 1 day.**

### 2d. Error monitoring

Sentry on the API and the app. Currently an unhandled rejection only reaches a
log file. Without this, a crash in the payment path is found by a student, not by
you.

**Estimate: 1 day.**

**Phase total: ~8–10 days plus DLT lead time.**

---

## Phase 3 — Owner-side completeness

Owners cannot currently add a property without the API. That is the first thing
they will try, and the first thing they will complain about.

### 3a. Property creation

Form for hostel details, area and pincode, map pin, amenities, photos. Reuses
`POST /v1/owner/hostels`.

### 3b. Room type and bed management

Create room types with their three rate cards, then bulk-add beds by floor
(`A-01` through `A-24`). The endpoints exist
(`POST /v1/owner/hostels/:id/room-types`, `POST /v1/owner/room-types/:id/beds`).

### 3c. Bed board

Visual grid of beds coloured by state, with check-in and check-out from the bed
itself rather than from the booking list. `GET /v1/room-types/:id/beds` already
returns current and upcoming occupancy per bed.

**Estimate: 8–10 days.**

---

## Phase 4 — Maps

Distances are already computed correctly server-side; what is missing is a map to
look at.

Google Maps Platform has a free monthly allowance and significantly cheaper India
pricing, so it is affordable — but it needs billing enabled and a spend cap.
Alternatively MapLibre with OSM tiles has no per-call billing at all.

Related: college-distance display on the property form, so an owner can see which
campuses a listing is near.

**Estimate: 3–4 days** once a decision is made on the provider.

---

## Phase 5 — Play Store launch

### 5a. Privacy policy and DPDP compliance

Required for the store listing, and legally required regardless. If you collect
student ID documents for verification — which owner verification does — the
DPDP Act 2023 applies: consent, purpose limitation, retention, and a data
protection contact.

Write this before writing the store listing; the listing links to it.

**Estimate: 2–3 days, plus review by someone qualified.**

### 5b. Closed testing

New Play Console accounts must run a **closed test with at least 12 testers for 14
consecutive days** before they can publish. This is not optional and cannot be
shortened. Start recruiting testers the week you intend to submit.

**Wall-clock cost: 2 weeks minimum.**

### 5c. Store listing

Screenshots from a real device, a genuine description, and a privacy policy URL.
No placeholder screenshots — they are the most common reason a listing is rejected.

**Estimate: 2 days.**

### 5d. Crash-free soak

Run with real users for two weeks before opening the listing widely. Watch the
cancellation rate in the admin report: above ~30% it means the bed-hold window or
the owner approval step is failing people, not normal churn.

---

## Phase 6 — After launch

In rough order of value:

1. **WhatsApp notifications** — highest open rate for Indian students. Rent
   reminders, booking confirmations, owner alerts.
2. **Rent collection and reminders** — the reason PG owners stay on a platform.
   Auto-generate monthly bills, send reminders, track dues.
3. **Digital rental agreements** with e-sign. Removes a real source of disputes.
4. **Reviews and ratings.** Only once there are enough settled bookings to be
   meaningful.
5. **Owner Android app.** Owner adoption is the bottleneck on any marketplace; a
   web dashboard nobody opens does not clear beds.

---

## Explicitly out of scope for now

Not because they are bad ideas, but because each needs a business decision before
it needs code.

- **Wallet and prepaid balances.** Regulated. Requires a licence or a partner.
- **iOS.** One codebase covers it, but the Play Store is first.
- **Multi-city.** The model has a `city` column and nothing assumes Hyderabad, but
  college data and support are city-specific.
- **Auto-generated college content.** Scraping college websites is fragile and
  legally unclear. The admin panel manages this by hand, which is correct.