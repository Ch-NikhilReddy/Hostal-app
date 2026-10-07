/**
 * Design tokens.
 *
 * One palette, referenced by name everywhere. Hostel listings are compared in a
 * grid and a student's eye jumps between them constantly, so consistent colour
 * meaning matters more than decoration: teal is the brand and every primary
 * action, amber always means "pending", red always means "cancelled or lost".
 */

export const colors = {
  // Brand — teal reads as calm and trustworthy, which suits an accommodation
  // product where the user is committing to a home rather than a purchase.
  primary: '#0F766E',
  primaryDark: '#115E59',
  primaryLight: '#14B8A6',
  primaryFaint: '#CCFBF1',

  surface: '#FFFFFF',
  background: '#F8FAFC',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',

  text: '#0F172A',
  textMuted: '#64748B',
  textFaint: '#94A3B8',
  textInverse: '#FFFFFF',

  success: '#059669',
  successFaint: '#D1FAE5',
  warning: '#D97706',
  warningFaint: '#FEF3C7',
  danger: '#DC2626',
  dangerFaint: '#FEE2E2',
  info: '#2563EB',
  infoFaint: '#DBEAFE',

  overlay: 'rgba(15, 23, 42, 0.55)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
  xxxl: 32,
} as const;

/**
 * Booking status -> colour and label.
 *
 * Centralised so a status can never be rendered inconsistently between "My
 * Bookings" and the owner queue. PENDING_* both mean "waiting on someone" and
 * share the amber treatment.
 */
export const statusStyle: Record<
  string,
  { label: string; color: string; background: string }
> = {
  PENDING_PAYMENT: { label: 'Awaiting payment', color: colors.warning, background: colors.warningFaint },
  PENDING_OWNER: { label: 'Awaiting hostel', color: colors.warning, background: colors.warningFaint },
  CONFIRMED: { label: 'Confirmed', color: colors.success, background: colors.successFaint },
  CHECKED_IN: { label: 'Checked in', color: colors.info, background: colors.infoFaint },
  CHECKED_OUT: { label: 'Completed', color: colors.textMuted, background: '#F1F5F9' },
  CANCELLED_BY_STUDENT: { label: 'Cancelled by you', color: colors.danger, background: colors.dangerFaint },
  CANCELLED_BY_OWNER: { label: 'Cancelled by hostel', color: colors.danger, background: colors.dangerFaint },
  REJECTED: { label: 'Declined', color: colors.danger, background: colors.dangerFaint },
  REFUNDED: { label: 'Refunded', color: colors.textMuted, background: '#F1F5F9' },
  EXPIRED: { label: 'Expired', color: colors.textFaint, background: '#F1F5F9' },
};

/** Amenity keys -> human labels. Mirrors the API's closed vocabulary. */
export const AMENITY_LABELS: Record<string, string> = {
  wifi: 'Wi-Fi',
  attached_bathroom: 'Attached bath',
  ac: 'AC',
  non_ac: 'Non-AC',
  geyser: 'Geyser',
  laundry: 'Laundry',
  meal_included: 'Meals included',
  meals_available: 'Meals available',
  fridge: 'Fridge',
  tv: 'TV',
  desk: 'Study desk',
  wardrobe: 'Wardrobe',
  balcony: 'Balcony',
  power_backup: 'Power backup',
  lift: 'Lift',
  security: 'Security',
  cctv: 'CCTV',
  gym: 'Gym',
  housekeeping: 'Housekeeping',
  hot_water: 'Hot water',
  study_room: 'Study room',
  common_room: 'Common room',
  bike_parking: 'Bike parking',
  wifi_speed_100mbps: '100 Mbps Wi-Fi',
};

export const SHARING_LABELS: Record<string, string> = {
  SINGLE: 'Single',
  DOUBLE: '2-sharing',
  TRIPLE: '3-sharing',
  FOUR_OR_MORE: '4+ sharing',
};

export const GENDER_LABELS: Record<string, string> = {
  MALE: 'Boys',
  FEMALE: 'Girls',
  MIXED: 'Co-ed',
};