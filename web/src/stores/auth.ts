import { create } from "zustand";
import { api } from "@/lib/api";
import { TOKEN_KEY } from "@/lib/constants";

/** Whitelisted error keys that map to auth.* i18n translations */
export const VALID_AUTH_ERROR_KEYS = ["invalidToken"] as const;
export type AuthErrorKey = (typeof VALID_AUTH_ERROR_KEYS)[number];

interface AuthStore {
  token: string | null;
  isValidated: boolean;
  isValidating: boolean;
  error: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
  validate: () => Promise<boolean>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: (() => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  })(),
  isValidated: false,
  isValidating: false,
  error: null,

  setToken: (token: string) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // sessionStorage unavailable — token still set in-memory
    }
    // Don't set isValidated here — wait for validate() to confirm
    set({ token, error: null, isValidated: false });
  },

  clearToken: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // sessionStorage unavailable
    }
    set({ token: null, isValidated: false, error: null });
  },

  validate: async () => {
    const { token } = get();
    if (!token) return false;

    set({ isValidating: true, error: null });
    try {
      await api.get("/api/agents");
      set({ isValidating: false, isValidated: true });
      return true;
    } catch {
      set({ isValidating: false, isValidated: false, error: "invalidToken" });
      return false;
    }
  },
}));
