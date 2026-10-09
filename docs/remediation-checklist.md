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
- [x] install → typecheck → test → runtime audit → build → boot artifact → restore drill
- [x] Fails on test failure — no `continue-on-error`, no `--passWithNoTests`
- [x] Runtime vs dev-dependency audit split — `scripts/audit-runtime.mjs`, exit 0
- [x] **NOT RUNNING** — the repo has no git remote. Workflow is committed complete;
      `docs/deployment.md` §4 has the four commands to activate it. No secrets needed.

### H-6 Prisma CLI
- [x] Confirmed (`^6.3.1`, devDependency; runtime client clean)
- [x] **Upgrade evaluated — and the earlier conclusion was wrong.** The advisory range
      is `6.13.0-dev.1 .. 8.1.0-dev.4`; **6.12.0 is below it**, so a *downgrade* clears
      it. npm labels the fix `isSemVerMajor: true`, which is its heuristic for any
      non-forward move, not a statement that a major upgrade is needed.
- [x] Pinned `prisma` and `@prisma/client` to `6.12.0` (must match each other)
- [x] Verified: typecheck 0 errors, 281/281 tests pass on 6.12.0
- [x] CLI absent from the production image — devDependency, and `tsconfig.build.json`
      ships only `src/`
- [x] Runtime tree audit now reports **zero** advisories

### NEW-1 `tsconfig.build.json`
- [x] Confirmed (`npm start` → `dist/server.js` MISSING)
- [x] Build config added — `api/tsconfig.build.json`
- [x] `npm start` verified — artifact boots, `/health` → 200
- [x] **`scripts/verify-build.mjs`** boots the compiled output, because a compile check
      cannot catch a build that succeeds and emits the wrong layout
- [x] Second defect found while fixing it: `rootDir`/`outDir` at the top level of a
      tsconfig are ignored (TS6258), so the first attempt at the fix changed nothing

### NEW-2 Tests/seed excluded from artifact
- [x] Confirmed — 13 test files and `prisma/seed.js` were shipped
- [x] Excluded — artifact is 25 files, 187 KiB, no tests / seed / maps / `.ts`
- [x] Asserted by `verify-build.mjs`, not just by inspection

### NEW-3 Drop unused deps
- [x] Confirmed (`bcryptjs`, `multer`)
- [x] Removed — 18 packages gone; both had zero references in `src/`, `prisma/`, `tests/`
- [x] `cors` verified **in use** by `src/lib/cors.ts` and kept

### Phase 4 side effect: broken baseline migration
- [x] `migrate deploy` failed on a fresh database — PostgreSQL error 42601
- [x] Cause: Windows PowerShell's `Out-File` wrote a UTF-8 BOM ahead of the first `--`
- [x] Migration rewritten without BOM, CRLF normalised to LF
- [x] Verified: fresh database built by `migrate deploy`, then **281/281 tests pass**

---

## PHASE 5 — ABUSE

### H-4 Rate limiting
- [x] Confirmed
- [x] Search 600/min · quote 30/min · booking 8/hour · admin 60/min · OTP per-IP 20/15min
- [x] **OTP guessing deliberately NOT duplicated** — `OtpCode.attempts` already counts
      5 per code in the *database*, which survives restart and coordinates across
      instances. An in-memory copy would be weaker and would obscure which is
      authoritative.
- [x] Per-IP SMS cap closes the real gap: the existing per-phone counter is reset by
      changing the number, which is the shape of an SMS billing attack on the operator
- [x] Tests (21) — limits, Retry-After, headers, window expiry, NAT behaviour, gate
- [x] **Two defects found by running the thing:** the cap blocked `smoke-test.mjs` on
      its 10th sign-in, and a 60/min search limit throttled a legitimate shared-network
      client. Both fixed by principle, not by exemption.
- [x] Known limitation documented: per-process counters, so N replicas = N× the limit

### Search write path
- [x] Confirmed (`releaseExpiredHolds` on every search)
- [x] Moved to a timer — `lib/holdReaper.ts`, started from `server.ts`
- [x] **Request-path backstop kept, bounded to once per 60s.** Removing it entirely
      would mean a dead timer lets every abandoned checkout shrink inventory forever.
- [x] Documented — sweep failure is logged and resets the guard rather than waiting
      out a full minute on a transient error
- [x] Skipped under `NODE_ENV=test` so a background writer cannot race the suite

---

## PHASE 6 — GOVERNANCE

### H-5 Admin audit trail
- [x] Confirmed
- [x] `AdminAuditLog` model + migration `20260101000000_admin_audit_log`
- [x] Records actor (id, phone, role), action verb, target, a human-readable summary,
      structured metadata, the **request id** and the client IP
- [x] **Append-only enforced by the database**, not by application convention — a
      `BEFORE UPDATE OR DELETE` trigger raises
- [x] **Verified in raw `psql`, not through the client**: `UPDATE` and `DELETE` both
      refused with `admin_audit_log is append-only`; 33 entries survived both attempts
- [x] No foreign key to User, deliberately — the record must outlive a deleted account
- [x] Recorded: owner verification · commission override · default commission ·
      hostel moderation
- [x] Reads are **not** recorded, on purpose — logging them would bury the entries that
      matter under a constant stream of "an admin looked at a page"
- [x] Audit failure never blocks the action; it is logged loudly including the action
      that went unrecorded. A full disk must not freeze the admin console, because the
      usual fix for that is to disable auditing.
- [x] Tests (11) — recording, actor attribution, request-id correlation, raw-SQL
      tamper attempts, and that the original text survives a failed rewrite

---

## PHASE 7 — CORRECTNESS

### M-5 Refund truthfulness — **decision: Option B**
- [x] Confirmed (`refundEligible: true`, no implementation)
- [x] Promise removed — `paymentTaken` + "contact support" instead
- [x] App client type updated, with a note not to reintroduce a refund flag
- [x] Tests (4) — paid and unpaid paths, bed released, **no phantom REFUNDED status**
- [x] Live probe — `probe-correctness.mjs` 11/11

### M-4 Owner notified on cancel
- [x] Confirmed (no `notify()` in handler)
- [x] Implemented via the existing `notify()` abstraction, **after** the transaction
      commits so a failed commit cannot leave a notification about a cancellation
      that never happened
- [x] Notification failure cannot fail the cancellation — a student must not be told
      to retry an action that already succeeded
- [x] Tests (4) — owner notified, names the reference, student is not, bed released

### M-6 OTP / token retention
- [x] Confirmed (3,701 OTP rows on a dev database that has never seen traffic)
- [x] Cleanup job — `api/src/lib/retention.ts`, hourly from `server.ts`
- [x] Retention documented — OTP **24h**, refresh tokens **30 days past expiry**
- [x] The two windows differ deliberately: deleting a refresh token early signs a real
      user out, keeping an OTP slightly long is merely untidy. When in doubt, keep more.
- [x] Sweep failure is logged, never thrown — a retention job must not shut the API down
- [x] Tests (9) — both sides of each boundary, idempotency, and that users/bookings/
      payments are never candidates
- [x] Verified on the real database: a seeded 72-hour-old code was removed, a 23-hour
      one kept

---

## PHASE 8 — HEADERS / HEALTH

### M-8 Sanitize `/health`
- [x] Confirmed (leaked `env`, `paymentProvider`)
- [x] Fixed — now `{ ok, db, uptimeSeconds }`. The 503 path also stopped returning
      `detail`, which handed out the raw Prisma driver error including the connection
      string to anyone who could reach the endpoint
- [x] Consumers updated — `verify-build.mjs`, `smoke-test.mjs`
- [x] `smoke-test.mjs` now asserts the leak is **closed**, so it fails if it returns
- [x] Live probe — `probe-correctness.mjs`

### M-9 CSP + Permissions-Policy
- [x] Confirmed
- [x] **API origin** — CSP on `app.ts`: `default-src 'none'`, `frame-ancestors 'none'`,
      `object-src 'none'`, `connect-src 'self'`. Verified in the response headers.
- [x] **Dashboard origin** — `web/nginx.conf`, fitted to a Vite/React build, each
      directive annotated with what it was stopping
- [x] **NOT DONE, and stated:** the dashboard's CSP must be set by whatever serves
      `web/dist/`, because the API does not serve that origin. The nginx config is
      ready; **it has never been applied**, because the hosting target is still
      undecided (blocked item B5). Until it is, the dashboard runs with no CSP.
- [x] `connect-src` called out as the line to get right at deploy time
- [ ] **Dashboard verified in a browser after nginx.conf is applied** — needs B5

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
- [x] Dockerfile — `api/Dockerfile`, multi-stage, `dumb-init`, unprivileged, HEALTHCHECK
- [x] **Built and run, not just written.** Three defects found only by running it:
      the unprivileged user could not create the upload directory (EACCES at boot);
      `@prisma/client` re-pulled the Prisma CLI back in as an optional peer; and
      the workspace install dragged React Native into the image.
- [x] `verify-build --shape` runs as a build step, so a broken artifact cannot be
      produced — and it prints that it skipped the boot half, and why
- [x] Health check — returns 503 when the database is unreachable
- [x] Graceful shutdown verified: SIGTERM → "Closed cleanly" (an ungraceful stop
      drops in-flight payment webhooks)
- [x] Env validation at startup — already present via the C-1/C-2/C-3 guards, and
      verified *inside the image*: `OTP_PROVIDER=console` refused to start
- [x] Rollback procedure — `docs/deployment.md` §6
- [x] `.dockerignore` — keeps `.env` and database dumps out of image layers
- [x] Image audit — `scripts/probe-image.mjs`, **17/17**

### NEW-4 API image contained the whole monorepo
- [x] **Found by measuring the built image, not by reading the Dockerfile.**
      `npm ci --omit=dev` at the workspace root resolves every workspace, so the
      runtime image was **494 MB** with React Native (83 MB), @expo (35 MB),
      TypeScript (23 MB) and the Prisma CLI (49 MB) — none imported by the API,
      all reachable from the internet
- [x] Fixed — runtime stage installs `api/package.json` as the root package
- [x] And the devDependencies are **deleted from the manifest** with `npm pkg delete`
      before install. `--omit=dev` was not enough: `@prisma/client` declares `prisma`
      as an optional peer and npm installs optional peers to satisfy them.
      `--omit=peer` did not stop it either.
- [x] Result: **494 MB → 107 MB**, and 17/17 image-audit checks pass
- [ ] **Open trade-off:** the runtime image installs without the workspace lockfile,
      so caret-ranged dependencies resolve to the newest matching version at build
      time. `@prisma/client` and `prisma` are exact-pinned and unaffected. The
      structural fix is a separate lockfile for the API, or dropping the mobile app
      out of the workspace — a repo-shape decision, not a patch.

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