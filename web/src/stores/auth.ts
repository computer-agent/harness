import { create } from "zustand";
import { api } from "@/lib/api";
import { TOKEN_KEY } from "@/lib/constants";

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
  token: localStorage.getItem(TOKEN_KEY),
  isValidated: false,
  isValidating: false,
  error: null,

  setToken: (token: string) => {
    localStorage.setItem(TOKEN_KEY, token);
    // Don't set isValidated here — wait for validate() to confirm
    set({ token, error: null, isValidated: false });
  },

  clearToken: () => {
    localStorage.removeItem(TOKEN_KEY);
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
