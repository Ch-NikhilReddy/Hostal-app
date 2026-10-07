import { describe, expect, it } from 'vitest';
import {
  applyBps,
  assertPaise,
  formatPaise,
  paiseToRupees,
  percentToBps,
  rupeesToPaise,
  sum,
} from '../../src/lib/money.js';

describe('assertPaise', () => {
  it('accepts integers including zero and negatives', () => {
    expect(assertPaise(0)).toBe(0);
    expect(assertPaise(-500)).toBe(-500);
  });

  it('rejects floats, NaN and Infinity', () => {
    // These are exactly the values float arithmetic on currency produces, and
    // exactly the values that must never reach a database column.
    expect(() => assertPaise(100.5)).toThrow(TypeError);
    expect(() => assertPaise(Number.NaN)).toThrow(TypeError);
    expect(() => assertPaise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects non-numbers', () => {
    expect(() => assertPaise('850000' as unknown)).toThrow(TypeError);
    expect(() => assertPaise(null as unknown)).toThrow(TypeError);
    expect(() => assertPaise(undefined as unknown)).toThrow(TypeError);
  });
});

describe('rupeesToPaise / paiseToRupees', () => {
  it('round-trips whole rupees', () => {
    expect(rupeesToPaise(8500)).toBe(850000);
    expect(paiseToRupees(850000)).toBe(8500);
  });

  it('rounds fractional rupees half up', () => {
    expect(rupeesToPaise(8.505)).toBe(851);
    expect(rupeesToPaise(8.504)).toBe(850);
  });

  it('never produces a float', () => {
    for (const r of [0, 1, 8.5, 123.45, 9999.99, 12345.67]) {
      expect(Number.isInteger(rupeesToPaise(r))).toBe(true);
    }
  });
});

describe('applyBps', () => {
  it('applies 10% correctly', () => {
    expect(applyBps(850000, 1000)).toBe(85000);
  });

  it('rounds half up, not to even', () => {
    // 1005 * 10% = 100.5. Half-even would give 100; the platform should not
    // round in its own favour on every booking.
    expect(applyBps(1005, 1000)).toBe(101);
    // 1015 * 10% = 101.5. Half-even would give 102; half-up also gives 102.
    expect(applyBps(1015, 1000)).toBe(102);
    // 1025 * 10% = 102.5. Half-even gives 102, half-up gives 103.
    expect(applyBps(1025, 1000)).toBe(103);
  });

  it('returns exactly zero at 0 bps', () => {
    expect(applyBps(850000, 0)).toBe(0);
  });

  it('is exact for 100%', () => {
    expect(applyBps(123456, 10000)).toBe(123456);
  });

  it('handles sub-paisa bps without collapsing to zero', () => {
    expect(applyBps(10000, 1)).toBe(1); // 0.01% of 10000 = 1
    expect(applyBps(1000, 1)).toBe(0); // genuinely rounds to nothing
  });

  it('rejects negative or fractional bps', () => {
    expect(() => applyBps(850000, -1)).toThrow(TypeError);
    expect(() => applyBps(850000, 100.5)).toThrow(TypeError);
  });

  it('rejects a float amount', () => {
    expect(() => applyBps(850.5 as number, 1000)).toThrow(TypeError);
  });
});

describe('percentToBps', () => {
  it('converts cleanly', () => {
    expect(percentToBps(10)).toBe(1000);
    expect(percentToBps(12.5)).toBe(1250);
    expect(percentToBps(0)).toBe(0);
  });

  it('rejects out-of-range percentages', () => {
    expect(() => percentToBps(-1)).toThrow(TypeError);
    expect(() => percentToBps(101)).toThrow(TypeError);
  });
});

describe('formatPaise', () => {
  it('uses Indian digit grouping', () => {
    expect(formatPaise(850000)).toContain('8,500');
  });

  it('shows two decimal places', () => {
    expect(formatPaise(850050)).toContain('8,500.50');
  });
});

describe('sum', () => {
  it('adds integers exactly', () => {
    expect(sum(1, 2, 3)).toBe(6);
    // The float trap: 0.1 + 0.2 !== 0.3. In paise the equivalent cannot happen.
    expect(sum(10, 20)).toBe(30);
  });

  it('rejects a float argument', () => {
    expect(() => sum(100, 0.5)).toThrow(TypeError);
  });
});