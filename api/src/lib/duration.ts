import { AppError } from './errors.js';

/**
 * Duration parsing for token lifetimes.
 *
 * One parser, one interpretation, used by every consumer. The bug this replaces:
 * `Number.parseInt('12h') * 86_400_000` yields 12 DAYS, because parseInt stops at
 * the first non-digit and the multiplier then pretends everything is days. An
 * operator who shortened the refresh TTL from 30d to 12h got 12 days and no
 * warning, which is the exact opposite of the change they asked for.
 *
 * Units: ms, s, m, h, d. Nothing else.
 *
 * ## Unitless values are rejected on purpose
 *
 * The `ms` library that jsonwebtoken depends on reads a bare number as
 * MILLISECONDS: ms('3600') is 3.6 seconds, not an hour. Accepting "3600" would
 * therefore mean two different durations depending on which code path parsed it,
 * and a token that expires three seconds after issue is a support incident rather
 * than a security one. Requiring an explicit unit removes the ambiguity entirely.
 */

/** Milliseconds per supported unit. */
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export type DurationUnit = keyof typeof UNIT_MS;

/**
 * Upper bound. Thirty days is comfortably beyond any legitimate token lifetime
 * here (refresh is 30d), and a ceiling means a fat-fingered "300d" fails loudly
 * at startup instead of minting a token that outlives the deployment.
 */
export const MAX_DURATION_MS = 90 * 86_400_000;

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Parse a duration string to milliseconds.
 *
 * @throws AppError 400 for anything malformed, empty, non-positive, or missing
 *         a unit. Callers at startup get a hard failure rather than a silently
 *         wrong lifetime.
 */
export function parseDurationMs(value: string, label = 'duration'): number {
  const raw = typeof value === 'string' ? value.trim() : '';

  if (raw === '') {
    throw AppError.badRequest(
      'INVALID_DURATION',
      `${label} is required and must include a unit, e.g. "15m", "12h" or "30d".`,
    );
  }

  const match = DURATION_PATTERN.exec(raw);
  if (!match) {
    // A separate branch for a negative sign, because the failure a human needs to
    // see is "negative", not "malformed".
    if (/^-\d/.test(raw)) {
      throw AppError.badRequest('INVALID_DURATION', `${label} must be positive, received "${raw}".`);
    }
    throw AppError.badRequest(
      'INVALID_DURATION',
      `${label} "${raw}" is not a valid duration. Use a number followed by ms, s, m, h or d (e.g. "30d").`,
    );
  }

  // The pattern guarantees digits then a unit, and `unit` is therefore always one
  // of UNIT_MS's keys. Indexing rather than casting keeps the compiler honest
  // about that.
  const digits = match[1];
  const unit = match[2] as DurationUnit;
  const amount = Number(digits);
  const ms = amount * UNIT_MS[unit];

  if (!Number.isSafeInteger(ms)) {
    throw AppError.badRequest('INVALID_DURATION', `${label} "${raw}" is too large to represent.`);
  }

  if (ms === 0) {
    // "0m" parses cleanly but yields a token that is already expired.
    throw AppError.badRequest('INVALID_DURATION', `${label} must be greater than zero, received "${raw}".`);
  }

  if (ms > MAX_DURATION_MS) {
    throw AppError.badRequest(
      'INVALID_DURATION',
      `${label} "${raw}" exceeds the maximum of 90d.`,
    );
  }

  return ms;
}

/** Seconds, for jsonwebtoken's `expiresIn`, which counts in seconds when numeric. */
export function parseDurationSeconds(value: string, label = 'duration'): number {
  const ms = parseDurationMs(value, label);
  return Math.floor(ms / 1000);
}

/**
 * Absolute expiry Date for "now + duration".
 *
 * Both refresh-token call sites use this so the database column and the signed JWT
 * can never be derived by different arithmetic.
 */
export function expiryFromNow(value: string, now: Date = new Date(), label = 'duration'): Date {
  return new Date(now.getTime() + parseDurationMs(value, label));
}

/**
 * Validate both TTLs at startup.
 *
 * Called from config.ts so a typo in either variable prevents the process from
 * booting. Without this, a bad JWT_REFRESH_TTL would not surface until the first
 * login attempt, by which point the deploy is already serving traffic.
 */
export function assertDuration(value: string, label: string): void {
  parseDurationMs(value, label);
}