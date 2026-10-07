import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  calendarDaysBetween,
  isSameUtcDay,
  MS_PER_DAY,
  startOfUtcDay,
  toIsoDate,
} from '../../src/lib/dates.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('startOfUtcDay', () => {
  it('strips the time regardless of input offset', () => {
    expect(startOfUtcDay(new Date('2026-08-01T18:45:12.345Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole calendar days regardless of time of day', () => {
    // An evening check-in and a morning checkout is one day, not two.
    expect(calendarDaysBetween(new Date('2026-08-01T18:00:00Z'), new Date('2026-08-02T09:00:00Z'))).toBe(1);
    expect(calendarDaysBetween(new Date('2026-08-01T01:00:00Z'), new Date('2026-08-02T23:00:00Z'))).toBe(1);
  });

  it('counts real month lengths', () => {
    expect(calendarDaysBetween(d('2026-01-31'), d('2026-02-28'))).toBe(28);
    expect(calendarDaysBetween(d('2026-08-01'), d('2026-09-01'))).toBe(31);
    expect(calendarDaysBetween(d('2026-08-01'), d('2026-08-02'))).toBe(1);
  });

  it('is zero for the same day', () => {
    expect(calendarDaysBetween(d('2026-08-01'), d('2026-08-01'))).toBe(0);
  });

  it('goes negative when reversed', () => {
    expect(calendarDaysBetween(d('2026-08-02'), d('2026-08-01'))).toBe(-1);
  });

  it('handles a leap year', () => {
    expect(calendarDaysBetween(d('2028-02-01'), d('2028-03-01'))).toBe(29);
  });
});

describe('addDays', () => {
  it('adds whole days', () => {
    expect(toIsoDate(addDays(d('2026-08-01'), 5))).toBe('2026-08-06');
  });

  it('crosses a month boundary', () => {
    expect(toIsoDate(addDays(d('2026-08-30'), 3))).toBe('2026-09-02');
  });

  it('crosses a year boundary', () => {
    expect(toIsoDate(addDays(d('2026-12-30'), 3))).toBe('2027-01-02');
  });

  it('handles a leap day', () => {
    expect(toIsoDate(addDays(d('2028-02-28'), 1))).toBe('2028-02-29');
    expect(toIsoDate(addDays(d('2028-02-29'), 1))).toBe('2028-03-01');
  });

  it('rejects a fractional day count', () => {
    expect(() => addDays(d('2026-08-01'), 1.5)).toThrow(TypeError);
  });
});

describe('addMonths', () => {
  it('adds whole months', () => {
    expect(toIsoDate(addMonths(d('2026-08-01'), 1))).toBe('2026-09-01');
    expect(toIsoDate(addMonths(d('2026-08-15'), 3))).toBe('2026-11-15');
  });

  it('clamps a 31st to the last day of a shorter month instead of rolling over', () => {
    // Rolling over would charge a student two extra days of rent.
    expect(toIsoDate(addMonths(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(d('2026-03-31'), 1))).toBe('2026-04-30');
    expect(toIsoDate(addMonths(d('2026-01-31'), 3))).toBe('2026-04-30');
  });

  it('keeps 31 January for a target month that has 31 days', () => {
    expect(toIsoDate(addMonths(d('2026-01-31'), 5))).toBe('2026-06-30');
    expect(toIsoDate(addMonths(d('2026-01-15'), 7))).toBe('2026-08-15');
  });

  it('handles a leap-year February', () => {
    expect(toIsoDate(addMonths(d('2028-01-31'), 1))).toBe('2028-02-29');
  });

  it('crosses a year boundary', () => {
    expect(toIsoDate(addMonths(d('2026-11-15'), 3))).toBe('2027-02-15');
  });

  it('accepts zero and negative months', () => {
    expect(toIsoDate(addMonths(d('2026-08-15'), 0))).toBe('2026-08-15');
    expect(toIsoDate(addMonths(d('2026-08-15'), -1))).toBe('2026-07-15');
  });

  it('rejects a fractional month count', () => {
    expect(() => addMonths(d('2026-08-01'), 1.5)).toThrow(TypeError);
  });
});

describe('isSameUtcDay', () => {
  it('ignores time of day', () => {
    expect(isSameUtcDay(new Date('2026-08-01T00:01:00Z'), new Date('2026-08-01T23:59:00Z'))).toBe(true);
  });

  it('is false across days', () => {
    expect(isSameUtcDay(d('2026-08-01'), d('2026-08-02'))).toBe(false);
  });
});

describe('toIsoDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(toIsoDate(new Date('2026-08-01T18:00:00Z'))).toBe('2026-08-01');
  });
});

describe('MS_PER_DAY', () => {
  it('is 24 hours', () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});