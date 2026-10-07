import corsMiddleware from 'cors';
import { AppError } from './errors.js';

/**
 * CORS origin allowlist.
 *
 * The rule this module exists to enforce: **an origin is trusted only if an
 * operator explicitly listed it.** Nothing else grants trust. In particular a
 * missing or misconfigured environment variable must never widen the policy —
 * defaulting to "allow everything" is how a staging host ends up readable by
 * any website a signed-in operator visits.
 *
 * Why this is its own module rather than a line in app.ts: the decision is
 * "which origins are trusted", which is a security decision with edge cases
 * (wildcards, trailing slashes, case, ports, subdomains). It has to be unit
 * testable without booting Express.
 */

/** Localhost origins that a developer machine legitimately needs. */
const DEV_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export type CorsPolicy = {
  /** Resolved origins, lowercased, no trailing slash. Empty means "trust nothing". */
  allowedOrigins: string[];
  /** True only for an explicit developer-machine allowance. */
  allowLoopback: boolean;
  isProduction: boolean;
};

/**
 * Normalise one configured origin for comparison.
 *
 * Two normalisations matter and are easy to miss:
 *  - trailing slashes, because "https://app.example.com/" and
 *    "https://app.example.com" must not be two different allowlist entries;
 *  - case, because a browser lowercases the host it sends in Origin but a
 *    human writing the env var may not.
 *
 * Returns null for anything that is not a usable absolute http(s) origin, so a
 * typo cannot silently become a trusted entry.
 */
export function normaliseOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Reject anything carrying credentials or a path. "https://user:pw@host" in a
  // CORS allowlist is a configuration error, and a bare origin must not have one.
  if (url.username || url.password) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;

  // Drop the default port so "https://x:443" and "https://x" agree.
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  return url.origin.toLowerCase();
}

/**
 * Parse the CORS_ORIGINS value into a policy.
 *
 * @param configured raw CORS_ORIGINS, comma-separated, possibly with whitespace
 * @param isProduction true for production only; staging is treated as production
 */
export function buildCorsPolicy(configured: string | undefined, isProduction: boolean): CorsPolicy {
  const allowedOrigins = (configured ?? '')
    .split(',')
    .map((entry) => normaliseOrigin(entry))
    .filter((o): o is string => o !== null);

  // A wildcard is only meaningful in development, and it is refused in
  // production below. Keep it out of allowedOrigins either way so it can never
  // reach the `cors` package alongside credentials.
  const hadWildcard = (configured ?? '').split(',').some((e) => e.trim() === '*');

  if (isProduction) {
    if (hadWildcard) {
      throw new AppError(
        500,
        'CORS_WILDCARD_IN_PRODUCTION',
        'CORS_ORIGINS must not be "*" in production. List the exact frontend origins.',
      );
    }
    if (allowedOrigins.length === 0) {
      throw new AppError(
        500,
        'CORS_ORIGINS_MISSING',
        'CORS_ORIGINS is required in production and must list at least one exact origin.',
      );
    }
    return { allowedOrigins, allowLoopback: false, isProduction: true };
  }

  // Development: an explicit list plus loopback, never an open door.
  const withLoopback = [...allowedOrigins];
  return { allowedOrigins: withLoopback, allowLoopback: true, isProduction: false };
}

/**
 * Decide whether a request's Origin is allowed.
 *
 * Returns false when there is no Origin header at all, which is the normal case
 * for a native mobile client — React Native does not send Origin, so the CORS
 * layer correctly does not apply to it.
 */
export function isOriginAllowed(origin: string | undefined, policy: CorsPolicy): boolean {
  if (!origin) return false;

  let candidate: string;
  try {
    candidate = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }

  if (policy.allowedOrigins.includes(candidate)) return true;
  if (policy.allowLoopback && DEV_LOOPBACK.test(candidate)) return true;

  return false;
}

/**
 * Build the Express `cors` options.
 *
 * `origin` is a FUNCTION rather than `true`, which is the entire point: `true`
 * makes the library echo whatever Origin it receives, i.e. trust every caller.
 * Returning `false` here means no CORS headers are emitted, so the browser
 * blocks the response — a genuine refusal rather than a header omission.
 *
 * Credentials stay enabled because the web dashboard legitimately needs them if
 * it ever moves to cookie auth. It is safe only because `origin` is no longer
 * reflective: credentials are granted exclusively to allowlisted origins.
 */
export function corsOptionsFor(policy: CorsPolicy) {
  return {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void => {
      if (isOriginAllowed(origin, policy)) {
        callback(null, true);
        return;
      }
      // An error here surfaces as a 500 to the caller. For a disallowed origin
      // that is the honest outcome: this server does not serve that origin, and
      // silently returning 200 without CORS headers would make debugging a
      // misconfiguration much harder.
      callback(
        new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not permitted to call the API.'),
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Explicit origins are not cacheable by shared caches; Vary stops an
    // intermediary serving one origin's response to another.
    maxAge: 600,
  };
}

/**
 * Wrap the cors middleware so a request with no Origin header passes straight
 * through, without consulting the policy and without emitting CORS headers.
 *
 * This is required, not an optimisation. React Native does not send an Origin
 * header, so every request from the Android app arrives without one. Routing
 * those through the allowlist would reject them all and break the mobile client
 * entirely — which is exactly the regression the first version of this fix
 * introduced and the HTTP test caught.
 *
 * A request with no Origin is not a cross-origin request, so CORS does not
 * apply to it; the browser enforces nothing and the server has nothing to grant.
 */
export function corsGuard(policy: CorsPolicy) {
  const handler = corsMiddleware(corsOptionsFor(policy));

  return function guardedCors(
    req: { headers: Record<string, string | string[] | undefined> },
    res: Parameters<typeof handler>[1],
    next: Parameters<typeof handler>[2],
  ): void {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    handler(req as never, res, next);
  };
}