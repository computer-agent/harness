import { API_URL, TOKEN_KEY } from "./constants";

function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Custom error for rate limiting, carries the Retry-After seconds */
export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(seconds: number) {
    super(`rate_limited:${seconds}`);
    this.name = "RateLimitError";
    this.retryAfterSeconds = seconds;
  }
}

/** Custom error for network failures (fetch threw before we got a response) */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

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
      signal: opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new NetworkError(`Request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new NetworkError(err instanceof Error ? err.message : "Network request failed");
  }
  clearTimeout(timeoutId);

  if (res.status === 401 || res.status === 403) {
    throw new Error("auth_failed");
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : 60;
    throw new RateLimitError(Number.isNaN(seconds) ? 60 : seconds);
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
