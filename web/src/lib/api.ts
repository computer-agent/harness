import { API_URL, TOKEN_KEY } from "./constants";

function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...opts,
      headers,
      signal: opts.signal
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new Error(`Request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (res.status === 401 || res.status === 403) {
    throw new Error("auth_failed");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  try {
    return await res.json();
  } catch {
    throw new Error(`Invalid JSON in response from ${path}`);
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
