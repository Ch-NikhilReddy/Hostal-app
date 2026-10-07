/**
 * API client.
 *
 * Money note: the API speaks paise everywhere (integers). This module is the ONE
 * place that converts to rupees for display. Every screen formats through
 * `formatRupees`, so there is a single rounding decision in the app rather than
 * one per screen — the same rule the API enforces on its side.
 */

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Message safe to show a student on a phone. */
  get userMessage(): string {
    return this.message;
  }

  /** True when the user must sign in again. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

// ---- Token storage ---------------------------------------------------------
//
// Access and refresh tokens are held in SecureStore (Android Keystore), not
// AsyncStorage. The refresh token is long-lived and grants a new session; storing
// it in plain text on the device would mean any backup or rooted-app read is a
// permanent account compromise.

let accessToken: string | null = null;
let refreshToken: string | null = null;
let onTokenRefresh: ((access: string, refresh: string) => Promise<void>) | null = null;

export function setTokenHandlers(handlers: {
  onAccess: (token: string | null) => Promise<void>;
  onRefresh: (token: string | null) => Promise<void>;
  persist: (access: string, refresh: string) => Promise<void>;
  load: () => Promise<{ access: string | null; refresh: string | null }>;
}) {
  onTokenRefresh = handlers.persist;
  void (async () => {
    const stored = await handlers.load();
    accessToken = stored.access;
    refreshToken = stored.refresh;
  })();
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access;
  refreshToken = refresh;
  if (access && refresh) {
    void onTokenRefresh?.(access, refresh);
  }
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

// ---- Core request ----------------------------------------------------------

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Internal: prevents an infinite refresh loop. */
  _isRetry?: boolean;
};

/**
 * One in-flight refresh at a time.
 *
 * If five screens each get a 401 at once, five parallel refresh calls would be
 * issued. Because the API ROTATES refresh tokens, four of those would present an
 * already-revoked token and fail, signing the user out mid-session. So the promise
 * is shared: everyone waits on the same refresh, then retries.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        // A dead refresh token means a real sign-out. Anything less (a 500) is
        // transient and should not discard a valid session.
        if (res.status === 401) clearTokens();
        return false;
      }

      const json = (await res.json()) as { accessToken: string; refreshToken: string };
      setTokens(json.accessToken, json.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, _isRetry } = options;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A network failure is not an API error; it gets its own message because
    // "you are offline" is actionable and "something went wrong" is not.
    throw new ApiError(0, 'NETWORK_ERROR', 'No connection. Check your internet and try again.');
  }

  if (res.status === 401 && !_isRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, { ...options, _isRetry: true });
    }
    clearTokens();
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.details,
    );
  }

  return json as T;
}

// ---- Display formatting ----------------------------------------------------

/** Paise to a rupee string. The only place this conversion happens. */
export function formatRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/** Compact form for tight spaces, e.g. "₹8.5k". */
export function formatRupeesCompact(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}k`;
  return `₹${rupees.toLocaleString('en-IN')}`;
}

export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export { BASE_URL };