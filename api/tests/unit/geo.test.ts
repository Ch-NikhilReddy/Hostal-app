import { describe, expect, it } from 'vitest';
import { boundingBox, estimateTravelMinutes, haversineKm } from '../../src/lib/geo.js';

/** Reference points in Hyderabad, used as both origin and target. */
const OU = { lat: 17.3086, lng: 78.4405 };
const JNTUH = { lat: 17.322, lng: 78.2337 };
const CBIT = { lat: 17.3206, lng: 78.3796 };

describe('haversineKm', () => {
  it('returns zero for identical points', () => {
    expect(haversineKm(OU.lat, OU.lng, OU.lat, OU.lng)).toBe(0);
  });

  it('is symmetric', () => {
    const ab = haversineKm(OU.lat, OU.lng, JNTUH.lat, JNTUH.lng);
    const ba = haversineKm(JNTUH.lat, JNTUH.lng, OU.lat, OU.lng);
    expect(ab).toBeCloseTo(ba, 9);
  });

  it('measures a plausible distance across Hyderabad', () => {
    // OU to JNTUH is roughly 22 km in reality. This asserts the formula is
    // correct in magnitude, which a wrong earth radius or degree conversion would
    // break immediately.
    const km = haversineKm(OU.lat, OU.lng, JNTUH.lat, JNTUH.lng);
    expect(km).toBeGreaterThan(15);
    expect(km).toBeLessThan(30);
  });

  it('is smaller for a nearer pair', () => {
    const near = haversineKm(OU.lat, OU.lng, CBIT.lat, CBIT.lng);
    const far = haversineKm(OU.lat, OU.lng, JNTUH.lat, JNTUH.lng);
    expect(near).toBeLessThan(far);
  });

  it('handles antipodal points without NaN', () => {
    const km = haversineKm(0, 0, 0, 180);
    expect(Number.isFinite(km)).toBe(true);
    expect(km).toBeGreaterThan(20000);
  });
});

describe('boundingBox', () => {
  it('always contains the origin', () => {
    const box = boundingBox(OU.lat, OU.lng, 5);
    expect(box.minLat).toBeLessThanOrEqual(OU.lat);
    expect(box.maxLat).toBeGreaterThanOrEqual(OU.lat);
    expect(box.minLng).toBeLessThanOrEqual(OU.lng);
    expect(box.maxLng).toBeGreaterThanOrEqual(OU.lng);
  });

  it('grows with radius', () => {
    const small = boundingBox(OU.lat, OU.lng, 2);
    const large = boundingBox(OU.lat, OU.lng, 20);
    expect(large.maxLat - large.minLat).toBeGreaterThan(small.maxLat - small.minLat);
  });

  it('never excludes a point inside the radius', () => {
    // This is the safety property the SQL prefilter relies on: anything within the
    // true radius must fall inside the box, or the query silently drops matches.
    const radiusKm = 5;
    const box = boundingBox(OU.lat, OU.lng, radiusKm);

    for (const [dx, dy] of [
      [0.045, 0],
      [-0.045, 0],
      [0, 0.046],
      [0, -0.046],
      [0.03, 0.03],
    ] as const) {
      const lat = OU.lat + dx;
      const lng = OU.lng + dy;
      const distance = haversineKm(OU.lat, OU.lng, lat, lng);

      if (distance <= radiusKm) {
        expect(lat).toBeGreaterThanOrEqual(box.minLat);
        expect(lat).toBeLessThanOrEqual(box.maxLat);
        expect(lng).toBeGreaterThanOrEqual(box.minLng);
        expect(lng).toBeLessThanOrEqual(box.maxLng);
      }
    }
  });

  it('produces finite bounds near the poles instead of NaN', () => {
    // cos(90°) is ~0, so a naive lngDelta divides by zero.
    const box = boundingBox(89.9, 0, 5);
    expect(Number.isFinite(box.minLng)).toBe(true);
    expect(Number.isFinite(box.maxLng)).toBe(true);
    expect(Number.isFinite(box.minLat)).toBe(true);
  });
});

describe('estimateTravelMinutes', () => {
  it('scales with distance', () => {
    const short = estimateTravelMinutes(2);
    const long = estimateTravelMinutes(20);
    expect(long).toBeGreaterThan(short);
  });

  it('returns a whole number', () => {
    expect(Number.isInteger(estimateTravelMinutes(7.3))).toBe(true);
  });

  it('returns zero for zero distance', () => {
    expect(estimateTravelMinutes(0)).toBe(0);
  });

  it('is faster by car than on foot for the same distance', () => {
    expect(estimateTravelMinutes(5, 'auto')).toBeLessThan(estimateTravelMinutes(5, 'walk'));
  });
});