import { api } from './client';

export type Role = 'STUDENT' | 'OWNER' | 'ADMIN';
export type VerificationStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export type User = {
  id: string;
  name: string;
  phone: string;
  role: Role;
  verified: boolean;
  ownerProfile?: {
    id: string;
    businessName: string;
    verificationStatus: VerificationStatus;
    commissionOverrideBps: number | null;
  } | null;
};

export type Owner = {
  id: string;
  legalName: string;
  businessName: string;
  contactPhone: string;
  contactEmail: string | null;
  panLast4: string | null;
  gstin: string | null;
  bankAccountName: string | null;
  bankIfsc: string | null;
  upiId: string | null;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  rejectionReason: string | null;
  commissionOverrideBps: number | null;
  createdAt: string;
  userId: string;
  _count: { hostels: number; documents: number };
  documents: { id: string; type: string; url: string; name: string | null; status: string; rejectionReason: string | null }[];
};

export type Hostel = {
  id: string;
  name: string;
  slug: string;
  area: string;
  city: string;
  published: boolean;
  verificationStatus: VerificationStatus;
  photos: string[];
  ratingAverage: string | number | null;
  ratingCount: number;
  roomTypes: { id: string; name: string; monthlyRent: number; _count: { beds: number } }[];
  _count: { bookings: number };
};

export type Booking = {
  id: string;
  bookingRef: string;
  stayType: string;
  checkIn: string;
  checkOut: string;
  months: number;
  days: number;
  status: string;
  baseRent: number;
  foodCharges: number;
  depositAmount: number;
  commissionAmount: number;
  commissionRateBps: number;
  ownerPayout: number;
  totalAmount: number;
  createdAt: string;
  hostel: { id: string; name: string; area: string };
  roomType: { id: string; name: string };
  bed: { id: string; label: string };
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

export type AdminReport = {
  range: { from: string; to: string };
  totals: { grossRentPaise: number; commissionPaise: number; depositPaise: number };
  totalBookings: number;
  lostBookings: number;
  cancellationRate: number;
  bookingsByStatus: Record<string, number>;
  growth: { newOwners: number; newStudents: number };
  topHostels: {
    hostelId: string;
    name: string;
    area: string;
    bookings: number;
    payoutPaise: number;
    commissionPaise: number;
  }[];
  colleges: { id: string; name: string; hostelCount: number }[];
};

// ---- Auth ------------------------------------------------------------------

export async function requestOtp(phone: string) {
  return api.post<{ ok: true; devOtp?: string }>('/v1/auth/otp/request', { phone });
}

export async function verifyOtp(input: {
  phone: string;
  code: string;
  name?: string;
  registerRole?: 'OWNER';
}) {
  return api.post<{ accessToken: string; refreshToken: string; user: User }>('/v1/auth/otp/verify', input);
}

export async function getMe() {
  return api.get<{ user: User }>('/v1/auth/me');
}

export async function logout(refreshToken: string) {
  return api.post('/v1/auth/logout', { refreshToken });
}

// ---- Owner -----------------------------------------------------------------

export async function getOwnerDashboard() {
  return api.get<OwnerDashboard>('/v1/owner/dashboard');
}

export async function listOwnerHostels() {
  return api.get<{ hostels: Hostel[] }>('/v1/owner/hostels');
}

export async function getOwnerVerification() {
  return api.get<{
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    rejectionReason: string | null;
    commissionOverrideBps: number | null;
    documents: { id: string; type: string; url: string; name: string | null; status: string }[];
    checklist: { type: string; uploaded: boolean; done: boolean }[];
    hostels: { id: string; name: string; verificationStatus: VerificationStatus; published: boolean }[];
    canPublish: boolean;
  }>('/v1/owner/verification');
}

export async function listOwnerBookings(status?: string) {
  const q = status ? `?status=${status}` : '';
  return api.get<{ bookings: Booking[]; total: number }>(`/v1/bookings${q}`);
}

export async function respondToBooking(ref: string, action: 'accept' | 'decline', reason?: string) {
  return api.post<{ ok: true; status: string }>(`/v1/bookings/${ref}/respond`, { action, reason });
}

export async function setLifecycle(ref: string, action: 'check-in' | 'check-out') {
  return api.post<{ ok: true; status: string }>(`/v1/bookings/${ref}/lifecycle`, { action });
}

export async function publishHostel(id: string, published: boolean) {
  return api.patch<{ ok: boolean }>(`/v1/owner/hostels/${id}`, { published });
}

// ---- Admin -----------------------------------------------------------------

export async function listOwners(params: { status?: VerificationStatus; search?: string } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.search) q.set('search', params.search);
  const suffix = q.toString() ? `?${q}` : '';
  return api.get<{ owners: Owner[]; total: number }>(`/v1/admin/owners${suffix}`);
}

export async function verifyOwner(
  id: string,
  status: 'APPROVED' | 'REJECTED' | 'SUSPENDED',
  reason?: string,
) {
  return api.post<{ ok: true }>(`/v1/admin/owners/${id}/verify`, { status, reason });
}

export async function moderateHostel(
  id: string,
  status: 'APPROVED' | 'REJECTED' | 'SUSPENDED',
  published: boolean,
  reason?: string,
) {
  return api.post<{ ok: true }>(`/v1/admin/hostels/${id}/moderate`, { status, published, reason });
}

export async function getCommission() {
  return api.get<{
    active: { id: string; percentageBps: number; label: string; effectiveFrom: string } | null;
    history: { id: string; percentageBps: number; label: string; effectiveFrom: string; effectiveTo: string | null }[];
  }>('/v1/admin/commission');
}

export async function setCommission(percent: number, label: string) {
  return api.post<{ ok: true; percentageBps: number }>('/v1/admin/commission', { percent, label });
}

export async function setOwnerCommissionOverride(id: string, bps: number | null) {
  return api.post<{ ok: true }>(`/v1/admin/owners/${id}/commission-override`, {
    commissionOverrideBps: bps,
  });
}

export async function getAdminReport(range?: { from?: string; to?: string }) {
  const q = new URLSearchParams();
  if (range?.from) q.set('from', range.from);
  if (range?.to) q.set('to', range.to);
  const suffix = q.toString() ? `?${q}` : '';
  return api.get<AdminReport>(`/v1/admin/reports/overview${suffix}`);
}

export async function getSettlement(ownerId: string) {
  return api.get<{
    owner: { id: string; businessName: string; commissionOverrideBps: number | null };
    bookings: {
      bookingRef: string;
      createdAt: string;
      stayType: string;
      months: number;
      days: number;
      baseRent: number;
      foodCharges: number;
      commissionAmount: number;
      commissionRateBps: number;
      ownerPayout: number;
      depositAmount: number;
      status: string;
    }[];
  }>(`/v1/admin/owners/${ownerId}/settlement`);
}

export async function listColleges() {
  return api.get<{ colleges: { id: string; name: string; slug: string; hostelCount?: number }[] }>(
    '/v1/colleges',
  );
}