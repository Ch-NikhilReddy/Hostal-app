# Deployment

How to build, verify, ship and roll back HostelMitra. Written for the first deploy and
for the day something has gone wrong.

**Nothing here has been run against a real host.** Every command is verified locally;
the hosting target is still an open decision (§5). Treat the first deploy as the
rehearsal.

---

## 1. What gets deployed

| Component | Built by | Ships |
|---|---|---|
| API | `api/dist/` | Node process, needs Postgres and env |
| Owner/admin dashboard | `web/dist/` | Static files |
| Mobile app | not in CI | Expo, distributed separately — App Store review is its own timeline |

The API artifact is 25 files, ~187 KiB of JavaScript. Verified: no tests, no database
seed, no source maps, no raw TypeScript.

---

## 2. The build

```bash
npm ci
npm run db:generate
npm run build --workspace @hostelmitra/api
npm run build --workspace @hostelmitra/web
npm run verify-build --workspace @hostelmitra/api   # boots the artifact
```

`verify-build` is not optional ceremony. `npm run build` used to exit 0 while emitting
the server to `dist/src/server.js`, which `npm start` could not find — TypeScript
reported success, CI was green, and the deploy was broken. The verifier boots the
compiled output and asserts the shape of the artifact.

There is a Dockerfile (Phase 11) for the API image; it runs `verify-build` as part of
the build so a broken artifact cannot be produced at all.

---

## 3. Migrations on deploy

```bash
npm run db:deploy        # migrate deploy
```

Non-interactive, applies pending migrations, and fails loudly rather than guessing.

**Never `db push` or `migrate dev` against a database that matters.** Both prompt, and
both drop things when they disagree with the migrations directory.

Order matters: **migrate before starting the new code.** A migration that the running
code cannot work with is worse than no deploy, because you cannot roll the code back
without also rolling the schema back. The baseline is `0_init_baseline`; see
`docs/backup-restore.md` §4.

---

## 4. Continuous integration

`.github/workflows/ci.yml` is committed and complete, and **is not running**: this
repository has no git remote. Four jobs:

| Job | Checks | Needs Docker |
|---|---|---|
| `verify` | typecheck ×3, `migrate deploy`, 281 tests, runtime dependency audit | Postgres service |
| `build` | build, `verify-build` (boots the artifact) | Postgres service |
| `web` | dashboard build | no |
| `backup` | backup, then restore into a scratch database and compare every row count | yes |

Every step runs. There is no `continue-on-error` and no `|| true` anywhere, because a
gate that can be bypassed stops being a gate.

Two decisions worth knowing about:

- **The runtime audit is not the root audit.** `npm audit` at the root reports 61
  findings from the Expo, Metro, Babel and Jest toolchains, none reachable by a request.
  `scripts/audit-runtime.mjs` intersects `npm ls --omit=dev` with the advisory data, so
  it reports only what the container actually gets. Gating on the root number would mean
  permanent red or a suppression nobody reads.
- **The restore drill runs on every build.** A backup nobody has restored is a guess.

### Turning it on

1. Create the repository on GitHub (or wherever).
2. `git remote add origin <url>`
3. `git push -u origin remediation/production-hardening`
4. Enable Actions. The workflow runs on `main`, `master`, `remediation/**` and any pull
   request.

Nothing in the pipeline needs a secret. It uses an ephemeral Postgres service, not the
production database — deliberately, so a runaway test cannot reach real data.

---

## 5. Open decisions

Not chosen here, because each needs an account, a budget, or a person who owns the
consequence.

| Question | Why it is open |
|---|---|
| Where does this run? | A single VM, a PaaS, or Fly/Railway. Changes the Dockerfile, the process manager and the backup target. |
| Where do backups go? | Local disk dies with the host. Needs object storage and an account. |
| Who is paged when a backup fails? | A nightly job nobody hears about is not a backup. |
| TLS termination | The app is behind a proxy in every plausible target, so `trust proxy` is already set to 1. |
| Secrets storage | `JWT_SECRET`, `MSG91_AUTH_KEY`, Razorpay keys. Currently env vars, which is correct — but they need a real secret store on a real host. |
| Razorpay / MSG91 accounts | Block Phase 13 and real SMS. See the final report. |

---

## 6. Rolling back

**Application rollback is easy; schema rollback is not.**

1. Take a backup first, always, even when things look fine:
   ```bash
   node scripts/db-backup.mjs
   node scripts/db-backup.mjs --verify api/backups/<the one you just took>
   ```
2. Redeploy the previous artifact. Migrations are additive and nothing has been
   dropped, so the previous code runs against the newer schema.
3. If the data itself is wrong — not the code — restore. The procedure is in
   `docs/backup-restore.md` §3, and it deliberately has no wrapper script: the steps
   must be conscious choices.

### Why there is no automatic rollback

Because an automatic rollback that runs on a transient health-check blip will roll back
a perfectly good deploy during a brief database hiccup, and the operator will not notice
until much later. Rolling forward after understanding the failure beats rolling back
without understanding it.

---

## 7. After the deploy

- `/health` returns `{ ok, db, ... }` and is the readiness probe. It must be on the load
  balancer's health path.
- Watch the first real booking end to end, including the notification.
- Confirm OTP delivery is actually going out through MSG91 and not silently falling back
  to the console. The startup banner makes this visible, but only if someone is looking
  at the logs.

---

## 8. Running in a GitHub Codespace

Codespaces forward ports over HTTPS to a per-space hostname, and that changes two
things the local setup does not have to think about. Both fail in ways that look like
something else is broken, which is why they are written down here rather than left to be
discovered.

**1. `localhost` in a browser is not the Codespace.**

The dashboard runs in *your laptop's* browser, so `localhost:4000` there is your laptop,
not the space. After forwarding port 4000, the API lives at:

```
https://<your-codespace-name>-4000.app.github.dev
```

```bash
# web/.env.local — Vite reads this, and it is gitignored
echo "VITE_API_URL=https://$(hostname | cut -d. -f1)-4000.app.github.dev" >> web/.env.local
```

`hostname` yields the codespace name, so this does not need editing if you rename the
shell variable.

**2. The forwarded origin is not loopback, so CORS must name it explicitly.**

C-1 allows loopback in development, which is right on a laptop and wrong here: the
dashboard's origin is `https://<name>-5173.app.github.dev`, and no loopback rule covers
it.

```bash
# in the repository-root .env
CORS_ORIGINS=https://$(hostname | cut -d. -f1)-5173.app.github.dev,http://localhost:5173
```

Without this the dashboard loads and **every API call returns 403** — which reads like a
broken API rather than a browser-only origin problem.

**3. Where the env file goes.**

Use the repository-root `.env` from `.env.example`, not a partial `api/.env`.
`config.ts` loads `api/.env` first and then the root `.env`, and `process.loadEnvFile`
never overwrites a variable that is already set — so a partial `api/.env` silently wins
for the keys it contains while everything else falls back to built-in defaults. With
only `DATABASE_URL` and `JWT_SECRET` set, that leaves `CORS_ORIGINS` and
`ENABLE_DEV_OTP` unset and produces exactly the 403 above.

**4. Docker has to be enabled in the space.**

```bash
docker info >/dev/null 2>&1 && echo "docker ok" || echo "enable Docker in the Codespace"
npm run db:up && curl -s localhost:4000/health
```

Look for `{"ok":true,"db":true}`. The API starts happily without a database — the
connection is only exercised on the first request — so "the process started" proves
nothing; `db:false` is the thing to look for.

**5. The mobile app will not reach a Codespace comfortably.**

Expo needs a reachable host, and a forwarded HTTPS URL with no LAN path is awkward for
it. For mobile work run the API locally and forward the other way, or use
`npx expo start --tunnel`. The web dashboard has no such problem.
