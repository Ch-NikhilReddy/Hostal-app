import { prisma } from '../db.js';
import { config } from '../config.js';
import { releaseExpiredHolds } from '../services/availability.js';

/**
 * Reaper for expired payment holds.
 *
 * WHY THIS EXISTS. `GET /v1/hostels` used to call releaseExpiredHolds() on every
 * request. That is a write on a read path: search is the most-hit endpoint in the
 * application, and every one of those requests took a row lock, ran an UPDATE ... RETURNING
 * and wrote a booking_status_events row. Two consequences:
 *
 *   1. Search could not be served from a cache or a read replica, because it was not
 *      actually a read.
 *   2. Search scaled inversely with load. More readers meant more writes.
 *
 * So the sweep moved here, onto a timer. A timer is the right shape: the work is
 * periodic, identical every time, and nobody is waiting on it.
 *
 * WHY THERE IS STILL A REQUEST-PATH SWEEP. If the timer dies — an unhandled rejection
 * in this file, a process restart, a clock jump — and nothing else ever releases a
 * hold, then every abandoned checkout permanently shrinks the inventory shown to
 * everyone. Booked beds would never come back. A background job with no safety net is
 * how that happens.
 *
 * So the timer is the primary mechanism and this sweep is the backstop, and the
 * backstop is rate-limited to once per SAFETY_SWEEP_MS regardless of how many requests
 * arrive. Under normal load the backstop never fires; after a timer failure the very
 * next search repairs the inventory. The cost is bounded at one sweep per interval no
 * matter the request rate, which is the property that was missing before.
 */

/** How often the timer sweeps. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * Minimum gap between request-triggered backstop sweeps. Chosen well above
 * SWEEP_INTERVAL_MS so that in steady state the two never overlap and the backstop is
 * pure insurance.
 */
const SAFETY_SWEEP_MS = 60_000;

let lastSweepAt = 0;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<number> | undefined;

/**
 * Release expired holds, at most once per SAFETY_SWEEP_MS.
 *
 * Concurrent callers share one in-flight promise rather than each starting their own
 * sweep, which is what stops a burst of searches from queueing up overlapping UPDATEs
 * against the same rows.
 */
export function sweepExpiredHolds(): Promise<number> {
  const now = Date.now();
  if (now - lastSweepAt < SAFETY_SWEEP_MS) return Promise.resolve(0);
  if (inFlight) return inFlight;

  lastSweepAt = now;
  inFlight = releaseExpiredHolds(prisma)
    .then((released) => {
      if (released > 0) console.info(`[holds] released ${released} expired hold(s)`);
      return released;
    })
    .catch((err: unknown) => {
      // Deliberately not rethrown. A search must not fail because a maintenance sweep
      // did, and the failure is logged rather than swallowed silently.
      console.error('[holds] sweep failed:', (err as Error).message);
      // Reset the guard so the next search retries rather than waiting out a full
      // minute on a transient failure.
      lastSweepAt = 0;
      return 0;
    })
    .finally(() => {
      inFlight = undefined;
    });

  return inFlight;
}

/** Start the periodic sweep. Idempotent. */
export function startHoldReaper(): void {
  if (timer) return;
  if (config.isTest) return; // a background writer would race the integration suite

  timer = setInterval(() => {
    void sweepExpiredHolds();
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

/** Stop it. Used on shutdown and by tests. */
export function stopHoldReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  lastSweepAt = 0;
}

/** Test seam: force the next sweep to run regardless of the interval. */
export function resetSweepGuard(): void {
  lastSweepAt = 0;
}