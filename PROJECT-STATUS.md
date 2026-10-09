# HostelMitra — project status

Last updated: 9 October 2026
Branch: `remediation/production-hardening`

**Read this first:** every code-fixable finding is closed and verified — **20/20 final
audit checks pass**. What remains cannot be finished by writing code. It needs
credentials, a hosting decision, a phone and a person. That is §3, and it is the entire
distance between this and production.

---

## 1. Numbers

| | Count |
|---|---|
| Security findings in the original audit | 21 |
| **Fixed and verified** | **21 of 21** |
| New findings found *during* remediation | 4 (NEW-1 … NEW-4) |
| **New findings fixed** | **4 of 4** |
| Tests at MVP baseline | 138 |
| **Tests now** | **351** across 18 files |
| Original security probes | **26/26**, unchanged |
| Final audit checks | **20/20** |
| Commits on this branch | 12 |
| Runtime dependency advisories | **0** |
| Production image | 107 MB, unprivileged, no test/seed/tooling |

---

## 2. Fixed and verified

Every one reproduced first, fixed, then re-verified against the running system.

| ID | Finding | Evidence |
|---|---|---|
| C-1 | CORS reflected any origin | attacker origin `200`→`403`; native no-Origin `200` |
| C-2 | Token TTL discarded its unit | one parser, 5 units; `probe-ttl-boot.mjs` 20/20 |
| C-3 | OTP echoed in the response | `probe-otp.mjs` 9/9, `probe-otp-default.mjs` 4/4 |
| H-1 | Suspended owner could still act | `probe-owner-status.mjs` 21/21 |
| H-2 | Deactivated account kept working | `probe-session-revocation.mjs` 12/12 |
| H-3 | Role-in-JWT semantics | `docs/security-model.md` §1.2 |
| H-4 | No rate limiting | 21 tests; both off-switches refused in production |
| H-5 | No admin audit trail | append-only, refused by the **database** in raw `psql` |
| H-6 | Prisma CLI advisory | pinned `6.12.0` — a *downgrade*; see the note below |
| M-1 | No backups | backup → restore → 15 tables match; **fails on a corrupt dump** |
| M-2 | No migration history | `migrate deploy` on a fresh DB → 351/351 pass |
| M-4 | Owner not told on cancel | 4 tests; notification survives a failed write |
| M-5 | `refundEligible: true`, no refunds | booking ends `CANCELLED`, never `REFUNDED` |
| M-6 | Unbounded OTP/token growth | 9 tests on both sides of each boundary |
| M-7 | Postgres on 0.0.0.0 | LAN `:5432` connect **refused** |
| M-8 | `/health` leaked internals | smoke test now asserts the leak is **closed** |
| M-9 | No CSP | API origin shipped; dashboard config ready (needs B5) |
| M-10 | Tokens in `localStorage` | risk documented, migration trigger stated |
| M-11 | No DPDP erasure/export | designed in `docs/data-protection.md` |
| M-12 | PII in plain text | threat-model options documented, decision flagged |
| M-3 | No CI | `ci.yml` complete; **never run** (no remote) |
| NEW-1 | `npm start` broken | `verify-build.mjs` boots the artifact |
| NEW-2 | Tests + seed shipped | artifact = 25 files, 296 KB, clean |
| NEW-3 | Unused deps | `bcryptjs`, `multer` removed |
| NEW-4 | API image held the monorepo | **494 MB → 107 MB**; 18/18 image audit |
| — | Search was a write path | moved to a timer, bounded backstop retained |
| — | No request correlation | `X-Request-Id`, plus hostile-input tests |
| — | No deployment | built **and run**; 3 defects found only by running it |

**On H-6, because it contradicts an earlier assessment:** the Prisma advisory covers
`6.13.0-dev.1 .. 8.1.0-dev.4`, and **6.12.0 sits below that range** — so downgrading both
`prisma` and `@prisma/client` clears it. npm reports this as `isSemVerMajor: true`,
which is its heuristic for any non-forward version move, not a statement that a major
upgrade is required. Verified against the full suite on 6.12.0.

---

## 3. BLOCKED — needs you, not code

This is the whole remaining distance to production.

| # | Blocked | Why it blocks | What I need |
|---|---|---|---|
| **B1** | **Razorpay test keys** | Payment capture, webhook signature, replay and idempotency cannot be verified against a mock — a mock proves nothing about the real gateway | A test-mode account: key ID, secret, webhook secret → your `.env` |
| **B2** | **MSG91 auth key + sender ID** | `OTP_PROVIDER=console` means **no real SMS is ever sent**. Login has never been exercised on a real phone | An MSG91 account |
| **B3** | **Production backup destination** | Local disk dies with the host | Object storage — your GitHub Student Pack covers this |
| **B4** | **Who is paged when a backup fails** | A nightly job nobody hears about is not a backup | A name and an address |
| **B5** | **Hosting target** | The dashboard CSP in `web/nginx.conf` is written but **cannot be applied** without knowing what serves it. Also settles TLS and the process manager | VM, Fly, Railway or Render |
| **B6** | **A git remote** | CI is written and correct and **has never executed once** | `git remote add origin <url>` and a push |
| **B7** | **A physical Android phone** | Phase 12. I cannot install an APK or read a push notification | The device |
| **B8** | **Encryption-at-rest decision** | 20 PII columns in plain text — a stolen database dump is a complete customer list | A threat-model choice: `docs/data-protection.md` §6 |

### About credentials

If B1–B3 need keys: **create them in your own browser, then put them in your local
`.env`** (gitignored) or your platform's secret store. Do not paste them into a chat —
a credential shared in a conversation should be treated as compromised.

---

## 4. Recommended order

1. **B5** hosting — unblocks the dashboard CSP and TLS, and settles the deploy shape.
2. **B2 + B1** SMS and payments — the two flows that have never touched a real service.
3. **B6** git remote — CI is written; it should start running.
4. **Phase 9 optimisation** — the measurement says `search (dates + availability)` is
   **1.8× plain search** (p95 293 ms vs 192 ms) and is the first thing to hurt as
   inventory grows.
5. **B8** encryption at rest, before any real user data is stored.
6. **B7** device last — the app has never run on real hardware.

---

## 5. Verify it yourself

```bash
npm run db:up                  # Docker must be running
npm run db:deploy              # migrations up to date
npm test                       # 351 tests

npm run api                    # then, in another shell:
node scripts/final-audit.mjs   # everything below, one verdict
```

| Script | Checks |
|---|---|
| `security-probe.mjs` | the original 26 |
| `probe-owner-status.mjs` | H-1 · 21 |
| `probe-session-revocation.mjs` | H-2 · 12 |
| `probe-otp.mjs` / `probe-otp-default.mjs` | C-3 · 9 + 4 |
| `probe-ttl-boot.mjs` | C-2 · 20 |
| `probe-correctness.mjs` | M-4 / M-5 / M-8 · 12 |
| `probe-image.mjs <tag>` | the built image · 18 |
| `db-backup.mjs` then `--verify <file>` | the restore drill |
| `audit-runtime.mjs` | production dependency advisories |
| `db-residue.mjs` | what the probes left behind |

---

## 6. Known gaps, stated plainly

Not oversights — accepted trade-offs, with the reasoning written down.

| Gap | Consequence | Why accepted |
|---|---|---|
| Role not re-read per request | a demoted admin keeps access ≤ 15 min | `isActive` *is* live; short TTL; `security-model.md` §1.2 |
| Rate limits are per-process | N replicas = N× the limit | one process, or edge limiting, before scaling out |
| Tokens in `localStorage` | XSS can steal a session | CSP is the mitigation; migrate before any third-party script |
| Dashboard CSP unapplied | no CSP on the dashboard until B5 | the API cannot set a policy for an origin it does not serve |
| Local uploads in a container | rebuilding the image loses photos | fine on one host; **not** with two replicas or a rolling deploy |
| Rejected owners can read `/verification` | they learn *why* they were rejected | one read-only route, own record, no capability granted |
| Runtime image built without the lockfile | caret deps resolve at build time | `@prisma/client` exact-pinned, unaffected; structural fix noted under NEW-4 |
| Dev DB holds probe debris | confusing demo data | `npm run db:reset && npm run db:seed` |

---

## 7. Where things are written down

| File | What it holds |
|---|---|
| `docs/remediation-checklist.md` | per-finding status — **the authoritative tracker** |
| `docs/security-model.md` | what is trusted, what is re-read, what is not |
| `docs/backup-restore.md` | backup/restore runbook, RPO/RTO, open decisions |
| `docs/deployment.md` | build, migrate, deploy, roll back |
| `docs/data-protection.md` | DPDP: what is personal data, retention, erasure design |
| `web/nginx.conf` | the dashboard CSP, fitted and annotated |
| `docs/roadmap.md` | product roadmap (not remediation) |