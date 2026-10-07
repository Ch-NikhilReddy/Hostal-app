/**
 * Money. Every value here is an integer number of PAISE (1 INR = 100 paise).
 *
 * Why integers: PG rent is quoted in whole rupees, deposits are whole rupees,
 * and commission is a percentage. Doing that arithmetic in floats produces
 * totals like 850000.0000000001, which then fails an equality assertion in a
 * webhook handler and leaves a booking stuck in PENDING_PAYMENT forever. The
 * rule this module enforces is: paise go in, paise come out, and every
 * intermediate is an integer.
 */

export type Paise = number;

if (!Number.isInteger(1)) {
  throw new Error('Impossible: Number.isInteger(1) must be true.');
}

/** Assert a value is a whole number of paise. Throws loudly at the boundary. */
export function assertPaise(value: unknown, label = 'amount'): Paise {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, received: ${String(value)}`);
  }
  return value;
}

/** Rupees (may be fractional, e.g. a pro-rated day) to paise, half-up rounded. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new TypeError(`rupees must be finite, received: ${rupees}`);
  return Math.round(rupees * 100);
}

/** Paise to a rupee number. For display and for gateway payloads only. */
export function paiseToRupees(paise: Paise): number {
  return assertPaise(paise) / 100;
}

/**
 * Format paise as an Indian-format rupee string, e.g. 850000 -> "8,500.00".
 * `Intl` gives the lakh/crore grouping for free, which is what users expect.
 */
export function formatPaise(paise: Paise): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paiseToRupees(assertPaise(paise)));
}

/**
 * Apply a percentage given in basis points, rounding HALF UP.
 *
 * 1000 bps = 10.00%. Half-up rather than half-even because a student charged
 * 10% commission of 850000 must not silently be rounded down in the platform's
 * favour on every single booking — the drift accumulates over a month of
 * settlements and the ledger stops reconciling.
 */
export function applyBps(amount: Paise, bps: number): Paise {
  assertPaise(amount);
  if (!Number.isInteger(bps) || bps < 0) {
    throw new TypeError(`bps must be a non-negative integer, received: ${String(bps)}`);
  }
  if (bps === 0) return 0;
  return Math.floor((amount * bps + 5000) / 10000);
}

/** Convert a percentage like 10.25 to bps. Rejects more precision than bps holds. */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new TypeError(`percent must be within 0..100, received: ${percent}`);
  }
  const bps = Math.round(percent * 100);
  return bps;
}

export function sum(...values: Paise[]): Paise {
  return values.map((v) => assertPaise(v)).reduce((a, b) => a + b, 0);
}