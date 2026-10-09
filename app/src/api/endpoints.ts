import { api, request } from './client';
import type {
  Booking,
  College,
  HostelDetail,
  Notification,
  OwnerDashboard,
  QuoteResponse,
  Role,
  SearchResponse,
  StayType,
  User,
} from './types';

// ---- Auth ------------------------------------------------------------------

/**
 * Request an OTP.
 *
 * The API returns `devOtp` in development only. Surfaced here (rather than
 * ignored) so the flow is usable on a fresh checkout with no SMS provider; in a
 * production build the field is absent.
 */
export async function requestOtp(phone: string) {
  return request<{ ok: true; expiresInSeconds: number; devOtp?: string }>('/v1/auth/otp/request', {
    method: 'POST',
    body: { phone },
  });
}

export async function verifyOtp(input: {
  phone: string;
  code: string;
  name?: string;
  collegeId?: string;
  registerRole?: Extract<Role, 'STUDENT' | 'OWNER'>;
}) {
  return request<{ accessToken: string; refreshToken: string; user: User }>('/v1/auth/otp/verify', {
    method: 'POST',
    body: input,
  });
}

export async function logout(refreshToken: string) {
  return api.post('/v1/auth/logout', { refreshToken });
}

export async function getMe() {
  return api.get<{ user: User }>('/v1/auth/me');
}

export async function updateMe(input: { name?: string; collegeId?: string; email?: string }) {
  return api.patch<{ user: User }>('/v1/auth/me', input);
}

export async function registerPushToken(token: string, platform: 'android' | 'ios' | 'web') {
  return api.post('/v1/auth/push-token', { token, platform });
}

// ---- Catalog ---------------------------------------------------------------

export async function listColleges(city = 'Hyderabad') {
  return api.get<{ colleges: College[] }>(`/v1/colleges?city=${encodeURIComponent(city)}`);
}

export async function getCollege(idOrSlug: string) {
  return api.get<{ college: College }>(`/v1/colleges/${encodeURIComponent(idOrSlug)}`);
}

export type SearchParams = {
  search?: string;
  collegeId?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  area?: string;
  gender?: string;
  sharingType?: string;
  stayType?: StayType;
  amenities?: string[];
  foodIncluded?: boolean;
  minRent?: number;
  maxRent?: number;
  checkIn?: string;
  checkOut?: string;
  sort?: 'distance' | 'price_asc' | 'price_desc' | 'rating' | 'newest';
  page?: number;
  pageSize?: number;
};

/**
 * Build a query string.
 *
 * Empty values are omitted rather than sent as `undefined`/`''` — the API
 * validates strictly, and `?maxRent=` is a 400 whereas an absent key is a valid
 * unfiltered search.
 */
export function buildSearchQuery(params: SearchParams): string {
  const q = new URLSearchParams();

  if (params.search) q.set('search', params.search);
  if (params.collegeId) q.set('collegeId', params.collegeId);
  if (params.lat !== undefined) q.set('lat', String(params.lat));
  if (params.lng !== undefined) q.set('lng', String(params.lng));
  if (params.radiusKm !== undefined) q.set('radiusKm', String(params.radiusKm));
  if (params.area) q.set('area', params.area);
  if (params.gender) q.set('gender', params.gender);
  if (params.sharingType) q.set('sharingType', params.sharingType);
  if (params.stayType) q.set('stayType', params.stayType);
  if (params.amenities?.length) q.set('amenities', params.amenities.join(','));
  if (params.foodIncluded !== undefined) q.set('foodIncluded', String(params.foodIncluded));
  if (params.minRent !== undefined) q.set('minRent', String(params.minRent));
  if (params.maxRent !== undefined) q.set('maxRent', String(params.maxRent));
  if (params.checkIn) q.set('checkIn', params.checkIn);
  if (params.checkOut) q.set('checkOut', params.checkOut);
  if (params.sort) q.set('sort', params.sort);
  if (params.page !== undefined) q.set('page', String(params.page));
  if (params.pageSize !== undefined) q.set('pageSize', String(params.pageSize));

  return q.toString();
}

export async function searchHostels(params: SearchParams) {
  return api.get<SearchResponse>(`/v1/hostels?${buildSearchQuery(params)}`);
}

export async function getHostel(slugOrId: string) {
  return api.get<HostelDetail>(`/v1/hostels/${encodeURIComponent(slugOrId)}`);
}

export async function getAvailability(
  slugOrId: string,
  input: { roomTypeId: string; checkIn: string; checkOut: string },
) {
  const q = buildSearchQuery(input as SearchParams);
  return api.get<{ beds: { id: string; label: string; floorLabel: string | null }[] }>(
    `/v1/hostels/${encodeURIComponent(slugOrId)}/availability?${q}`,
  );
}

// ---- Bookings --------------------------------------------------------------

export type StayInput = {
  roomTypeId: string;
  stayType: StayType;
  checkIn: string;
  months?: number;
  days?: number;
};

export async function quoteStay(input: StayInput) {
  return api.post<QuoteResponse>('/v1/bookings/quote', input);
}

export async function createBooking(input: StayInput & { bedId: string; notes?: string }) {
  return api.post<{
    bookingRef: string;
    status: string;
    amount: number;
    heldUntil: string;
    payment: { provider: string; orderId: string; keyId?: string; amount: number; currency: string };
    quote: QuoteResponse['quote'];
  }>('/v1/bookings', input);
}

export async function confirmPayment(bookingRef: string, paymentId: string, signature?: string) {
  return api.post<{ ok: true; status: string; alreadyCaptured?: boolean }>(
    `/v1/bookings/${bookingRef}/pay`,
    { paymentId, signature },
  );
}

export async function listBookings(params: { status?: string; upcoming?: boolean } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.upcoming) q.set('upcoming', 'true');
  const suffix = q.toString() ? `?${q}` : '';
  return api.get<{ bookings: Booking[]; total: number }>(`/v1/bookings${suffix}`);
}

export async function getBooking(bookingRef: string) {
  return api.get<{ booking: Booking }>(`/v1/bookings/${bookingRef}`);
}

export async function cancelBooking(bookingRef: string, reason: string) {
  // `refundEligible` is gone. The API used to return it as true whenever a payment was
  // captured, but no refund is ever issued automatically — there is no refund route,
  // no gateway refund call and no reconciliation entry. The flag told a student their
  // money would come back on the strength of a boolean nothing acted on.
  //
  // `paymentTaken` is the fact the server can actually stand behind, and `message`
  // now points at support rather than promising an outcome. Do not reintroduce a
  // refund flag here: when refunds exist, this should return the status of a real
  // refund record.
  return api.post<{
    ok: true;
    status: string;
    paymentTaken: boolean;
    noticePeriodDays: number;
    message: string;
  }>(`/v1/bookings/${bookingRef}/cancel`, { reason });
}

// ---- Owner -----------------------------------------------------------------

export async function getOwnerDashboard() {
  return api.get<OwnerDashboard>('/v1/owner/dashboard');
}

export async function respondToBooking(bookingRef: string, action: 'accept' | 'decline', reason?: string) {
  return api.post<{ ok: true; status: string }>(`/v1/bookings/${bookingRef}/respond`, {
    action,
    reason,
  });
}

export async function setBookingLifecycle(bookingRef: string, action: 'check-in' | 'check-out') {
  return api.post<{ ok: true; status: string }>(`/v1/bookings/${bookingRef}/lifecycle`, { action });
}

export async function getOwnerVerification() {
  return api.get<{
    verificationStatus: string;
    verifiedAt: string | null;
    rejectionReason: string | null;
    commissionOverrideBps: number | null;
    documents: { id: string; type: string; name: string | null; status: string }[];
    checklist: { type: string; uploaded: boolean; done: boolean }[];
    hostels: { id: string; name: string; verificationStatus: string; published: boolean }[];
    canPublish: boolean;
  }>('/v1/owner/verification');
}

// ---- Notifications ---------------------------------------------------------

export async function listNotifications(unreadOnly = false) {
  const q = unreadOnly ? '?unreadOnly=true' : '';
  return api.get<{ notifications: Notification[]; unreadCount: number; total: number }>(
    `/v1/notifications${q}`,
  );
}

export async function markNotificationsRead(ids?: string[]) {
  return api.post<{ ok: true; updated: number }>('/v1/notifications/read', ids ? { ids } : {});
}