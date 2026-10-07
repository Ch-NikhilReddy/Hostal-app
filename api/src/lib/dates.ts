/**
 * Date helpers for stay arithmetic.
 *
 * All stay boundaries are stored as UTC timestamps. A PG contract runs on
 * calendar days, not on 24-hour windows from a clock, so a check-in at 18:00
 * and a check-out at 09:00 the next day is a charge for two days of occupancy
 * regardless of the hours involved. Everything below therefore works on
 * whole UTC calendar days.
 */

export const MS_PER_DAY = 86_400_000;

/** Strip the time component, returning midnight UTC of the given date. */
export function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Whole calendar days between two instants, ignoring time of day. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = startOfUtcDay(from).getTime();
  const b = startOfUtcDay(to).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

/** Add whole days in UTC. */
export function addDays(date: Date, days: number): Date {
  if (!Number.isInteger(days)) throw new TypeError(`days must be an integer, received: ${days}`);
  return new Date(startOfUtcDay(date).getTime() + days * MS_PER_DAY);
}

/**
 * Add calendar months, clamping the day of month rather than rolling over.
 * A student checking in on 31 January for one month leaves on 28 February, not
 * 2 or 3 March. Rolling over would silently charge an extra two days.
 */
export function addMonths(date: Date, months: number): Date {
  if (!Number.isInteger(months)) throw new TypeError(`months must be an integer, received: ${months}`);
  const base = startOfUtcDay(date);
  const targetDay = base.getUTCDate();
  const shifted = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1, 0, 0, 0, 0),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(targetDay, lastDayOfTargetMonth));
  return shifted;
}

/** True when two instants fall on the same UTC calendar day. */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime();
}

export function toIsoDate(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}