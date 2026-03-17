export const API_URL = import.meta.env.VITE_API_URL ?? "";
export const WS_URL =
  import.meta.env.VITE_WS_URL ?? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
export const SKIP_AUTH = import.meta.env.VITE_SKIP_AUTH === "true";
export const TOKEN_KEY = "mastersof-ai-token";
export const THEME_KEY = "mastersof-ai-theme";
