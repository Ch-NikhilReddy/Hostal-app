import { describe, expect, it } from 'vitest';
import { StayType } from '@prisma/client';
import { AppError } from '../../src/lib/errors.js';
import {
  DAYS_PER_MONTH,
  LIMITS,
  quotePrice,
  resolveRateCard,
  verifyQuote,
  type RateCard,
} from '../../src/lib/pricing.js';
import { rupeesToPaise } from '../../src/lib/money.js';

const rates = (over: Partial<RateCard> = {}): RateCard => ({
  monthlyRent: rupeesToPaise(8500),
  shortStayDailyRent: rupeesToPaise(450),
  dayStayDailyRent: rupeesToPaise(400),
  monthlyFoodCharges: null,
  depositAmount: rupeesToPaise(10000),
  ...over,
});

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('quotePrice — monthly', () => {
  it('multiplies the monthly rent by the number of months', () => {
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 3 },
      rates: rates(),
      commissionBps: 1000,
    });

    expect(q.baseRent).toBe(rupeesToPaise(8500 * 3));
    expect(q.months).toBe(3);
    expect(q.totalAmount).toBe(q.baseRent + q.depositAmount);
  });

  it('charges the deposit once regardless of duration', () => {
    const one = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates(),
      commissionBps: 0,
    });
    const twelve = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 12 },
      rates: rates(),
      commissionBps: 0,
    });

    expect(twelve.depositAmount).toBe(one.depositAmount);
    expect(twelve.baseRent).toBe(one.baseRent * 12);
  });

  it('clamps a month-end check-in to the end of a shorter month', () => {
    // 31 Jan + 1 month must land on 28 Feb 2026, never rolling into March and
    // silently billing the student for two extra days.
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-01-31'), months: 1 },
      rates: rates(),
      commissionBps: 0,
    });

    expect(q.checkOut.toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(q.days).toBe(28);
  });

  it('rejects zero, negative and over-max months', () => {
    const cases: [number | undefined, string][] = [
      [undefined, 'MONTHS_REQUIRED'],
      [0, 'MONTHS_OUT_OF_RANGE'],
      [LIMITS.MAX_MONTHS + 1, 'MONTHS_OUT_OF_RANGE'],
    ];

    for (const [months, code] of cases) {
      expect(() =>
        quotePrice({
          stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months },
          rates: rates(),
          commissionBps: 0,
        }),
      ).toThrowError(
        expect.objectContaining({ code }) as unknown as AppError,
      );
    }
  });
});

describe('quotePrice — short stay and day stay', () => {
  it('prices a short stay by its own daily rate, not a pro-rata of monthly', () => {
    // A hostel may deliberately price a short stay above monthly/30. The engine
    // must use the stated rate rather than second-guessing it.
    const q = quotePrice({
      stay: { stayType: StayType.SHORT_STAY, checkIn: d('2026-08-01'), days: 5 },
      rates: rates(),
      commissionBps: 0,
    });

    expect(q.baseRent).toBe(rupeesToPaise(450 * 5));
    expect(q.days).toBe(5);
  });

  it('refuses a short stay when the hostel does not offer one', () => {
    expect(() =>
      quotePrice({
        stay: { stayType: StayType.SHORT_STAY, checkIn: d('2026-08-01'), days: 3 },
        rates: rates({ shortStayDailyRent: null }),
        commissionBps: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SHORT_STAY_UNAVAILABLE' }) as unknown as AppError);
  });

  it('refuses a day stay when the hostel does not offer one', () => {
    expect(() =>
      quotePrice({
        stay: { stayType: StayType.DAY_STAY, checkIn: d('2026-08-01') },
        rates: rates({ dayStayDailyRent: null }),
        commissionBps: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DAY_STAY_UNAVAILABLE' }) as unknown as AppError);
  });

  it('rejects a 30-day "short stay" and points at the monthly option', () => {
    // 30 days is a month in PG terms; treating it as a short stay would let a
    // student dodge the monthly rate by asking for 29 days and topping up.
    expect(() =>
      quotePrice({
        stay: { stayType: StayType.SHORT_STAY, checkIn: d('2026-08-01'), days: 30 },
        rates: rates(),
        commissionBps: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DAYS_OUT_OF_RANGE' }) as unknown as AppError);
  });

  it('rejects a day stay longer than one day', () => {
    expect(() =>
      quotePrice({
        stay: { stayType: StayType.DAY_STAY, checkIn: d('2026-08-01'), days: 2 },
        rates: rates(),
        commissionBps: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DAY_STAY_DAYS_FIXED' }) as unknown as AppError);
  });

  it('pro-rates food by day for short stays', () => {
    const q = quotePrice({
      stay: { stayType: StayType.SHORT_STAY, checkIn: d('2026-08-01'), days: 15 },
      rates: rates({ monthlyFoodCharges: rupeesToPaise(3000) }),
      commissionBps: 0,
    });

    expect(q.foodCharges).toBe(Math.round(rupeesToPaise(3000) * (15 / DAYS_PER_MONTH)));
  });
});

describe('commission', () => {
  it('takes commission from rent plus food, never from the deposit', () => {
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 2 },
      rates: rates({ monthlyFoodCharges: rupeesToPaise(3000) }),
      commissionBps: 1000,
    });

    const rentSubtotal = rupeesToPaise(8500 * 2) + rupeesToPaise(3000 * 2);
    expect(q.commissionAmount).toBe(Math.floor((rentSubtotal * 1000 + 5000) / 10000));

    // The owner must never receive any part of the security deposit.
    expect(q.ownerPayout).toBe(rentSubtotal - q.commissionAmount);
    expect(q.ownerPayout).not.toBe(q.totalAmount - q.commissionAmount);
  });

  it('rounds half up rather than down', () => {
    // 10% of 1,005 paise = 100.5 paise. Rounding down loses half a paisa per
    // booking, which accumulates into a settlement ledger that does not reconcile.
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates({ monthlyRent: 1005, depositAmount: 0, monthlyFoodCharges: null }),
      commissionBps: 1000,
    });

    expect(q.commissionAmount).toBe(101);
  });

  it('charges no commission at 0 bps', () => {
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates(),
      commissionBps: 0,
    });

    expect(q.commissionAmount).toBe(0);
    expect(q.ownerPayout).toBe(q.baseRent);
  });

  it('is invariant to the deposit amount', () => {
    const cheap = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates({ depositAmount: 0 }),
      commissionBps: 1500,
    });
    const dear = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates({ depositAmount: rupeesToPaise(50000) }),
      commissionBps: 1500,
    });

    expect(dear.commissionAmount).toBe(cheap.commissionAmount);
  });
});

describe('quotePrice — invariants', () => {
  const stayTypes: [StayType, { months?: number; days?: number }][] = [
    [StayType.MONTHLY, { months: 1 }],
    [StayType.MONTHLY, { months: 12 }],
    [StayType.SHORT_STAY, { days: 1 }],
    [StayType.SHORT_STAY, { days: 29 }],
    [StayType.DAY_STAY, {}],
  ];

  it('keeps every component an integer and the parts summing to the total', () => {
    for (const [stayType, extra] of stayTypes) {
      for (const commissionBps of [0, 1000, 1500, 333, 10000]) {
        const q = quotePrice({
          stay: { stayType, checkIn: d('2026-08-01'), ...extra },
          rates: rates({ monthlyFoodCharges: rupeesToPaise(2999) }),
          commissionBps,
        });

        expect(() => verifyQuote(q), `${stayType} @ ${commissionBps}bps`).not.toThrow();

        for (const [key, value] of Object.entries(q)) {
          if (typeof value === 'number') {
            expect(Number.isInteger(value), `${stayType}.${key}`).toBe(true);
          }
        }
      }
    }
  });

  it('rejects a discount larger than the rent', () => {
    expect(() =>
      quotePrice({
        stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
        rates: rates(),
        commissionBps: 0,
        discountAmount: rupeesToPaise(999999),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_RENT' }) as unknown as AppError);
  });

  it('applies a valid discount and keeps the total consistent', () => {
    const q = quotePrice({
      stay: { stayType: StayType.MONTHLY, checkIn: d('2026-08-01'), months: 1 },
      rates: rates(),
      commissionBps: 0,
      discountAmount: rupeesToPaise(500),
    });

    expect(q.discountAmount).toBe(rupeesToPaise(500));
    expect(q.totalAmount).toBe(q.baseRent + q.depositAmount - q.discountAmount);
  });
});

describe('resolveRateCard', () => {
  it('falls back to the hostel deposit when the room type has none', () => {
    const card = resolveRateCard({
      monthlyRent: rupeesToPaise(8500),
      shortStayDailyRent: null,
      dayStayDailyRent: null,
      depositAmount: null,
      foodCharges: null,
      hostelDepositAmount: rupeesToPaise(7000),
      hostelFoodIncluded: false,
    });

    expect(card.depositAmount).toBe(rupeesToPaise(7000));
  });

  it('prefers the room type deposit over the hostel default', () => {
    const card = resolveRateCard({
      monthlyRent: rupeesToPaise(8500),
      shortStayDailyRent: null,
      dayStayDailyRent: null,
      depositAmount: rupeesToPaise(9000),
      foodCharges: null,
      hostelDepositAmount: rupeesToPaise(7000),
      hostelFoodIncluded: false,
    });

    expect(card.depositAmount).toBe(rupeesToPaise(9000));
  });

  it('charges no extra food when the hostel bundles meals into the rent', () => {
    const card = resolveRateCard({
      monthlyRent: rupeesToPaise(8500),
      shortStayDailyRent: null,
      dayStayDailyRent: null,
      depositAmount: null,
      foodCharges: null,
      hostelDepositAmount: 0,
      hostelFoodIncluded: true,
    });

    expect(card.monthlyFoodCharges).toBe(0);
  });
});