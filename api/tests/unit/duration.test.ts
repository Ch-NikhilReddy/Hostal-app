import { describe, expect, it } from 'vitest';
import {
  MAX_DURATION_MS,
  assertDuration,
  expiryFromNow,
  parseDurationMs,
  parseDurationSeconds,
} from '../../src/lib/duration.js';
import { AppError } from '../../src/lib/errors.js';

/**
 * Regression tests for C-2.
 *
 * The bug: `Number.parseInt(value, 10) * 86_400_000` discards the unit, so
 * every duration was treated as days. `12h` became 12 days. Each test below
 * fails against that implementation.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('parseDurationMs — the exact values from the audit', () => {
  it('30d -> 30 days', () => {
    expect(parseDurationMs('30d')).toBe(30 * DAY);
  });

  it('12h -> 12 hours (was 12 DAYS before the fix)', () => {
    expect(parseDurationMs('12h')).toBe(12 * HOUR);
    // The regression assertion, stated explicitly.
    expect(parseDurationMs('12h')).not.toBe(12 * DAY);
  });

  it('60m -> 60 minutes', () => {
    expect(parseDurationMs('60m')).toBe(60 * MINUTE);
  });

  it('30s -> 30 seconds', () => {
    expect(parseDurationMs('30s')).toBe(30 * SECOND);
  });

  it('500ms -> 500 milliseconds', () => {
    expect(parseDurationMs('500ms')).toBe(500);
  });
});

describe('parseDurationMs — unit table', () => {
  const table: [string, number][] = [
    ['1ms', 1],
    ['999ms', 999],
    ['1s', SECOND],
    ['59s', 59 * SECOND],
    ['1m', MINUTE],
    ['90m', 90 * MINUTE],
    ['1h', HOUR],
    ['23h', 23 * HOUR],
    ['1d', DAY],
    ['7d', 7 * DAY],
    ['30d', 30 * DAY],
  ];

  for (const [input, expected] of table) {
    it(`${input} -> ${expected}ms`, () => {
      expect(parseDurationMs(input)).toBe(expected);
    });
  }
});

describe('parseDurationMs — rejects malformed input', () => {
  const bad: string[] = [
    'invalid',
    'abc',
    '30x',
    'd30',
    'm30',
    '30',
    '3600',
    '1.5h',
    '30 d',
    'd',
    'ms',
    '30DD',
    '1d1h',
    '30h!',
  ];

  for (const input of bad) {
    it(`rejects "${input}"`, () => {
      expect(() => parseDurationMs(input)).toThrowError(AppError);
    });
  }

  it('rejects a unitless number rather than guessing', () => {
    // ms('3600') is 3600 MILLISECONDS in the library jsonwebtoken uses, so a bare
    // number is ambiguous between "3600 seconds" and "3.6 seconds". Requiring a
    // unit removes the guess.
    expect(() => parseDurationMs('3600')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DURATION' }) as unknown as AppError,
    );
  });
});

describe('parseDurationMs — rejects empty input', () => {
  for (const input of ['', '   ', '\t', '\n']) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseDurationMs(input)).toThrowError(
        expect.objectContaining({ code: 'INVALID_DURATION' }) as unknown as AppError,
      );
    });
  }

  it('rejects a non-string at runtime', () => {
    // Guards a config typo that yields undefined rather than a string.
    expect(() => parseDurationMs(undefined as unknown as string)).toThrowError(AppError);
    expect(() => parseDurationMs(null as unknown as string)).toThrowError(AppError);
    expect(() => parseDurationMs(15 as unknown as string)).toThrowError(AppError);
  });
});

describe('parseDurationMs — rejects negative durations', () => {
  for (const input of ['-1h', '-30d', '-500ms']) {
    it(`rejects "${input}" with a message naming the problem`, () => {
      expect(() => parseDurationMs(input)).toThrowError(/must be positive/);
    });
  }
});

describe('parseDurationMs — rejects zero durations', () => {
  for (const input of ['0ms', '0s', '0m', '0h', '0d']) {
    it(`rejects "${input}" — an already-expired token is never intended`, () => {
      expect(() => parseDurationMs(input)).toThrowError(/greater than zero/);
    });
  }
});

describe('parseDurationMs — bounds', () => {
  it('accepts exactly the maximum', () => {
    expect(parseDurationMs('90d')).toBe(MAX_DURATION_MS);
  });

  it('rejects beyond the maximum', () => {
    expect(() => parseDurationMs('91d')).toThrowError(/exceeds the maximum/);
    expect(() => parseDurationMs('300d')).toThrowError(/exceeds the maximum/);
  });

  it('rejects a value too large to represent as a safe integer', () => {
    expect(() => parseDurationMs('99999999999999999999d')).toThrowError(AppError);
  });
});

describe('parseDurationMs — whitespace tolerance', () => {
  it('trims surrounding whitespace', () => {
    expect(parseDurationMs('  30d  ')).toBe(30 * DAY);
    expect(parseDurationMs('12h ')).toBe(12 * HOUR);
  });

  it('does not accept internal whitespace', () => {
    expect(() => parseDurationMs('30 d')).toThrowError(AppError);
  });
});

describe('parseDurationSeconds', () => {
  it('converts to whole seconds for jsonwebtoken', () => {
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('30d')).toBe(2_592_000);
    expect(parseDurationSeconds('500ms')).toBe(0);
  });

  it('rounds sub-second remainders down rather than silently up', () => {
    // 1_500ms is 1 second with 500ms remaining. Rounding to 2 would extend the
    // token past the configured lifetime.
    expect(parseDurationSeconds('1500ms')).toBe(1);
  });
});

describe('expiryFromNow', () => {
  it('adds the duration to a supplied "now"', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = expiryFromNow('12h', now, 'TEST_TTL');
    expect(expiry.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('agrees with parseDurationMs to the millisecond', () => {
    const now = new Date('2026-06-15T10:30:00.000Z');
    for (const value of ['500ms', '30s', '60m', '12h', '30d']) {
      expect(expiryFromNow(value, now).getTime()).toBe(
        now.getTime() + parseDurationMs(value),
      );
    }
  });

  it('never disagrees with itself between "now" and default now', () => {
    const before = Date.now();
    const expiry = expiryFromNow('12h');
    const after = Date.now();
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + 12 * HOUR);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + 12 * HOUR);
  });
});

describe('assertDuration (startup validation)', () => {
  it('passes for valid values', () => {
    expect(() => assertDuration('15m', 'JWT_ACCESS_TTL')).not.toThrow();
    expect(() => assertDuration('30d', 'JWT_REFRESH_TTL')).not.toThrow();
  });

  it('throws with the variable name in the message', () => {
    // An operator seeing this at boot should know which variable to fix.
    expect(() => assertDuration('12', 'JWT_REFRESH_TTL')).toThrowError(/JWT_REFRESH_TTL/);
    expect(() => assertDuration('nope', 'JWT_ACCESS_TTL')).toThrowError(/JWT_ACCESS_TTL/);
  });
});

describe('the audit bug, stated as an executable assertion', () => {
  it('12h is not 12 days under any supported unit', () => {
    expect(parseDurationMs('12h')).toBe(HOUR * 12);
    expect(parseDurationMs('12d')).toBe(DAY * 12);
    expect(parseDurationMs('12h')).not.toBe(parseDurationMs('12d'));
  });

  it('the old formula would have produced a different answer', () => {
    // Reproduces the exact defect so the regression cannot silently return.
    const buggy = (v: string) => Number.parseInt(v, 10) * 86_400_000;

    expect(buggy('12h')).toBe(12 * DAY);
    expect(parseDurationMs('12h')).toBe(12 * HOUR);

    expect(buggy('60m')).toBe(60 * DAY);
    expect(parseDurationMs('60m')).toBe(60 * MINUTE);

    expect(buggy('30s')).toBe(30 * DAY);
    expect(parseDurationMs('30s')).toBe(30 * SECOND);

    expect(buggy('500ms')).toBe(500 * DAY);
    expect(parseDurationMs('500ms')).toBe(500);
  });

  it('30d is the one value both implementations agree on', () => {
    // Worth asserting: it explains why this bug survived to an audit. The default
    // refresh TTL was already "30d", so nobody had set an hour or minute value
    // where the defect was visible.
    expect(Number.parseInt('30d', 10) * 86_400_000).toBe(parseDurationMs('30d'));
  });
});