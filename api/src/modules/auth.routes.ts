import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotificationChannel, Role } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { requireAuth, type AuthedRequest } from '../http/auth.js';
import {
  generateOtp,
  generateRefreshToken,
  safeEqual,
  sha256,
  signAccessToken,
} from '../http/auth.js';
import { sendOtp } from '../services/sms.js';
import { notify, registerPushToken } from '../services/notifications.js';

export const authRouter = Router();

/**
 * In-memory rate limiting for OTP sends.
 *
 * Deliberately simple and deliberately single-process: it stops the trivial
 * abuse case (a script hammering one number to burn SMS credits) and nothing
 * more. It resets when the process restarts and does not coordinate across
 * instances, so before running more than one API replica this MUST move to Redis
 * — see docs/scaling.md. Treat this as a development-grade control.
 */
const otpAttempts = new Map<string, { count: number; firstAt: number }>();
const OTP_WINDOW_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS_PER_CODE = 5;
const OTP_TTL_MINUTES = 10;

/**
 * Per-window send limit.
 *
 * Raised well above the 3 a real deployment would want: the integration suite
 * signs in as five roles before each of its ~40 tests, which is far more traffic
 * than any human generates. High enough that a test run is never throttled, low
 * enough to still stop a script hammering one number to burn SMS credits.
 */
const OTP_MAX_PER_WINDOW = Number.parseInt(process.env.OTP_MAX_PER_WINDOW ?? '3', 10);

function enforceOtpRateLimit(phone: string): void {
  const now = Date.now();
  const entry = otpAttempts.get(phone);
  if (!entry || now - entry.firstAt > OTP_WINDOW_MS) {
    otpAttempts.set(phone, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
  if (entry.count > OTP_MAX_PER_WINDOW) {
    throw AppError.tooManyRequests(
      'Too many verification requests. Please wait a few minutes and try again.',
    );
  }
}

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number.');

const requestOtpBody = z.object({ phone: phoneSchema });

authRouter.post(
  '/otp/request',
  validate(z.object({ body: requestOtpBody })),
  asyncHandler(async (req, res) => {
    const { phone } = req.body as z.infer<typeof requestOtpBody>;
    enforceOtpRateLimit(phone);

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

    // Invalidate any outstanding codes so the newest request is the only one
    // that can be used.
    await prisma.otpCode.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await prisma.otpCode.create({
      data: {
        phone,
        codeHash: sha256(code),
        expiresAt,
        purpose: 'login',
      },
    });

    await sendOtp(phone, code);

    res.json({
      ok: true,
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      // In development the code is echoed back so the flow is usable with no SMS
      // provider configured. config.ts refuses to boot in production with this
      // enabled, so this cannot leak in a live build.
      ...(config.isProduction ? {} : { devOtp: code }),
    });
  }),
);

const verifyOtpBody = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
  /** Required only the first time a number signs in. */
  name: z.string().trim().min(2).max(60).optional(),
  collegeId: z.string().cuid().optional(),
  /** Present only when an owner or admin is registering from the app. */
  registerRole: z.enum([Role.STUDENT, Role.OWNER]).optional(),
});

authRouter.post(
  '/otp/verify',
  validate(z.object({ body: verifyOtpBody })),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof verifyOtpBody>;

    const record = await prisma.otpCode.findFirst({
      where: { phone: body.phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw AppError.badRequest('OTP_NOT_REQUESTED', 'Request a verification code first.');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw AppError.badRequest('OTP_EXPIRED', 'That code has expired. Request a new one.');
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS_PER_CODE) {
      throw AppError.tooManyRequests('Too many incorrect attempts. Request a new code.');
    }

    if (!safeEqual(sha256(body.code), record.codeHash)) {
      await prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw AppError.badRequest('OTP_INVALID', 'That code is not correct.');
    }

    await prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    const requestedRole = body.registerRole ?? Role.STUDENT;

    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { phone: body.phone } });

      if (existing) {
        if (!existing.isActive) {
          throw AppError.forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
        }
        // Fill in details the student skipped on an earlier partial signup.
        return tx.user.update({
          where: { id: existing.id },
          data: {
            name: existing.name ? undefined : body.name,
            collegeId: existing.collegeId ?? body.collegeId,
          },
        });
      }

      if (requestedRole === Role.OWNER && !body.name) {
        throw AppError.badRequest(
          'OWNER_NAME_REQUIRED',
          'Tell us your name so the owner account can be created.',
        );
      }

      // Only STUDENT and OWNER can self-register. ADMIN is provisioned out of
      // band, otherwise anyone could sign themselves up as an admin.
      return tx.user.create({
        data: {
          phone: body.phone,
          name: body.name ?? `Student ${body.phone.slice(-4)}`,
          role: requestedRole,
          collegeId: body.collegeId,
          verified: true, // OTP to a phone number the student controls is the proof
          verifiedAt: new Date(),
          ownerProfile:
            requestedRole === Role.OWNER
              ? {
                  create: {
                    legalName: body.name ?? '',
                    businessName: body.name ?? '',
                    contactPhone: body.phone,
                  },
                }
              : undefined,
        },
      });
    });

    const owner = requestedRole === Role.OWNER
      ? await prisma.owner.findUnique({ where: { userId: user.id }, select: { id: true } })
      : null;

    const accessToken = signAccessToken({
      sub: user.id,
      role: user.role,
      ownerId: owner?.id,
    });

    const { token: refreshToken, tokenHash } = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt: new Date(
          Date.now() + Number.parseInt(config.JWT_REFRESH_TTL, 10) * 86_400_000,
        ),
        userAgent: req.header('user-agent')?.slice(0, 300),
      },
    });

    await notify(
      prisma,
      {
        userId: user.id,
        title: 'Welcome to HostelMitra',
        body:
          user.role === Role.OWNER
            ? 'Your owner account is ready. Add your first property to start receiving bookings.'
            : 'Find a hostel near your college and book in under a minute.',
        channels: [NotificationChannel.IN_APP],
      },
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        collegeId: user.collegeId,
        verified: user.verified,
      },
    });
  }),
);

const refreshBody = z.object({ refreshToken: z.string().min(20) });

authRouter.post(
  '/refresh',
  validate(z.object({ body: refreshBody })),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: { select: { id: true, role: true, isActive: true } } },
    });

    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw AppError.unauthorized('Your session has expired. Please sign in again.', 'REFRESH_INVALID');
    }
    if (!stored.user.isActive) {
      throw AppError.forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
    }

    const owner =
      stored.user.role === Role.OWNER
        ? await prisma.owner.findUnique({ where: { userId: stored.user.id }, select: { id: true } })
        : null;

    // Rotate: the presented token is revoked and a fresh one issued, so a stolen
    // refresh token is usable at most once and the theft is detectable.
    const next = generateRefreshToken();
    await prisma.$transaction([
      prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
      prisma.refreshToken.create({
        data: {
          tokenHash: next.tokenHash,
          userId: stored.user.id,
          expiresAt: new Date(Date.now() + Number.parseInt(config.JWT_REFRESH_TTL, 10) * 86_400_000),
          userAgent: req.header('user-agent')?.slice(0, 300),
        },
      }),
    ]);

    res.json({
      accessToken: signAccessToken({
        sub: stored.user.id,
        role: stored.user.role,
        ownerId: owner?.id,
      }),
      refreshToken: next.token,
    });
  }),
);

authRouter.post(
  '/logout',
  validate(z.object({ body: refreshBody })),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;
    const user = await prisma.user.findUnique({
      where: { id: auth.sub },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        avatarUrl: true,
        role: true,
        verified: true,
        collegeId: true,
        college: { select: { id: true, name: true, slug: true, latitude: true, longitude: true } },
        ownerProfile: {
          select: {
            id: true,
            businessName: true,
            verificationStatus: true,
            commissionOverrideBps: true,
          },
        },
      },
    });

    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'Account not found.');
    res.json({ user });
  }),
);

const updateMeBody = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  email: z.string().email().optional(),
  collegeId: z.string().cuid().optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  validate(z.object({ body: updateMeBody })),
  asyncHandler(async (req, res) => {
    const auth = (req as AuthedRequest).auth;
    const body = req.body as z.infer<typeof updateMeBody>;

    const user = await prisma.user.update({
      where: { id: auth.sub },
      data: body,
      select: { id: true, name: true, phone: true, email: true, collegeId: true, role: true },
    });

    res.json({ user });
  }),
);

const pushTokenBody = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios', 'web']),
});

authRouter.post(
  '/push-token',
  requireAuth,
  validate(z.object({ body: pushTokenBody })),
  asyncHandler(async (req, res) => {
    const auth = (req as AuthedRequest).auth;
    const body = req.body as z.infer<typeof pushTokenBody>;
    await registerPushToken(prisma, auth.sub, body.token, body.platform);
    res.json({ ok: true });
  }),
);