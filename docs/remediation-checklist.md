# Remediation checklist

Branch: `remediation/production-hardening`
Base: `03e942f` (master)
Baseline: 138 tests, 0 type errors, 26/26 probes

Status legend: `[x]` done · `[~]` in progress · `[ ]` pending

---

## PHASE 1 — CRITICAL

### C-1 CORS fail-closed
- [x] Confirmed live (attacker origin echoed + credentials)
- [x] Fixed — `api/src/lib/cors.ts`, `api/src/app.ts`
- [x] Unit tests (30) — normalisation, wildcard, exact match, subdomain, port, scheme
- [x] HTTP tests (6) — real headers, real middleware
- [x] Live probe — attacker origin `200` → **403**, no CORS headers
- [x] No-Origin regression (native clients) — **200**, no headers
- [x] Diff reviewed, committed `d035fd3`

### C-2 Duration parser
- [x] Confirmed (2 sites, `auth.routes.ts:232,300`)
- [x] Fixed — `api/src/lib/duration.ts`, 3 call sites
- [x] Unit tests (59) — `30d 12h 60m 30s 500ms invalid empty negative zero`
- [x] Integration tests (6) — JWT and DB expiry agree
- [x] Startup validation — bad TTL refuses boot
- [x] Live probe — `probe-ttl-boot.mjs` 20/20
- [x] Diff reviewed

### C-3 Explicit dev-OTP opt-in
- [x] Confirmed live (`devOtp=778616` returned)
- [x] Fixed — `ENABLE_DEV_OTP`, default false, refused in production
- [x] Matrix tests (10) — prod/staging/dev × flag
- [x] Live probe — `probe-otp.mjs` 10/10, `probe-otp-default.mjs` 4/4
- [x] `.env.example` default verified safe for a fresh clone
- [x] Diff reviewed

---

## PHASE 2 — AUTHZ / SESSION

### H-1 Suspended owner → 403
- [x] Confirmed (`POST /v1/owner/hostels` → 201 while SUSPENDED)
- [x] Fixed — `requireOwner` rejects SUSPENDED / REJECTED, read from the DB every call
- [x] Tests (14) — suspended / rejected / approved / draft / pending / student / admin
- [x] DRAFT and PENDING deliberately still allowed (blocking them deadlocks onboarding)
- [x] Live probe — `probe-owner-status.mjs` 21/21 against the running API
- [x] Diff reviewed
- [x] **§7 decision taken**: rejected owners keep read-only access to
      `GET /verification` so the admin's rejection reason stays reachable.
      One route, own record only, `canPublish` still false. Deviation from the
      original spec, deliberate, reversible in `owner.routes.ts`.

### H-2 `requireAuth` checks `isActive`
- [x] Confirmed (`/v1/auth/me` → 200 after deactivation)
- [x] Fixed — `requireAuth` reads the user row; `requireRole` reuses it (no 2nd query)
- [x] Deleted account → 401 `ACCOUNT_NOT_FOUND`; deactivated → 403 `ACCOUNT_DISABLED`
- [x] Tests (13) — auth/me, notifications, owner, booking, admin + misordered-chain guard
- [x] Live probe — `probe-session-revocation.mjs` 12/12
- [x] Diff reviewed

### H-3 Role-in-JWT semantics documented
- [x] Confirmed
- [x] Documented — `docs/security-model.md` §1.2
- [x] Tests — promotion/demotion behaviour pinned in `session-revocation.test.ts`

---

## PHASE 3 — DATABASE / RECOVERY

### M-1 Backups + tested restore
- [x] Confirmed (no tooling)
- [x] Script — `scripts/db-backup.mjs`, no secrets in source or on any command line
- [x] Retention documented — `docs/backup-restore.md`, 30 days
- [x] **Restore actually run and verified** — 15 tables, all counts match
- [x] **Verification proven to fail** on a truncated dump; live DB untouched throughout
- [x] RPO / RTO documented
- [ ] Production backup destination — **blocked, needs a decision** (see §5 of the runbook)

### M-2 Prisma migration baseline
- [x] Confirmed (no `migrations/`)
- [x] Baseline established without data loss — `migrate diff` + `resolve --applied`
- [x] `migrate status` reports up to date; row counts unchanged
- [x] Future deploys use `migrate deploy` (`db:deploy`), never `db push`
- [x] `db:deploy` verified idempotent

### M-7 Postgres not on 0.0.0.0
- [x] Confirmed
- [x] Bound to `127.0.0.1`
- [x] API still connects — `/health` → `database: up`
- [x] External access verified blocked — TCP to `172.25.160.1:5432` → `False`

---

## PHASE 4 — CI/CD

### M-3 CI
- [x] Confirmed (no `.github/`)
- [ ] install → typecheck → lint → test → security → build → audit
- [ ] Fails on test failure
- [ ] Runtime vs dev-dependency audit split

### H-6 Prisma CLI
- [x] Confirmed (`^6.3.1`, devDependency; runtime client clean)
- [ ] Upgrade evaluated
- [ ] CLI confirmed absent from production image

### NEW-1 `tsconfig.build.json`
- [x] Confirmed (`npm start` → `dist/server.js` MISSING)
- [ ] Build config added
- [ ] `npm start` verified

### NEW-2 Tests/seed excluded from artifact
- [x] Confirmed
- [ ] Excluded

### NEW-3 Drop unused deps
- [x] Confirmed (`bcryptjs`, `multer`)
- [ ] Removed

---

## PHASE 5 — ABUSE

### H-4 Rate limiting
- [x] Confirmed
- [ ] OTP · auth · search · quote · booking · admin
- [ ] Tests

### Search write path
- [x] Confirmed (`releaseExpiredHolds` on every search)
- [ ] Moved to scheduled job
- [ ] Documented

---

## PHASE 6 — GOVERNANCE

### H-5 Admin audit trail
- [x] Confirmed
- [ ] Append-only records
- [ ] Tests

---

## PHASE 7 — CORRECTNESS

### M-5 Refund truthfulness — **decision: Option B**
- [x] Confirmed (`refundEligible: true`, no implementation)
- [ ] Promise removed
- [ ] Tests

### M-4 Owner notified on cancel
- [x] Confirmed (no `notify()` in handler)
- [ ] Implemented via existing abstraction
- [ ] Tests

### M-6 OTP / token retention
- [x] Confirmed (1,600 rows, ~596/hour from probing)
- [ ] Cleanup job
- [ ] Retention documented
- [ ] Tests

---

## PHASE 8 — HEADERS / HEALTH

### M-8 Sanitize `/health`
- [x] Confirmed (leaks `env`, `paymentProvider`)
- [ ] Fixed
- [ ] Tests

### M-9 CSP + Permissions-Policy
- [x] Confirmed
- [ ] CSP fitted to Vite/React
- [ ] Dashboard verified after change

### M-10 Web token storage — **decision: document + CSP**
- [x] Confirmed (localStorage)
- [ ] Risk documented

### M-11 DPDP deletion / export
- [x] Confirmed
- [ ] Data lifecycle documented
- [ ] Implemented or designed

### M-12 PII minimisation
- [x] Confirmed (20 columns)
- [ ] Access restricted
- [ ] Encryption decision documented

---

## PHASE 9 — SCALABILITY (measurement-gated)
- [ ] DB-level pagination for search
- [ ] Index review
- [ ] Connection pooling
- No PostGIS/Redis/queues unless measurements justify them

---

## PHASE 10 — MONITORING
- [ ] Structured logs
- [ ] Request/correlation ID
- [ ] Error monitoring
- [ ] Backup failure alerting

---

## PHASE 11 — DEPLOYMENT
- [ ] Dockerfile
- [ ] Env validation at startup
- [ ] Health checks
- [ ] Rollback procedure

---

## PHASE 12 — MOBILE DEVICE TEST
- [ ] Physical Android device
- [ ] Auth · search · book · cancel · notifications · network failure

---

## PHASE 13 — PAYMENT READINESS
- [ ] Razorpay test keys
- [ ] Capture · webhook · replay · idempotency · failure · reconciliation
- [ ] Mock gateway impossible in production

---

## PHASE 14 — FINAL SECURITY AUDIT
- [ ] Original 26 probes re-run unchanged
- [ ] Regression probes for every fixed finding
- [ ] Booking concurrency re-verified
- [ ] Webhook forgery/replay re-verified