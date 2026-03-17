import { create } from "zustand";
import { THEME_KEY } from "@/lib/constants";

type Theme = "dark" | "light" | "system";

interface UiStore {
  theme: Theme;
  sidebarOpen: boolean;
  setTheme: (theme: Theme) => void;
  cycleTheme: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#09090b" : "#ffffff");
}

const stored = (localStorage.getItem(THEME_KEY) as Theme) ?? "dark";
applyTheme(stored);

// Listen for system theme changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const current = (localStorage.getItem(THEME_KEY) as Theme) ?? "dark";
  if (current === "system") applyTheme("system");
});

export const useUiStore = create<UiStore>((set, get) => ({
  theme: stored,
  sidebarOpen: false,

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  cycleTheme: () => {
    const order: Theme[] = ["dark", "light", "system"];
    const next = order[(order.indexOf(get().theme) + 1) % order.length];
    get().setTheme(next);
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
