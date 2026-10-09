# Data protection (DPDP Act 2023)

What HostelMitra holds about a person, why, and how it should be removed or exported.

**Status: designed and documented, not implemented.** The endpoints below do not exist.
This document is the specification they should be built to, and the decisions behind
them. Building them is Phase 8 of `docs/remediation-checklist.md`.

---

## 1. What is actually personal data

Not everything with a name in it is personal data under the DPDP Act. This
distinction matters, because acting on it wrongly either misses real obligations or
builds a data-export feature nobody needs.

| Category | Examples | Is it personal data? |
|---|---|---|
| **Account** | phone, name, email, avatar, college | **Yes** |
| **Booking** | who stayed where, for how long, paid how much | **Yes** — it is a record of a person's movements and accommodation |
| **Owner** | legal name, business name, contact phone, documents | **Yes**, and the documents are the most sensitive thing in the system |
| **Auth** | OTP code hashes, attempt counts, refresh tokens | **Yes** where linked to a phone; expired ones are deleted on a timer (M-6) |
| **Notifications** | titles and bodies | **Yes** — they describe a person's bookings |
| **Public listing** | hostel name, address, photos, room types, prices | **No** — a business publishes these deliberately |
| **Derived** | distance to your college, search history | **Yes** for search history; the distance is computed on the fly and not stored |

Two consequences worth being explicit about:

1. **A booking is personal data.** "Which hostel was this person in, and when" is a
   record of accommodation. It is also the data a platform is judged on protecting.
2. **Search history is personal data and is currently not stored at all.** That is a
   design accident rather than a decision — search parameters are not persisted, so
   there is nothing to export or delete. Worth deciding deliberately rather than
   leaving to chance.

---

## 2. Retention

| Data | Retained | Why | Enforced by |
|---|---|---|---|
| Account while active | until deletion | the service cannot function without it | — |
| Deactivated account | 30 days | a mistaken deactivation is recoverable | **not yet built** |
| OTP codes | 24 hours | useless once expired; keeping them is pure liability | `lib/retention.ts`, hourly |
| Refresh tokens | 30 days past expiry | allows "was this session compromised?" investigation | `lib/retention.ts`, hourly |
| Bookings and payments | **indefinitely** | financial records; deleting these would break reconciliation and, for tax purposes, is not permitted | — |
| Owner verification documents | **indefinitely** | the basis for approving an owner; an approval with no evidence behind it is worthless | — |
| Notifications | **indefinitely** | should be pruned; no job exists | **not built** |
| Admin audit trail | **indefinitely** | evidence; the database trigger forbids deletion | `admin_audit_log` trigger |

The two rows marked *not built* are real gaps, not oversights:
- **No scheduled erasure of a deleted account.** If an admin sets `isActive = false`,
  the row and all its PII stay forever.
- **Notifications are never pruned.** They are the largest unbounded PII table in the
  system and nothing removes them.

Both are small additions to `lib/retention.ts` and should be treated as part of this
work rather than as separate nice-to-haves.

---

## 3. Erasure (the "right to be forgotten" path)

### What must be erasable

The account identifier, the profile, the credentials, the push tokens, the
notifications.

### What cannot be erased, and why

Stating this up front is better than discovering it during implementation:

| Retained | Legal/operational reason |
|---|---|
| Bookings and payments | financial records. Erasing them would make revenue figures and tax returns wrong, and would destroy the platform's ability to settle a commission dispute |
| Owner verification documents | the evidence behind an approval |
| Admin audit trail | evidence of who did what; the database trigger forbids deletion by design |
| Aggregate, de-identified figures | a booking total with no name attached is not personal data |

The correct answer is therefore **erasure with exceptions, not erasure**. The account
row is deleted; the financial and evidential records remain, unreferenced to any
identifiable person where that can be achieved without breaking the record.

### Proposed endpoint

```
DELETE /v1/auth/me
```

Requires a **recent re-authentication**, not just a valid session token. This matters:
without it, a stolen token becomes a permanent account-deletion capability, which is a
far more attractive target than read access.

Response:

```json
{
  "ok": true,
  "erased": ["account", "profile", "push_tokens", "notifications"],
  "retained": [
    { "what": "bookings and payments", "why": "financial record" },
    { "what": "verification documents", "why": "evidence for the approval decision" }
  ],
  "scheduledFor": "<ISO date 30 days out>"
}
```

Telling the user exactly what was kept and why is the difference between complying and
appearing to comply.

### The blocking problem

A `User` row is referenced by bookings, owner profiles, audit entries and more, so it
**cannot simply be deleted**. Today it is `onDelete: Cascade` from the children that
have a cascade and `Restrict` on those that do not. An implementation must decide, per
relation:

- **Cascade** where the child is meaningless without the account (notifications,
  push tokens, OTP codes)
- **Null the reference** where the child is meaningful alone (audit trail → `actorId`
  becomes null, `actorPhone` remains, which is exactly why that column is denormalised)
- **Retain with a pseudonymised link** where finance requires the link

This is a schema change and a migration. It is not a one-afternoon endpoint.

---

## 4. Access and portability

```
GET /v1/auth/me/export
```

Returns everything held about the authenticated user as JSON: account, bookings,
payments, owner profile and documents, notifications.

Same authentication requirement as erasure. Same re-authentication rule — an export is
a concentrated, high-value disclosure.

Documents need a decision: a signed URL valid for a few minutes, or base64 inline. A
signed URL is better (it does not route every document through the API process), and
the storage driver already distinguishes local from S3.

---

## 5. Consent and notice

Not yet implemented anywhere, and it is the piece most often skipped.

- A **privacy notice** at signup, covering what is collected, why, and how long.
- **Purpose limitation in practice:** the only lawful purposes today are providing the
  booking service and operating the platform. Data collected for those purposes must not
  be reused for marketing, and there is no marketing code — which should stay true.
- **No consent for separately-stored PII.** Collection for the service is not
  "consent" and should not be presented as such.

---

## 6. Security obligations around this data

The DPDP Act's security obligations are the part with teeth, and most are already
addressed elsewhere in this repository:

| Obligation | Status |
|---|---|
| Prevent unauthorised access | `requireAuth` re-reads `isActive` on every request (H-2) |
| Restrict access by role | owner status re-read per request (H-1); role from a verified token (H-3) |
| Encrypt in transit | **not yet** — no deployment target, so no TLS story. Blocked on B5 |
| Encrypt at rest | **not done** — see `docs/security-model.md`; PII columns are plain text |
| Log access to personal data | admin actions are now audited (H-5); *read* access is not |
| Erasure | **not built** — this document is the specification |
| Breach notification | **not built** — needs an owner and a contact address |

**Encryption at rest is the largest genuine gap in this document.** 20 columns of PII
sit in plain text, and a stolen database dump is a complete customer list. The
free-tier options are PostgreSQL disk encryption at the host level (cheap, coarse) or
column-level encryption for the highest-value columns (phone, email, documents). The
decision needs a threat model, not a preference, and it is listed in
`PROJECT-STATUS.md`.

---

## 7. What to build, in order

1. **Retention job for notifications and deactivated accounts.** Small, and closes two
   real gaps.
2. **Owner document URLs need expiry.** Any document URL currently handed out is
   permanent.
3. **Erasure endpoint** — requires the per-relation decisions in §3 and a migration.
4. **Export endpoint** — easier than erasure, since it only reads.
5. **Privacy notice at signup** — a document, not engineering.
6. **Breach-notification runbook** — needs a named owner.

Steps 1 and 2 are engineering. Step 5 is a document. Steps 3 and 4 need the schema
decision. Step 6 needs a person.