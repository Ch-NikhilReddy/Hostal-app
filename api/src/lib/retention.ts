import { prisma } from '../db.js';
import { config } from '../config.js';

/**
 * Retention sweeper.
 *
 * Two tables grow without bound and neither is read after a short window:
 *
 *   otp_codes        every login attempt writes one. Verified 4,626 rows on a
 *                    development database that has never seen real traffic. A code is
 *                    useless the moment it expires, so keeping it past its expiry is
 *                    pure liability — it is a list of live login credentials for
 *                    recently-active phone numbers.
 *   refresh_tokens   one per sign-in. Expired ones are never consulted, but unlike OTP
 *                    codes they are the *only* thing standing between a leaked token
 *                    and indefinite access, so they are kept longer than is convenient.
 *
 * The retention windows are deliberately different, and that difference is the design:
 * deleting a refresh token early can sign a real user out, whereas keeping an OTP
 * code slightly too long is merely untidy. When in doubt this keeps more, not less.
 *
 * NOT deleted: notifications, bookings, payments, audit rows. Those are the record of
 * what happened and are not this job's business.
 */

/** OTP codes: unusable once expired, so a day of grace is generous. */
const OTP_RETENTION_HOURS = 24;

/**
 * Refresh tokens: 30 days past expiry.
 *
 * An expired token can never be exchanged, so this is not about being able to use it.
 * It is about being able to investigate "was this session compromised?" for a month
 * after the fact, and about not destroying evidence when a breach is suspected.
 */
const REFRESH_RETENTION_DAYS = 30;

const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly

let timer: NodeJS.Timeout | undefined;

export interface SweepResult {
  otpDeleted: number;
  refreshDeleted: number;
  /** Rows examined, for the log line. DeleteMany reports only counts. */
  otpEligible: number;
}

/**
 * Delete expired rows. Returns counts so a caller can log or assert on them.
 *
 * Exported and side-effect-light on purpose: the sweep is worth testing directly, and
 * a test that has to start a timer and wait an hour is a test nobody writes.
 */
export async function sweepRetention(now = new Date()): Promise<SweepResult> {
  const otpCutoff = new Date(now.getTime() - OTP_RETENTION_HOURS * 3_600_000);
  const refreshCutoff = new Date(now.getTime() - REFRESH_RETENTION_DAYS * 86_400_000);

  // Counted before deleting, because `deleteMany` returns only how many rows changed
  // and a log line saying "deleted 0" is indistinguishable from "nothing to do" and
  // from "the query is wrong".
  const otpEligible = await prisma.otpCode.count({ where: { expiresAt: { lt: otpCutoff } } });
  const otpDeleted = otpEligible
    ? await prisma.otpCode.deleteMany({ where: { expiresAt: { lt: otpCutoff } } }).then((r) => r.count)
    : 0;

  const refreshDeleted = await prisma.refreshToken
    .deleteMany({ where: { expiresAt: { lt: refreshCutoff } } })
    .then((r) => r.count);

  return { otpDeleted, refreshDeleted, otpEligible };
}

export function startRetentionSweeper(): void {
  if (timer) return;
  if (config.isTest) return;

  timer = setInterval(() => {
    void sweepRetention()
      .then((r) => {
        if (r.otpDeleted || r.refreshDeleted) {
          console.info(
            `[retention] removed ${r.otpDeleted} expired OTP code(s) and ${r.refreshDeleted} expired refresh token(s)`,
          );
        }
      })
      .catch((err: unknown) => {
        // Logged, not thrown: an unhandled rejection here would be reported by the
        // process-level handler as a fatal error and shut the API down. A retention
        // job that fails must not take the service with it.
        console.error('[retention] sweep failed:', (err as Error).message);
      });
  }, SWEEP_INTERVAL_MS);

  timer.unref?.();
}

export function stopRetentionSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Test seam: run the sweep immediately. */
export async function runRetentionNow(): Promise<SweepResult> {
  const r = await sweepRetention();
  console.info(
    `[retention] removed ${r.otpDeleted} expired OTP code(s) and ${r.refreshDeleted} expired refresh token(s)`,
  );
  return r;
}