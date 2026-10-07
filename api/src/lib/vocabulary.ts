/**
 * Fixed vocabulary.
 *
 * Amenities are a closed list rather than free text. A student filtering for
 * "Wi-Fi" must match a hostel tagged "wifi", and only an enum guarantees that;
 * with free text, "WiFi", "wifi", "Wi-Fi" and "Free WiFi" become four distinct
 * filters and the feature quietly returns nothing. Adding an amenity is a code
 * change on purpose — it means the app, the owner form and the filter sheet stay
 * in agreement.
 */

export const AMENITIES = [
  'wifi',
  'attached_bathroom',
  'ac',
  'non_ac',
  'geyser',
  'laundry',
  'meal_included',
  'meals_available',
  'fridge',
  'tv',
  'desk',
  'wardrobe',
  'balcony',
  'power_backup',
  'lift',
  'security',
  'cctv',
  'gym',
  'housekeeping',
  'hot_water',
  'study_room',
  'common_room',
  'bike_parking',
  'wifi_speed_100mbps',
] as const;

export type Amenity = (typeof AMENITIES)[number];

const AMENITY_SET = new Set<string>(AMENITIES);

export function isAmenity(value: string): value is Amenity {
  return AMENITY_SET.has(value);
}

/** Filter out anything not on the list, rather than 400-ing a whole search. */
export function sanitiseAmenities(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.filter(isAmenity))];
}

export const HYDERABAD_AREAS = [
  'Gachibowli',
  'Hitech City',
  'Kukatpally',
  'Kondapur',
  'Madhapur',
  'Kukatpally/Serilingampalle',
  'Miyapur',
  'Ameerpet',
  'Begumpet',
  'Koramangala',
  'Jubilee Hills',
  'Banjara Hills',
  'Himayatnagar',
  'Charminar',
  'Uppal',
  'LB Nagar',
  'Ramanthapur',
  'Shamshabad',
  'Kompally',
  'Balanagar',
  'Nizampet',
  'Yousufguda',
  'Dilsukhnagar',
  'Nacharam',
  'Chandapur',
  'Medchal',
  'Serilingampalle',
  'Jagadishguda',
  'Attapur',
  'Bandlaguda',
  'Saroornagar',
  'Gaddiannara',
  'Raidurg',
  'Kokapet',
  'Gachibowli Financial District',
] as const;