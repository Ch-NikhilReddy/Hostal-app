/** Shapes returned by the API. Mirrors the route handlers in `api/src/modules`. */

export type Role = 'STUDENT' | 'OWNER' | 'ADMIN';
export type Gender = 'MALE' | 'FEMALE' | 'MIXED';
export type StayType = 'MONTHLY' | 'SHORT_STAY' | 'DAY_STAY';
export type SharingType = 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'FOUR_OR_MORE';
export type VerificationStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export type BookingStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_OWNER'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'CANCELLED_BY_STUDENT'
  | 'CANCELLED_BY_OWNER'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'REFUNDED'
  | 'EXPIRED';

export type User = {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  role: Role;
  verified: boolean;
  collegeId?: string | null;
  ownerProfile?: {
    id: string;
    businessName: string;
    verificationStatus: VerificationStatus;
    commissionOverrideBps?: number | null;
  } | null;
};

export type College = {
  id: string;
  name: string;
  slug: string;
  city: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  hostelCount?: number;
};

export type RoomTypeSummary = {
  id: string;
  name: string;
  sharingType: SharingType;
  gender: Gender;
  monthlyRent: number;
  shortStayDailyRent: number | null;
  dayStayDailyRent: number | null;
  depositAmount: number | null;
  foodCharges: number | null;
  availableBeds?: number | null;
  totalBeds?: number | null;
};

export type HostelSearchResult = {
  id: string;
  name: string;
  slug: string;
  type: string;
  gender: Gender;
  area: string;
  city: string;
  addressLine: string;
  latitude: number;
  longitude: number;
  photos: string[];
  amenities: string[];
  foodIncluded: boolean;
  depositAmount: number;
  ratingAverage: number | null;
  ratingCount: number;
  reviewCount: number;
  college: { id: string; name: string; slug: string } | null;
  distanceKm: number | null;
  travelMinutes: number | null;
  minMonthlyRent: number | null;
  maxMonthlyRent: number | null;
  roomTypes: RoomTypeSummary[];
};

export type SearchResponse = {
  origin?: { name: string };
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  results: HostelSearchResult[];
};

export type HostelDetail = {
  hostel: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    type: string;
    gender: Gender;
    addressLine: string;
    area: string;
    city: string;
    pincode: string | null;
    latitude: number;
    longitude: number;
    contactPhone?: string | null;
    amenities: string[];
    photos: string[];
    foodIncluded: boolean;
    depositAmount: number;
    noticePeriodDays: number;
    ratingAverage: number | null;
    ratingCount: number;
    reviewCount: number;
    verificationStatus: VerificationStatus;
    published: boolean;
    isVisible: boolean;
    college: { id: string; name: string; slug: string } | null;
    roomTypes: RoomTypeSummary[];
  };
  verificationStatus: VerificationStatus;
  published: boolean;
};

/** Money breakdown. Every field is PAISE. */
export type QuoteAmounts = {
  baseRent: number;
  foodCharges: number;
  depositAmount: number;
  serviceFee: number;
  taxes: number;
  discountAmount: number;
  commissionAmount: number;
  ownerPayout: number;
  totalAmount: number;
  rentSubtotal: number;
};

export type QuoteResponse = {
  quote: {
    stayType: StayType;
    checkIn: string;
    checkOut: string;
    months: number;
    days: number;
    amounts: QuoteAmounts;
    totalsInRupees: {
      totalAmount: number;
      rentSubtotal: number;
      depositAmount: number;
    };
  };
  hostel: { id: string; name: string; slug: string; addressLine: string; area: string };
  roomType: { id: string; name: string; sharingType: SharingType; monthlyRent: number };
  availableBeds: { id: string; label: string; floorLabel: string | null }[];
  availableBedCount: number;
};

export type Booking = {
  id: string;
  bookingRef: string;
  stayType: StayType;
  checkIn: string;
  checkOut: string;
  months: number;
  days: number;
  status: BookingStatus;
  baseRent: number;
  foodCharges: number;
  depositAmount: number;
  commissionAmount: number;
  commissionRateBps: number;
  ownerPayout: number;
  totalAmount: number;
  heldUntil?: string | null;
  confirmedAt?: string | null;
  cancelReason?: string | null;
  createdAt: string;
  hostel: {
    id: string;
    name: string;
    slug: string;
    addressLine: string;
    area: string;
    latitude: number;
    longitude: number;
    photos: string[];
    contactPhone?: string | null;
  };
  roomType: { id: string; name: string; sharingType: SharingType };
  bed: { id: string; label: string; floorLabel: string | null };
  payment?: { status: string; amount: number; method?: string | null; capturedAt?: string | null } | null;
  statusHistory?: { toStatus: BookingStatus; actorRole: string; reason?: string | null; createdAt: string }[];
};

export type Notification = {
  id: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

export type OwnerDashboard = {
  verificationStatus: VerificationStatus;
  hostels: { id: string; name: string; published: boolean; verificationStatus: VerificationStatus }[];
  pendingApprovals: number;
  currentlyCheckedIn: number;
  earnings: {
    bookingCount: number;
    grossPaise: number;
    commissionPaise: number;
    payoutPaise: number;
    depositHeldPaise: number;
  };
  commissionRateBps: number;
  beds: { total: number; available: number; occupied: number; maintenance: number };
};