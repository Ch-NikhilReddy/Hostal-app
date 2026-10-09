# HostelMitra — project status

Last updated: 9 October 2026
Branch: `remediation/production-hardening`

**Read this first:** 47 of 63 tasks done. Seven remaining items are **blocked on a
human decision or an account** — they cannot be finished by writing code, and they are
the only things standing between this and production. They are listed in §4.

---

## 1. Numbers

| | Count |
|---|---|
| Total tasks tracked | **63** |
| Done and verified | **47** |
| In progress | **2** |
| Blocked on a decision / account / hardware | **7** |
| Not started | **7** |
| Security findings in the original audit | **21** |
| Security findings now fixed | **10** |
| Tests at baseline (MVP) | 138 |
| Tests now | **294** (13 new files' worth) |
| Original security probes | 26/26 still passing |

---

## 2. Done and verified

Each was reproduced first, fixed, and re-verified against the running system.

| ID | Finding | Evidence |
|---|---|---|
| C-1 | CORS reflected any origin | attacker origin `200`→`403`; native no-Origin `200` |
| C-2 | Token TTL discarded its unit | one parser, 5 units; `probe-ttl-boot.mjs` 20/20 |
| C-3 | OTP echoed in the response body | `probe-otp.mjs` 10/10, `probe-otp-default.mjs` 4/4 |
| H-1 | Suspended owner could still act | `probe-owner-status.mjs` 21/21 |
| H-2 | Deactivated account kept working | `probe-session-revocation.mjs` 12/12 |
| H-3 | Role-in-JWT semantics | written up in `docs/security-model.md` §1.2 |
| M-1 | No backups | backup → restore → **15 tables, counts match** |
| M-2 | No migration history | `migrate deploy` on a fresh DB → 281/281 tests |
| M-7 | Postgres on 0.0.0.0 | API connects; LAN `:5432` refused |
| H-6 | Prisma CLI advisory | pinned `6.12.0`; runtime tree audit = **0 advisories** |
| NEW-1 | `npm start` broken | `verify-build.mjs` boots the artifact |
| NEW-2 | Tests + seed shipped | artifact = 25 files, 187 KiB, clean |
| NEW-3 | `bcryptjs`, `multer` unused | removed, 18 packages gone |
| M-3 | No CI | `ci.yml` committed; **not running** (no git remote) |
| H-4 | No rate limiting | implemented, 13 tests — *being committed* |
| — | Search write path | moved off the read path to a timer |

---

## 3. In progress

| Task | State | Remaining |
|---|---|---|
| **H-4 rate limiting** | code + 13 tests done | re-run the full suite, then commit |
| **Search write path** | moved to `lib/holdReaper.ts` | document the backstop interval |

---

## 4. Blocked — needs you, not code

These are the real critical path. Everything else is polish.

| # | Blocked item | What I need from you |
|---|---|---|
| **B1** | **Razorpay test keys** | Create a test-mode account. Phase 13 is completely stuck without it: capture, webhook signature, replay, idempotency cannot be verified against a mock, because a mock proves nothing about the real gateway. |
| **B2** | **MSG91 auth key + sender ID** | Without it, `OTP_PROVIDER=console` means **no real SMS is ever sent**. The login flow has never been exercised end-to-end on a real phone. |
| **B3** | **Production backup destination** | Local disk dies with the host. Needs object storage — your GitHub Student Pack covers this. |
| **B4** | **Who gets paged when a backup fails** | A nightly job nobody hears about is not a backup. |
| **B5** | **Where the app is hosted** | Decides the Dockerfile target, the process manager, and whether the container-based backup script is even the right tool. |
| **B6** | **A git remote** | CI is written and correct but has never executed once. |
| **B7** | **A physical Android phone** | Phase 12. I cannot install an APK or read a push notification. |

**On credentials:** if B1–B3 need keys, you create them in your own browser and put
them in your local `.env` (gitignored) or your platform's secret store. Do not paste
them into a chat.

---

## 5. Not started

| ID | Task | Why it matters |
|---|---|---|
| H-5 | Admin audit trail | privileged actions are currently unattributable |
| M-4 | Owner not notified on cancel | a booking vanishes and nobody tells the owner |
| M-5 | `refundEligible: true` with no refund code | **the API promises something it does not do** |
| M-6 | OTP/token retention | 4,626 OTP rows and growing |
| M-8 | `/health` leaks `env` + `paymentProvider` | minor info leak |
| M-9 | No CSP | this is the actual mitigation for M-10 |
| M-10 | Tokens in `localStorage` | XSS can steal a session |
| M-11 | DPDP deletion / export | a legal requirement in India |
| M-12 | PII minimisation | 20 PII columns, unrestricted |

### Suggested order
`M-9` → `M-8` → `M-5` → `M-6` → `M-4` → `H-5` → `M-11` → `M-12` → `M-10`

Rationale: **M-5 first among the code work** because it is the only remaining item where
the system is actively lying to a user. **M-9 before M-10** because the CSP is what
makes localStorage tokens defensible; doing them in the other order means writing a
risk note about a problem you could have fixed. `H-5` is the biggest build.

---

## 6. Verification you can run yourself

```bash
npm run db:up                  # Docker must be running
npm run db:deploy              # migrations up to date
npm test                       # full suite
npm run verify-build --workspace @hostelmitra/api
node scripts/audit-runtime.mjs # runtime dependency tree

npm run api                    # then, against the live API:
node scripts/security-probe.mjs            # the original 26
node scripts/probe-owner-status.mjs        # H-1
node scripts/probe-session-revocation.mjs  # H-2
node scripts/probe-otp.mjs                 # C-3
node scripts/db:backup
node scripts/db-residue.mjs                # what the probes left behind
```

---

## 7. Known gaps, stated plainly

Not bugs — accepted trade-offs with the reasoning written down.

| Gap | Consequence | Why accepted |
|---|---|---|
| Rate limits are per-process | N replicas = N× the limit | run one process, or edge-limit, before scaling out |
| Role not re-read per request | a demoted admin keeps access ≤ 15 min | `isActive` *is* live; short TTL; documented in `security-model.md` |
| Web tokens in `localStorage` | XSS can steal a session | CSP is the mitigation; migrate before any third-party script |
| Rejected owners can read `/verification` | they learn *why* they were rejected | one read-only route, own record, no capability granted |
| 2 suspended owners + 47 users in the dev DB | probe debris | `npm run db:reset && npm run db:seed` before demoing |

---

## 8. Where things are written down

| File | What it holds |
|---|---|
| `docs/remediation-checklist.md` | per-finding status, the authoritative tracker |
| `docs/security-model.md` | what is trusted, what is re-read, what is not |
| `docs/backup-restore.md` | backup/restore runbook, RPO/RTO, open decisions |
| `docs/deployment.md` | build, migrate, deploy, roll back |
| `docs/roadmap.md` | product roadmap (not remediation) |