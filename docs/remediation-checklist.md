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
- [ ] Fixed
- [ ] Tests — active / suspended / rejected / inactive / student / admin
- [ ] Live probe
- [ ] Diff reviewed

### H-2 `requireAuth` checks `isActive`
- [x] Confirmed (`/v1/auth/me` → 200 after deactivation)
- [ ] Fixed
- [ ] Tests
- [ ] Live probe
- [ ] Diff reviewed

### H-3 Role-in-JWT semantics documented
- [x] Confirmed
- [ ] Documented
- [ ] Tests

---

## PHASE 3 — DATABASE / RECOVERY

### M-1 Backups + tested restore
- [x] Confirmed (no tooling)
- [ ] Script (no secrets in source)
- [ ] Retention documented
- [ ] **Restore actually run and verified**
- [ ] RPO / RTO documented

### M-2 Prisma migration baseline
- [x] Confirmed (no `migrations/`)
- [ ] Baseline established without data loss
- [ ] Future deploys use `migrate deploy`

### M-7 Postgres not on 0.0.0.0
- [x] Confirmed
- [ ] Bound to `127.0.0.1`
- [ ] API still connects
- [ ] External access verified blocked

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