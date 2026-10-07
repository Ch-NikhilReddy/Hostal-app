import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { clearTokens, getAccessToken, setTokenHandlers, setTokens } from '@/api/client';
import { getMe, logout as apiLogout, requestOtp, verifyOtp } from '@/api/endpoints';
import type { Role, User } from '@/api/types';

const ACCESS_KEY = 'hm_access_token';
const REFRESH_KEY = 'hm_refresh_token';

type AuthState = {
  user: User | null;
  /** null until the persisted session has been read from SecureStore. */
  isBootstrapping: boolean;
  isAuthenticating: boolean;
  error: string | null;
  /** Only set in development, so the OTP can be entered without SMS. */
  devOtp: string | null;

  bootstrap: () => Promise<void>;
  startLogin: (phone: string) => Promise<boolean>;
  completeLogin: (input: { phone: string; code: string; name?: string; registerRole?: 'STUDENT' | 'OWNER' }) => Promise<boolean>;
  refreshUser: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
  clearDevOtp: () => void;
};

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  isBootstrapping: true,
  isAuthenticating: false,
  error: null,
  devOtp: null,

  /**
   * Restore a persisted session on cold start.
   *
   * Without this the app would ask for an OTP on every launch despite a valid
   * refresh token, which for a student opening the app on a phone-data connection
   * is a real cost.
   */
  bootstrap: async () => {
    const state = get();
    if (!state.isBootstrapping) return;

    const hasToken = Boolean(getAccessToken());
    if (!hasToken) {
      set({ isBootstrapping: false });
      return;
    }

    try {
      const { user } = await getMe();
      set({ user, isBootstrapping: false });
    } catch {
      // A 401 here means the refresh token expired and the client already cleared
      // it. Anything else (offline) keeps the user signed in optimistically, so a
      // flaky network does not log someone out.
      set({ isBootstrapping: false });
    }
  },

  startLogin: async (phone) => {
    set({ isAuthenticating: true, error: null, devOtp: null });
    try {
      const res = await requestOtp(phone);
      set({ isAuthenticating: false, devOtp: res.devOtp ?? null });
      return true;
    } catch (err) {
      set({
        isAuthenticating: false,
        error: err instanceof Error ? err.message : 'Could not send the code. Try again.',
      });
      return false;
    }
  },

  completeLogin: async ({ phone, code, name, registerRole }) => {
    set({ isAuthenticating: true, error: null });
    try {
      const res = await verifyOtp({ phone, code, name, registerRole });
      setTokens(res.accessToken, res.refreshToken);
      set({ user: res.user, isAuthenticating: false, devOtp: null });
      return true;
    } catch (err) {
      set({
        isAuthenticating: false,
        error: err instanceof Error ? err.message : 'That code did not work. Try again.',
      });
      return false;
    }
  },

  refreshUser: async () => {
    try {
      const { user } = await getMe();
      set({ user });
    } catch {
      // Non-fatal: the screen keeps the last known user.
    }
  },

  signOut: async () => {
    try {
      const stored = await SecureStore.getItemAsync(REFRESH_KEY);
      if (stored) await apiLogout(stored);
    } catch {
      // A failed server-side logout must not trap the user in the app; clearing
      // the local session is what they asked for.
    } finally {
      clearTokens();
      await Promise.all([
        SecureStore.deleteItemAsync(ACCESS_KEY),
        SecureStore.deleteItemAsync(REFRESH_KEY),
      ]).catch(() => undefined);
      set({ user: null, devOtp: null, error: null });
    }
  },

  clearError: () => set({ error: null }),
  clearDevOtp: () => set({ devOtp: null }),
}));

// Wire the token store once, at module load. Anything that calls setTokens()
// persists automatically from here on.
setTokenHandlers({
  persist: async (access, refresh) => {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, access),
      SecureStore.setItemAsync(REFRESH_KEY, refresh),
    ]);
  },
  load: async () => ({
    access: await SecureStore.getItemAsync(ACCESS_KEY),
    refresh: await SecureStore.getItemAsync(REFRESH_KEY),
  }),
  onAccess: async () => undefined,
  onRefresh: async () => undefined,
});

/** Whether the signed-in user should see the owner experience. */
export function hasOwnerRole(user: User | null): boolean {
  return user?.role === ('OWNER' satisfies Role) || user?.role === ('ADMIN' satisfies Role);
}