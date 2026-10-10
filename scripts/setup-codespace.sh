/**
 * One-time Codespace setup.
 *
 *   bash scripts/setup-codespace.sh
 *
 * Written after someone lost time to the same two problems twice, so the knowledge is
 * here rather than in a chat log:
 *
 *   1. `localhost` in your browser is your laptop, not the Codespace. Ports are
 *      forwarded to https://<name>-4000.app.github.dev, and that is what the dashboard
 *      must call.
 *
 *   2. The forwarded dashboard origin is not loopback, so CORS must name it explicitly.
 *      Without this the dashboard loads and every API call 403s, which looks like a
 *      broken API rather than a browser-origin problem.
 *
 *   3. A partial api/.env silently wins over the root .env for the keys it contains
 *      while everything else falls back to defaults — which is how CORS_ORIGINS and
 *      ENABLE_DEV_OTP end up unset.
 *
 * Idempotent: safe to run again. Never prints a secret.
set -euo pipefail

cd "$(dirname "$0")/.."

# The Codespace hostname, e.g. "chittepu-nikhil-reddy-1234". Strips the domain.
SPACE="${CODESPACE_NAME:-$(hostname | cut -d. -f1)}"
API_ORIGIN="https://${SPACE}-4000.app.github.dev"
WEB_ORIGIN="https://${SPACE}-5173.app.github.dev"

echo
echo "  Codespace: ${SPACE}"
echo "  API:       ${API_ORIGIN}"
echo "  Dashboard: ${WEB_ORIGIN}"
echo

# ---------------------------------------------------------------------------
# 1. Repository-root .env, from the shipped example
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  echo "  .env already exists — leaving it alone."
else
  cp .env.example .env
  echo "  created .env from .env.example"
fi

# A partial api/.env takes precedence for the keys it holds, which is the trap.
if [ -f api/.env ]; then
  echo
  echo "  WARNING: api/.env exists. config.ts loads it BEFORE the root .env and never"
  echo "  overwrites what is already set, so it wins for any key it defines while the"
  echo "  rest silently fall back to defaults."
  echo "  Recommended: delete it and put everything in the root .env instead."
  echo "      rm api/.env"
fi

# ---------------------------------------------------------------------------
# 2. CORS: name the forwarded dashboard origin, keep loopback for local tooling
# ---------------------------------------------------------------------------
if grep -q '^CORS_ORIGINS=' .env 2>/dev/null; then
  current="$(grep '^CORS_ORIGINS=' .env | cut -d= -f2-)"
  case "$current" in
    *"$WEB_ORIGIN"*)
      echo "  CORS_ORIGINS already names the forwarded dashboard."
      ;;
    *)
      sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${WEB_ORIGIN},${current}|" .env
      echo "  CORS_ORIGINS += ${WEB_ORIGIN}"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 3. ENABLE_DEV_OTP, so a sign-in works with no SMS provider
# ---------------------------------------------------------------------------
# Ships empty, which is correct: a fresh clone must NOT echo login codes. This turns it
# on for a Codespace, which is a single-developer machine. It stays OFF in production —
# the server refuses to start with it true.
if grep -q '^ENABLE_DEV_OTP=$' .env 2>/dev/null; then
  sed -i 's|^ENABLE_DEV_OTP=$|ENABLE_DEV_OTP=true|' .env
  echo "  ENABLE_DEV_OTP=true (local Codespace only — never set this in production)"
fi

# ---------------------------------------------------------------------------
# 4. A JWT secret that is not the example
# ---------------------------------------------------------------------------
# 32 hex characters. Not printed, not echoed. Skipped if one is already set, because
# replacing a working secret invalidates every issued token.
if grep -q '^JWT_SECRET=$\|^JWT_SECRET=""$' .env 2>/dev/null; then
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env
  echo "  JWT_SECRET: generated a random 32-character value"
else
  echo "  JWT_SECRET: already set — left alone"
fi

# ---------------------------------------------------------------------------
# 5. Where the dashboard should send its requests
# ---------------------------------------------------------------------------
mkdir -p web
if [ -f web/.env.local ] && grep -q '^VITE_API_URL=' web/.env.local; then
  echo "  web/.env.local already sets VITE_API_URL."
else
  echo "VITE_API_URL=${API_ORIGIN}" > web/.env.local
  echo "  web/.env.local -> VITE_API_URL=${API_ORIGIN}"
fi

# ---------------------------------------------------------------------------
# 6. Database
# ---------------------------------------------------------------------------
echo
if ! docker info >/dev/null 2>&1; then
  cat <<'MSG'
  Docker is not available in this Codespace.

  Enable it: Codespaces -> Settings -> Options -> "Docker" (or "Enable Docker"), then
  reopen the Codespace. Until then there is no database and nothing works.
MSG
  exit 1
fi

npm run db:up --silent
npm run db:deploy --silent
echo "  migrations applied"

echo
echo "  Next:"
echo "    npm run api      # in one terminal"
echo "    npm run web      # in another"
echo
echo "  Forward ports 4000 and 5173 in the PORTS panel, then open ${WEB_ORIGIN}."
echo "  Verify the database is reachable:  curl -s localhost:4000/health"
echo