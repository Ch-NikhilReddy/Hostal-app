/** Mean great-circle distance in kilometres, haversine. */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding box around a point, used to prefilter rows in SQL before doing
 * precise haversine in JS.
 *
 * The box is deliberately generous (1 degree latitude is roughly 111 km). A
 * row outside the box is always farther away than the radius being searched,
 * so the filter cannot drop a true match; it only removes the rows that were
 * never candidates. Doing this is what makes "hostels within 5 km" a single
 * indexed query instead of a full table scan.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 111.32;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Near the poles the longitude delta explodes; clamp the divisor so this
  // degrades to "return everything" instead of producing NaN bounds.
  const safeCos = Math.abs(cos) < 1e-6 ? 1e-6 : Math.abs(cos);
  const lngDelta = radiusKm / (111.32 * safeCos);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** Rough walking-feet/minutes estimate. Advisory only; the app shows distance. */
export function estimateTravelMinutes(distanceKm: number, mode: 'walk' | 'auto' = 'auto'): number {
  const kmPerHour = mode === 'walk' ? 4.5 : 18;
  return Math.round((distanceKm / kmPerHour) * 60);
}