import { StayType } from '@prisma/client';
import { addDays, addMonths, calendarDaysBetween } from './dates.js';
import { applyBps, assertPaise, type Paise } from './money.js';
import { AppError } from './errors.js';

/**
 * Pricing for all three stay models against one bed.
 *
 * Every stay type is priced from a rate card rather than converted from the
 * monthly rent, because "a day stay is monthly/30" quietly loses money against
 * a hostel whose day rate is deliberately priced above the pro-rata equivalent
 * (short stays cost the owner more per occupied day: linen, cleaning, a lost
 * weekly tenant). So a missing rate means the stay type is not offered, and
 * says so, instead of silently falling back to a pro-rata guess.
 */

export const LIMITS = {
  MAX_MONTHS: 12,
  MIN_SHORT_STAY_DAYS: 1,
  MAX_SHORT_STAY_DAYS: 29,
  DAY_STAY_DAYS: 1,
} as const;

/** Days in a "month" for pro-rating food on short stays. 30 is the PG convention. */
export const DAYS_PER_MONTH = 30;

export type RateCard = {
  monthlyRent: Paise;
  shortStayDailyRent: Paise | null;
  dayStayDailyRent: Paise | null;
  /** Per-bed food charge per MONTH, already resolved through the room-type -> hostel fallback. */
  monthlyFoodCharges: Paise | null;
  depositAmount: Paise;
};

export type StayInput = {
  stayType: StayType;
  checkIn: Date;
  /** MONTHLY: 1..LIMITS.MAX_MONTHS */
  months?: number | undefined;
  /** SHORT_STAY: 1..LIMITS.MAX_SHORT_STAY_DAYS. DAY_STAY: must be 1. */
  days?: number | undefined;
};

export type PriceQuoteInput = {
  stay: StayInput;
  rates: RateCard;
  commissionBps: number;
  /** Platform service fee, bps. Defaults to 0 — the MVP charges none. */
  serviceFeeBps?: number;
  /** Tax on (rent + food), bps. Defaults to 0; PG rent GST sits with the owner. */
  taxBps?: number;
  /** Promotion in paise. Never exceeds the rent subtotal. */
  discountAmount?: Paise;
};

export type PriceQuote = {
  stayType: StayType;
  checkIn: Date;
  checkOut: Date;
  months: number;
  days: number;

  baseRent: Paise;
  foodCharges: Paise;
  depositAmount: Paise;
  serviceFee: Paise;
  taxes: Paise;
  discountAmount: Paise;

  commissionRateBps: number;
  commissionAmount: Paise;
  ownerPayout: Paise;

  /** baseRent + foodCharges + depositAmount + serviceFee + taxes - discountAmount */
  totalAmount: Paise;

  /** Rent + food, before deposit and before anything the platform retains. */
  rentSubtotal: Paise;
};

function resolveDuration(stay: StayInput): { months: number; days: number; checkOut: Date } {
  const { stayType, checkIn } = stay;

  if (Number.isNaN(checkIn.getTime())) {
    throw AppError.badRequest('INVALID_CHECK_IN', 'checkIn is not a valid date.');
  }

  switch (stayType) {
    case StayType.MONTHLY: {
      const months = stay.months;
      // typeof first: Number.isInteger(undefined) is false but does not narrow the
      // type, so the range check below would still see `number | undefined`.
      if (typeof months !== 'number' || !Number.isInteger(months)) {
        throw AppError.badRequest('MONTHS_REQUIRED', 'A monthly stay needs a whole number of months.');
      }
      if (months < 1 || months > LIMITS.MAX_MONTHS) {
        throw AppError.badRequest(
          'MONTHS_OUT_OF_RANGE',
          `A monthly stay must be between 1 and ${LIMITS.MAX_MONTHS} months.`,
        );
      }
      // addMonths clamps to the end of a short month, so a 31 Jan check-in for
      // one month leaves on 28 Feb rather than rolling into March.
      const checkOut = addMonths(checkIn, months);
      return { months, days: calendarDaysBetween(checkIn, checkOut), checkOut };
    }

    case StayType.SHORT_STAY: {
      const days = stay.days;
      if (typeof days !== 'number' || !Number.isInteger(days)) {
        throw AppError.badRequest('DAYS_REQUIRED', 'A short stay needs a whole number of days.');
      }
      if (days < LIMITS.MIN_SHORT_STAY_DAYS || days > LIMITS.MAX_SHORT_STAY_DAYS) {
        throw AppError.badRequest(
          'DAYS_OUT_OF_RANGE',
          `A short stay must be between ${LIMITS.MIN_SHORT_STAY_DAYS} and ${LIMITS.MAX_SHORT_STAY_DAYS} days. ` +
            `For a stay of 30 days or more, book monthly.`,
        );
      }
      const checkOut = addDays(checkIn, days);
      return { months: 0, days, checkOut };
    }

    case StayType.DAY_STAY: {
      const days = stay.days ?? LIMITS.DAY_STAY_DAYS;
      if (days !== LIMITS.DAY_STAY_DAYS) {
        throw AppError.badRequest('DAY_STAY_DAYS_FIXED', 'A day stay is exactly one day.');
      }
      const checkOut = addDays(checkIn, days);
      return { months: 0, days, checkOut };
    }

    default: {
      const exhaustive: never = stayType;
      throw AppError.badRequest('UNKNOWN_STAY_TYPE', `Unsupported stay type: ${String(exhaustive)}`);
    }
  }
}

function resolveBaseRent(stay: StayInput, rates: RateCard, days: number): Paise {
  switch (stay.stayType) {
    case StayType.MONTHLY:
      return assertPaise(rates.monthlyRent) * (stay.months ?? 1);

    case StayType.SHORT_STAY: {
      if (rates.shortStayDailyRent === null || rates.shortStayDailyRent === undefined) {
        throw AppError.unprocessable(
          'SHORT_STAY_UNAVAILABLE',
          'This hostel does not offer short stays.',
        );
      }
      return rates.shortStayDailyRent * days;
    }

    case StayType.DAY_STAY: {
      if (rates.dayStayDailyRent === null || rates.dayStayDailyRent === undefined) {
        throw AppError.unprocessable(
          'DAY_STAY_UNAVAILABLE',
          'This hostel does not offer day stays.',
        );
      }
      return rates.dayStayDailyRent * LIMITS.DAY_STAY_DAYS;
    }

    default:
      throw AppError.badRequest('UNKNOWN_STAY_TYPE', 'Unsupported stay type.');
  }
}

/**
 * Quote a stay. Pure: no database, no clock, no side effects. The caller passes
 * in the resolved deposit and commission rate, which is what makes the pricing
 * reproducible from a stored booking row after the fact.
 */
export function quotePrice(input: PriceQuoteInput): PriceQuote {
  const { rates, commissionBps } = input;
  const serviceFeeBps = input.serviceFeeBps ?? 0;
  const taxBps = input.taxBps ?? 0;
  const discountAmount = assertPaise(input.discountAmount ?? 0, 'discountAmount');

  const { months, days, checkOut } = resolveDuration(input.stay);
  const baseRent = assertPaise(resolveBaseRent(input.stay, rates, days), 'baseRent');

  if (baseRent < 0) {
    throw AppError.unprocessable('INVALID_RATE', 'This hostel has an invalid rate configured.');
  }

  // Food is quoted monthly and pro-rated by day for short and day stays, rounded
  // to the nearest paise so the sum of the components stays integral.
  const foodCharges =
    rates.monthlyFoodCharges && rates.monthlyFoodCharges > 0
      ? Math.round((rates.monthlyFoodCharges * (months > 0 ? months : days / DAYS_PER_MONTH)))
      : 0;

  const depositAmount = assertPaise(Math.max(0, rates.depositAmount), 'depositAmount');

  const rentSubtotal = baseRent + foodCharges;

  if (discountAmount > rentSubtotal) {
    throw AppError.unprocessable(
      'DISCOUNT_EXCEEDS_RENT',
      'The discount cannot be larger than the rent.',
    );
  }

  const commissionAmount = applyBps(rentSubtotal, commissionBps);
  const serviceFee = applyBps(rentSubtotal, serviceFeeBps);
  const taxes = applyBps(rentSubtotal, taxBps);

  // The owner is paid rent plus food, less the platform's commission. Deposit is
  // never part of it: it is the student's money held against damage, and paying
  // it to the owner would mean the platform is holding a security deposit on
  // the owner's behalf without any regulatory basis for doing so.
  const ownerPayout = rentSubtotal - commissionAmount;

  const totalAmount = rentSubtotal + depositAmount + serviceFee + taxes - discountAmount;

  if (totalAmount < 0) {
    throw AppError.unprocessable('NEGATIVE_TOTAL', 'The computed total is negative.');
  }

  const quote: PriceQuote = {
    stayType: input.stay.stayType,
    checkIn: input.stay.checkIn,
    checkOut,
    months,
    days,
    baseRent,
    foodCharges,
    depositAmount,
    serviceFee,
    taxes,
    discountAmount,
    commissionRateBps: commissionBps,
    commissionAmount,
    ownerPayout,
    totalAmount,
    rentSubtotal,
  };

  verifyQuote(quote);
  return quote;
}

/**
 * Invariant check, run on every quote before it is returned.
 *
 * A booking whose parts do not sum to its total is the class of bug that shows
 * up as a support ticket weeks later ("you charged me the wrong amount"), and it
 * is caught here for pennies rather than in production for a rupee.
 */
export function verifyQuote(q: PriceQuote): void {
  const sum = q.baseRent + q.foodCharges + q.depositAmount + q.serviceFee + q.taxes - q.discountAmount;
  if (sum !== q.totalAmount) {
    throw new Error(
      `Pricing invariant violated: components sum to ${sum} but totalAmount is ${q.totalAmount}`,
    );
  }
  if (q.rentSubtotal !== q.baseRent + q.foodCharges) {
    throw new Error('Pricing invariant violated: rentSubtotal mismatch.');
  }
  if (q.ownerPayout !== q.rentSubtotal - q.commissionAmount) {
    throw new Error('Pricing invariant violated: ownerPayout is not rent less commission.');
  }
  if (q.ownerPayout < 0) {
    throw new Error('Pricing invariant violated: commission exceeds rent, ownerPayout is negative.');
  }
  for (const [key, value] of Object.entries(q)) {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error(`Pricing invariant violated: ${key} is not an integer (${value}).`);
    }
  }
}

/** Resolve the rate card from a room type, applying the hostel-level fallbacks. */
export function resolveRateCard(input: {
  monthlyRent: number;
  shortStayDailyRent: number | null;
  dayStayDailyRent: number | null;
  depositAmount: number | null;
  foodCharges: number | null;
  hostelDepositAmount: number;
  hostelFoodIncluded: boolean;
}): RateCard {
  return {
    monthlyRent: input.monthlyRent,
    shortStayDailyRent: input.shortStayDailyRent,
    dayStayDailyRent: input.dayStayDailyRent,
    depositAmount: input.depositAmount ?? input.hostelDepositAmount,
    monthlyFoodCharges:
      input.foodCharges !== null && input.foodCharges !== undefined
        ? input.foodCharges
        : input.hostelFoodIncluded
          ? 0 // included in rent: nothing extra to charge
          : 0,
  };
}