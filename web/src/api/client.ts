/**
 * Web API client for the owner dashboard and admin panel.
 *
 * Shares one money rule with the API: the wire format is paise, and
 * `formatRupees` is the only conversion to a human-readable string.
 *
 * Tokens live in localStorage here rather than SecureStore. That is a conscious
 * difference, not an oversight: this is an operator tool opened on a desktop, and
 * the owner dashboard is behind an owner/admin role check on every request. The
 * real defence is the server-side authorisation, not where the token sits. If this
 * ever gains a public-facing page, move to an httpOnly cookie.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export const AUTH_KEYS = { access: 'hm_web_access', refresh: 'hm_web_refresh' } as const;

export function loadTokens(): { access: string | null; refresh: string | null } {
  accessToken = localStorage.getItem(AUTH_KEYS.access);
  refreshToken = localStorage.getItem(AUTH_KEYS.refresh);
  return { access: accessToken, refresh: refreshToken };
}

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access;
  refreshToken = refresh;
  if (access) localStorage.setItem(AUTH_KEYS.access, access);
  else localStorage.removeItem(AUTH_KEYS.access);
  if (refresh) localStorage.setItem(AUTH_KEYS.refresh, refresh);
  else localStorage.removeItem(AUTH_KEYS.refresh);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Shared refresh so parallel 401s do not rotate the token twice. */
async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  if (!refreshToken) return false;

  refreshing = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        if (res.status === 401) setTokens(null, null);
        return false;
      }
      const json = (await res.json()) as { accessToken: string; refreshToken: string };
      setTokens(json.accessToken, json.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

async function request<T>(path: string, method = 'GET', body?: unknown, retry = true): Promise<T> {
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
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Is the API running on :4000?');
  }

  if (res.status === 401 && retry) {
    if (await tryRefresh()) return request<T>(path, method, body, false);
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? 'UNKNOWN',
      err?.error?.message ?? 'Something went wrong.',
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, 'POST', body),
  patch: <T>(path: string, body?: unknown) => request<T>(path, 'PATCH', body),
  delete: <T>(path: string) => request<T>(path, 'DELETE'),
};

export function formatRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function formatDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}