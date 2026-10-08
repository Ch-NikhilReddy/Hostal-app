import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { parseDurationSeconds } from '../lib/duration.js';
import { prisma } from '../db.js';

export type AccessTokenClaims = {
  sub: string;
  role: Role;
  /** Owner id, present only on OWNER accounts, to avoid a lookup on hot paths. */
  ownerId?: string;
};

export function signAccessToken(claims: AccessTokenClaims): string {
  // Seconds resolved by our own parser rather than handing the config string to
  // jsonwebtoken. Passing the raw string meant this lifetime was interpreted by
  // the `ms` library while the refresh-token lifetime was interpreted by
  // parseInt — two different answers for the same config format. Computing the
  // number here means both paths share one implementation.
  const expiresInSeconds = parseDurationSeconds(config.JWT_ACCESS_TTL, 'JWT_ACCESS_TTL');

  const options: SignOptions = {
    expiresIn: expiresInSeconds,
    issuer: 'hostelmitra',
    audience: 'hostelmitra-app',
  };
  return jwt.sign({ role: claims.role, ownerId: claims.ownerId }, config.JWT_SECRET, {
    ...options,
    subject: claims.sub,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'hostelmitra',
      audience: 'hostelmitra-app',
    }) as JwtPayload;

    if (!decoded.sub || typeof decoded.role !== 'string') {
      throw AppError.unauthorized('Malformed session token.', 'INVALID_TOKEN');
    }
    return {
      sub: decoded.sub,
      role: decoded.role as Role,
      ownerId: typeof decoded.ownerId === 'string' ? decoded.ownerId : undefined,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.unauthorized('Your session has expired. Please sign in again.', 'INVALID_TOKEN');
  }
}

/** Opaque refresh token. Returned to the client once; only the hash is stored. */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, tokenHash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string compare that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 6-digit OTP.
 *
 * randomInt is used rather than Math.random because a Math.random-based OTP is
 * predictable from four observed values, which turns OTP login into no login at
 * all.
 */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type AuthedRequest = Request & {
  auth: AccessTokenClaims;
  /**
   * The caller's row as it exists RIGHT NOW, loaded by requireAuth.
   *
   * Deliberately not the token claims. The token is a snapshot from up to
   * JWT_ACCESS_TTL ago and cannot be withdrawn, so anything an operator can change
   * about an account has to be read fresh or it stays true for the rest of the
   * token's life. requireRole reuses this row rather than issuing a second query,
   * so the check costs one read per request, not two.
   */
  user: AuthenticatedUser;
};

/** The columns of User that authorisation depends on. Deliberately minimal. */
export type AuthenticatedUser = {
  id: string;
  role: Role;
  isActive: boolean;
};

function bearerFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/**
 * Require any signed-in user whose account is still usable. Attaches `req.auth` and
 * `req.user`.
 *
 * The database read is the point of this function, not an optimisation to avoid.
 * It previously verified the signature and nothing else, so a deactivated or
 * deleted account kept working for anyone still holding its token: GET
 * /v1/auth/me answered 200 after an admin set isActive = false. No code path could
 * revoke an access token early — signing out dropped only the refresh token, and
 * the 15-minute access token kept being accepted the whole time.
 *
 * It is one indexed primary-key read. requireRole used to perform the same read, so
 * owner, admin and booking routes are unchanged in cost; routes that used
 * requireAuth on its own now pay it for the first time, which is the entire fix.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearerFrom(req);
  if (!token) {
    next(AppError.unauthorized());
    return;
  }
  try {
    const auth = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: auth.sub },
      select: { id: true, role: true, isActive: true },
    });

    // A valid signature for a user that no longer exists means the row was deleted
    // while the token was live. Treat it as unauthenticated rather than letting the
    // request through to fail somewhere less obvious.
    if (!user) {
      throw AppError.unauthorized('Your session is no longer valid.', 'ACCOUNT_NOT_FOUND');
    }
    if (!user.isActive) {
      throw AppError.forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
    }

    const authed = req as AuthedRequest;
    authed.auth = auth;
    authed.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require one of the given roles.
 *
 * A deactivated account is rejected even with a valid token, otherwise a student
 * who deleted their account keeps full access until the 15-minute token expires.
 *
 * The isActive check itself lives in requireAuth and is inherited from `req.user`;
 * this adds only the role test, so no extra query is issued here.
 *
 * REQUIRES requireAuth to have run first. If `req.user` is absent the chain is
 * misordered, and that is treated as unauthenticated rather than allowed through —
 * a wiring mistake must fail closed.
 *
 * The role compared here is the one in the TOKEN, not the database. That is a known
 * and accepted trade-off, documented in docs/security-model.md: a demotion takes
 * effect when the token is refreshed, not before.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const { auth, user } = req as AuthedRequest;
      if (!auth || !user) {
        throw AppError.unauthorized();
      }
      if (!roles.includes(auth.role)) {
        throw AppError.forbidden(
          `This action requires ${roles.join(' or ').toLowerCase()} access.`,
          'INSUFFICIENT_ROLE',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}