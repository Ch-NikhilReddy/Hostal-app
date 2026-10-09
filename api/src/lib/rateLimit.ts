import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { AppError } from './errors.js';

/**
 * Fixed-window rate limiting, per key, in process memory.
 *
 * WHY IN MEMORY, AND WHAT THAT COSTS.
 *
 * The free tier has no Redis, so a shared counter store is not available. An in-process
 * map is the honest choice: it works today, it has no infrastructure, and it is correct
 * for a single API process. The limitation is stated rather than hidden — with N
 * processes behind a load balancer, the effective limit is N times the configured one,
 * because each process counts independently. That is a real weakening and it is why the
 * deployment notes say to run one process, or to put a rate limiter at the edge, before
 * scaling out. See docs/deployment.md.
 *
 * WHY A FIXED WINDOW AND NOT A SLIDING ONE.
 *
 * A fixed window lets a caller send `limit` requests at the end of one window and
 * `limit` again immediately at the start of the next — double the intended rate in a
 * moment. For OTP issuance that is exactly the burst an attacker wants. The window is
 * therefore short relative to the limit on the auth routes, which makes the doubling
 * worth at most one extra burst, and the per-key limits below are set so that even that
 * burst cannot meaningfully help. A sliding window or token bucket would be tighter,
 * at the cost of more state per key; the trade is recorded rather than hidden.
 *
 * Keys are derived per route family so that a flood on search cannot exhaust the OTP
 * budget and vice versa.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Buckets are swept on an interval rather than on every request.
 *
 * Without this the map grows without bound: every distinct key ever seen is retained
 * until the process restarts. An unauthenticated caller can mint unlimited keys simply
 * by varying a header, so this is a memory-exhaustion vector, not a theoretical leak.
 */
const SWEEP_MS = 60_000;
let sweepTimer: NodeJS.Timeout | undefined;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function ensureSweeper(): void {
  if (sweepTimer) return;
  // unref so the timer alone never keeps the process alive, and so tests are not left
  // with an open handle.
  sweepTimer = setInterval(() => sweep(Date.now()), SWEEP_MS);
  sweepTimer.unref?.();
}

/** Test seam. Not used by application code. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Whether rate limiting may be switched off at all.
 *
 * Three ways to disable it, and the reasoning differs for each:
 *
 *   NODE_ENV=test        The suite shares one in-process counter map, and 351 tests
 *                        would exhaust the OTP budget purely by existing, failing on
 *                        ordering rather than on behaviour.
 *
 *   BENCHMARK_MODE=1     For scripts/probe-load.mjs. Without it that probe measures the
 *                        LIMITER rather than the database: 625 requests in about a
 *                        second exhausts the 600/min anonymous search budget, so the
 *                        following scenario receives 625 refusals and the search
 *                        latency baseline disappears. You cannot measure backend
 *                        performance through a rate limiter, and weakening the limit
 *                        to get a number would be the wrong trade — so the switch
 *                        exists instead.
 *
 *   RATE_LIMIT_DISABLED  An explicit operator override, honoured ONLY outside
 *                        production. Setting it on a production host is a refusal to
 *                        boot, not a warning.
 */
function rateLimitingDisabled(): boolean {
  // Refuse the escape hatch outright in production. An OTP endpoint with no send
  // limit is an SMS-billing attack on the operator, and "the operator asked for it" is
  // not sufficient reason to allow it.
  if (config.isProduction && (config.RATE_LIMIT_DISABLED || config.BENCHMARK_MODE)) {
    throw new Error(
      'RATE_LIMIT_DISABLED and BENCHMARK_MODE must not be set in production. ' +
        'An unthrottled OTP endpoint is a billing attack; see lib/rateLimit.ts.',
    );
  }

  if (config.BENCHMARK_MODE) return true;
  return config.isTest && config.RATE_LIMIT_DISABLED;
}
let limitingEnabled = !rateLimitingDisabled();

/**
 * Test seam: turn enforcement on or off at runtime.
 *
 * This exists because tests/setup.ts disables limiting for the whole suite — the
 * counters live in one in-process map, and 281 tests would exhaust the OTP budget
 * purely by existing, making the suite fail on ordering rather than on behaviour.
 *
 * That makes it essential that something still tests the limiter, because a control
 * that is switched off everywhere and never exercised is worse than no control: it
 * looks like protection on a dashboard. tests/unit/rate-limit.test.ts uses this seam
 * to switch enforcement back on and drive real limits.
 */
export function setRateLimitingEnabled(enabled: boolean): void {
  limitingEnabled = enabled;
}

export type RateLimitRule = {
  /** Stable name, used as the bucket namespace. Prefer `code` in application code. */
  name?: string;
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * What to count. Defaults to the client IP.
   *
   * Auth routes key on the phone number as well as the IP, because one attacker
   * behind rotating IPs can still only guess one code per window per number, and one
   * attacker hammering one number from one IP cannot reach a spread-out victim.
   */
  key?: (req: Request) => string;
  /** Message returned with the 429. */
  message?: string;
  /** Error code on the response body, for clients that branch on it. */
  code?: string;
  /**
   * Whether this limit applies at all in the current configuration.
   *
   * Used where a limit exists to protect something that only exists in some
   * deployments — SMS credits, for instance. Returns a note explaining a skip so the
   * reason appears in the log rather than having to be inferred from absence.
   */
  when?: () => { active: boolean; note?: string };
};

/** Stable bucket namespace for a rule, so keys survive route refactors. */
function bucketLabel(rule: RateLimitRule, code: string | undefined): string {
  return code ?? rule.name ?? 'RATE_LIMIT';
}

function clientIp(req: Request): string {
  // app.set('trust proxy', 1) is already set, so req.ip is the real client behind a
  // single proxy hop rather than the proxy's own address. Without that, every caller
  // behind the proxy shares one bucket and the API becomes unusable — which is a
  // tempting reason to disable limiting, so it is worth being explicit.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(rule: RateLimitRule): RequestHandler {
  const { limit, windowMs, key, message, code } = rule;
  ensureSweeper();

  return function rateLimitHandler(req: Request, res: Response, next: NextFunction): void {
    if (!limitingEnabled) {
      next();
      return;
    }

    // Some limits only make sense in some deployments. `when` is evaluated per request
    // so a rule can depend on config without being frozen at import time, and the
    // reason is given rather than left as a bare condition.
    if (rule.when) {
      const verdict = rule.when();
      if (!verdict.active) {
        // Counted as allowed rather than skipped, so the RateLimit headers still tell
        // the client the truth: this budget is not currently being enforced.
        res.setHeader('RateLimit-Limit', '0');
        res.setHeader('RateLimit-Remaining', '0');
        next();
        return;
      }
      if (verdict.note) console.info(`[rate-limit] ${bucketLabel(rule, code)}: ${verdict.note}`);
    }

    const bucketKey = `${bucketLabel(rule, code)}:${key ? key(req) : clientIp(req)}`;
    const now = Date.now();

    const existing = buckets.get(bucketKey);
    let count: number;
    let resetAt: number;

    if (!existing || existing.resetAt <= now) {
      count = 1;
      resetAt = now + windowMs;
      buckets.set(bucketKey, { count, resetAt });
    } else {
      existing.count += 1;
      count = existing.count;
      resetAt = existing.resetAt;
    }

    // Headers are published on every counted request, including the first. A client
    // that can only discover its remaining budget by being refused has no way to back
    // off before the refusal, which is the opposite of what these headers are for.
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((resetAt - now) / 1000)));

    if (count <= limit) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    next(
      AppError.tooManyRequests(
        message ?? 'Too many requests. Please wait a moment and try again.',
        code ?? 'RATE_LIMITED',
      ),
    );
  };
}

/** Test seam: the live client IP, for use inside a key function. */
export { clientIp };

/**
 * The limits added here, and — more usefully — the ones deliberately NOT added.
 *
 * OTP guessing is NOT limited here. auth.routes.ts already enforces five wrong
 * attempts per code, and it counts them on the OtpCode row in the database rather than
 * in this map. That is a better control than anything added here: it survives a
 * restart, it coordinates across instances, and it resets exactly when a new code is
 * issued. An in-memory copy of the same limit would be weaker and would obscure which
 * one is authoritative.
 *
 * OTP send limiting is likewise not duplicated. enforceOtpRateLimit() caps sends per
 * phone, and is deliberately inert when the OTP is not billed so a developer running
 * the smoke tests twice is not blocked.
 *
 * What IS missing from that existing pair, and what the one OTP limit below closes:
 * both counters key on the phone number. An attacker enumerating numbers from one
 * machine gets a fresh budget per number, which is precisely the shape of an SMS
 * billing attack — the cost lands on the operator, not the attacker. A per-IP cap is
 * the missing half, and it is the only OTP-related limit added here.
 */
export const limits = {
  booking: rateLimit({
    limit: 8,
    windowMs: 60 * 60_000,
    key: (req) => `user:${(req as { auth?: { sub?: string } }).auth?.sub ?? clientIp(req)}`,
    code: 'BOOKING',
    message: 'Too many bookings from this account. Try again later.',
  }),
  quote: rateLimit({
    limit: 30,
    windowMs: 60_000,
    key: (req) => `user:${(req as { auth?: { sub?: string } }).auth?.sub ?? clientIp(req)}`,
    code: 'QUOTE',
  }),
  /**
 * Search: 600 per minute.
 *
 * The number is much higher than the other limits on purpose, and the reason is
 * specific to this product rather than to security: anonymous search is keyed on IP,
 * and every student on one campus Wi-Fi shares a single address. A hostel platform
 * used by a college is exactly the case where hundreds of legitimate users appear as
 * one client. At the 60/min used elsewhere, a campus browsing at lunch would throttle
 * itself, and the response to a 429 from a student is to close the app.
 *
 * 600/min is still 10 requests a second sustained, which bounds a scraper
 * enumerating the hostel catalogue. That is the abuse this needs to stop; the cost of
 * the limit is the thing being avoided, not the thing being prevented.
 *
 * Note for anyone re-running scripts/security-probe.mjs: probe RATE-1 fires 30
 * concurrent searches and flags if any are refused. At 600/min that burst cannot trip
 * this limit, so RATE-1 no longer detects search throttling — the limit exists, but
 * that probe is no longer the thing that proves it. That probe was written to prove
 * the ABSENCE of a limit, which is now a stale premise. It has deliberately been left
 * untouched rather than edited to agree with the new code.
 */
search: rateLimit({
  limit: 600,
  windowMs: 60_000,
  code: 'SEARCH',
  // Prefer the user id so a signed-in student browsing from a shared address does not
  // consume the anonymous budget, and cannot be starved by someone else on the same IP.
  key: (req) => {
    const sub = (req as { auth?: { sub?: string } }).auth?.sub;
    return sub ? `user:${sub}` : `ip:${clientIp(req)}`;
  },
}),
  admin: rateLimit({
    limit: 60,
    windowMs: 60_000,
    key: (req) => `user:${(req as { auth?: { sub?: string } }).auth?.sub ?? clientIp(req)}`,
    code: 'ADMIN',
  }),
  /**
   * 20 per IP per 15 minutes, complementing the per-phone send limit. High enough that
   * a shared office NAT or a college campus does not trip it for its legitimate users,
   * low enough that rotating numbers buys an attacker little.
   *
   * Gated on `otpIsBilled`, exactly like the per-phone counter it complements. This
   * cap protects the operator's SMS balance; when codes are printed to the console
   * there is no balance to protect, and an ungated version of this cap was observed
   * blocking the local smoke test on its tenth sign-in. Both limiters therefore ask
   * config.otpIsBilled rather than each deciding for itself.
   */
  otpRequestByIp: rateLimit({
    limit: 20,
    windowMs: 15 * 60_000,
    code: 'OTP_REQUEST_IP',
    message: 'Too many codes requested from this network. Try again in a few minutes.',
    when: () =>
      config.otpIsBilled
        ? { active: true }
        : {
            active: false,
            note: 'not enforced — no billed SMS provider configured, so there is no balance to protect.',
          },
  }),
} as const;