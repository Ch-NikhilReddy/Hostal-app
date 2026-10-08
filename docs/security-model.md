# Security model

What HostelMitra trusts, what it re-reads, and what it deliberately does not. Written
because several of these decisions look like bugs from a distance and are not.

Scope: the API. The Expo app and the owner/admin web dashboard are clients of it and
inherit everything below.

---

## 1. What a token authorises

The access token carries three claims:

| Claim | Meaning | Revocable mid-life? |
|---|---|---|
| `sub` | user id | no |
| `role` | `STUDENT` \| `OWNER` \| `ADMIN` | **no** |
| `ownerId` | owner profile id, OWNER accounts only | **no** |

It is a signed snapshot taken at issue time, valid for `JWT_ACCESS_TTL` (default
15 minutes). Nothing can un-sign it. Two consequences follow, and they are different
from each other.

### 1.1 `isActive` IS re-read, every request — H-2

`requireAuth` loads the caller's row and rejects the request when `isActive` is false
or the row is gone.

This was not true before. `requireAuth` verified the signature and nothing else, so
deactivating an account had **no effect** on an already-issued token:
`GET /v1/auth/me` answered `200` for a deactivated user until the token expired on its
own, and no code path could end it sooner. `requireRole` did read `isActive`, but only
on routes that also required a role — `/v1/auth/me` and all of `/v1/notifications`
used `requireAuth` alone and did no database read at all.

Cost: one indexed primary-key read per authenticated request. `requireRole` reuses the
row rather than issuing its own, so owner, admin and booking routes cost exactly what
they cost before.

`requireRole` requires `requireAuth` to have run first, and treats a missing
`req.user` as unauthenticated. A misordered middleware chain fails closed.

### 1.2 `role` is NOT re-read — accepted, documented (H-3)

`requireRole` compares against the role in the **token**, not the database.

- **Promoting** a user to ADMIN does not reach their existing token. They keep their
  current privileges until it is refreshed. Harmless — the privilege only grows for
  someone who already controls the account.
- **Demoting** or removing ADMIN does not revoke their existing token. They keep admin
  access for up to `JWT_ACCESS_TTL`. This is the real gap.

Why it is accepted:

- `JWT_ACCESS_TTL` is short by design. Fifteen minutes is the blast radius.
- Reading the role fresh on every request would mean a database read that duplicates
  the one already made, for a threat that requires the attacker to already hold a
  live admin token.
- The narrower, more common case — "we deleted this person's account" — is already
  covered by `isActive`, which is read live. Revoking a *session* is handled by
  revoking the refresh token: the next access token is never issued, and the current
  one dies within fifteen minutes.

If this ever needs to close, the change is local: compare against `req.user.role`
instead of `auth.role`. `req.user` is already loaded. The tests in
`tests/integration/session-revocation.test.ts` name this behaviour explicitly, so
closing the gap means updating those tests and this section together.

---

## 2. Owner standing is re-read, every request — H-1

An owner record carries a `verificationStatus`. Only two values may use the owner API:

| Status | Owner API | Why |
|---|---|---|
| `DRAFT` | allowed | new owner, onboarding |
| `PENDING` | allowed | submitted, awaiting review |
| `APPROVED` | allowed | good standing |
| `REJECTED` | **read-only carve-out** | see below |
| `SUSPENDED` | **403** | penalty state |

Blocking `DRAFT` or `PENDING` would lock a new owner out of `GET /verification`, which
is the one screen that tells them what to upload. Those two states are pinned open by
tests.

`REJECTED` keeps one exception: `GET /v1/owner/verification`, and only that route. It is
the **only** owner-facing endpoint that returns `rejectionReason`, and an admin cannot
reject a submission without supplying one. Blocking it made the platform's own
rejection message unreachable — the owner saw a bare `403` and could never learn what
to fix. The carve-out grants no capability (no publishing, no editing, no responding to
bookings) and still returns `canPublish: false`.

`SUSPENDED` gets no such exception. Suspending is not a document problem, so there is
nothing for the owner to read and fix; contacting support is the intended outcome.

The status is read from the database on every request, never from the token — the token
outlives a suspension by up to `JWT_ACCESS_TTL`, which is exactly the window the
vulnerability lived in.

---

## 3. CORS is fail-closed (C-1)

An origin is trusted only when `CORS_ORIGINS` names it exactly — scheme, host and port.
There is no wildcard, no subdomain suffix matching, and no reflection of whatever the
`Origin` header happened to contain. An untrusted origin gets `403` and no CORS headers.

A request with **no** `Origin` header is allowed through, with no CORS headers set.
That is not a bypass: `Origin` is absent for native clients (the Expo app's `fetch`
does not send it) and for same-origin navigation, and a non-browser client is not
subject to CORS at all. Refusing those would break the mobile app without protecting
anything a browser could exploit.

`buildCorsPolicy` refuses to start in production with an empty or wildcard list.

---

## 4. Development-only affordances

### 4.1 The OTP echo is opt-in (C-3)

`POST /v1/auth/otp/request` returned the login code in its body whenever `NODE_ENV` was
not exactly `production`. Any staging host, any typo, any missing variable was
exploitable: post a victim's phone number, read the code from the response, sign in as
them. Full account takeover with no SMS interception involved.

Now `ENABLE_DEV_OTP` defaults to **false**, unset and empty both resolve to false, and
production refuses to start with it true. When it is on, the server logs a banner that
cannot be missed.

### 4.2 Console OTP in production

`OTP_PROVIDER=console` prints codes to the log and sends nothing. Production requires
`ALLOW_CONSOLE_OTP_IN_PROD=1` as well — a deliberate override, not a default.

### 4.3 Web dashboards store tokens in `localStorage`

Accepted for this stage, with the trade-off recorded rather than hidden:

- **Risk.** Any XSS in the dashboard origin can read the token. `localStorage` is not
  isolated from injected script the way an `HttpOnly` cookie is.
- **Mitigation in place.** A strict CSP (see `M-9` in the checklist) is the control
  that actually reduces the likelihood of XSS. It is not a substitute for cookie
  isolation, and this document does not claim it is.
- **Why not migrate now.** Switching to `httpOnly` cookies means CSRF protection, a
  same-site cookie strategy, a credentialed-CORS policy that matches, and a change to
  both clients' request code. That is a project, not a patch, and doing half of it
  would be worse than not doing it.
- **When it happens.** Before any third-party script is added to the dashboard. That is
  the trigger — not today.

---

## 5. Money is never automatic

The webhook route is mounted with a **raw** body parser before `express.json()`,
because the Razorpay signature is computed over the exact bytes received.
Re-serialising the payload would make the HMAC never match and every webhook would be
rejected as untrusted.

Cancellation does not move money. The comment in `bookings.routes.ts` says why: the
money was captured to the platform, and returning it is an accounting action that must
be recorded, not a side effect of a status change.

---

## 6. Known gaps

Stated plainly so they are not mistaken for oversights.

| Gap | Consequence | Mitigation |
|---|---|---|
| Role not re-read (§1.2) | a demoted admin keeps access for ≤ `JWT_ACCESS_TTL` | short TTL; `isActive` is live |
| Tokens in `localStorage` (§4.3) | XSS can exfiltrate a session | CSP; migrate before third-party scripts |
| No rate limiting (`H-4`) | OTP and booking endpoints are abusable | deployment-level limit; see checklist |
| No admin audit trail (`H-5`) | privileged actions are not attributable | being built |
| Clock skew | a token may be judged valid slightly late | single issuer; `exp` is issuer-side |