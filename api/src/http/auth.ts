import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../db.js';

export type AccessTokenClaims = {
  sub: string;
  role: Role;
  /** Owner id, present only on OWNER accounts, to avoid a lookup on hot paths. */
  ownerId?: string;
};

export function signAccessToken(claims: AccessTokenClaims): string {
  const options: SignOptions = {
    expiresIn: config.JWT_ACCESS_TTL as SignOptions['expiresIn'],
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
};

function bearerFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/** Require any signed-in user. Attaches `req.auth`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerFrom(req);
  if (!token) {
    next(AppError.unauthorized());
    return;
  }
  try {
    (req as AuthedRequest).auth = verifyAccessToken(token);
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
 */
export function requireRole(...roles: Role[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = (req as AuthedRequest).auth;
      if (!auth) {
        throw AppError.unauthorized();
      }
      if (!roles.includes(auth.role)) {
        throw AppError.forbidden(
          `This action requires ${roles.join(' or ').toLowerCase()} access.`,
          'INSUFFICIENT_ROLE',
        );
      }
      const user = await prisma.user.findUnique({
        where: { id: auth.sub },
        select: { isActive: true },
      });
      if (!user?.isActive) {
        throw AppError.forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}