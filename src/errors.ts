/**
 * Error classification for better diagnostics.
 *
 * Maps raw SDK / API / network errors to actionable user-facing messages.
 */

export interface ClassifiedError {
  category: "auth" | "rate_limit" | "overloaded" | "network" | "invalid_request" | "server" | "unknown";
  message: string;
  suggestion: string;
}

const patterns: Array<{
  test: (msg: string, status?: number) => boolean;
  classify: () => Omit<ClassifiedError, "message">;
}> = [
  {
    test: (msg, status) =>
      status === 401 ||
      /unauthorized|authentication|invalid.*api.key|invalid.*token|expired.*token|expired.*credential/i.test(msg),
    classify: () => ({
      category: "auth",
      suggestion: "Run 'claude login' to refresh credentials, or check your ANTHROPIC_API_KEY.",
    }),
  },
  {
    test: (msg, status) =>
      status === 403 || /forbidden|permission denied|access denied|insufficient.*scope/i.test(msg),
    classify: () => ({
      category: "auth",
      suggestion:
        "Your credentials may lack the required scopes. Run 'claude login' to re-authenticate.",
    }),
  },
  {
    test: (msg, status) => status === 429 || /rate.limit|too many requests|throttl/i.test(msg),
    classify: () => ({
      category: "rate_limit",
      suggestion: "Wait a moment and try again. If persistent, check your plan's rate limits.",
    }),
  },
  {
    test: (msg, status) => status === 529 || /overloaded|capacity/i.test(msg),
    classify: () => ({
      category: "overloaded",
      suggestion: "The API is temporarily overloaded. Wait a minute and try again.",
    }),
  },
  {
    test: (msg, status) =>
      (status !== undefined && status >= 500 && status < 600) ||
      /internal server error|bad gateway|service unavailable/i.test(msg),
    classify: () => ({
      category: "server",
      suggestion: "Upstream API error. Check https://status.anthropic.com and retry shortly.",
    }),
  },
  {
    test: (msg) =>
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i.test(msg),
    classify: () => ({
      category: "network",
      suggestion: "Check your internet connection and any proxy/firewall settings.",
    }),
  },
  {
    test: (msg, status) => status === 400 || /invalid.*request|bad request|validation/i.test(msg),
    classify: () => ({
      category: "invalid_request",
      suggestion: "The request was rejected by the API. Check agent config and model name.",
    }),
  },
];

/**
 * Classify an error into an actionable category with a suggestion.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.code;
  const numericStatus = typeof status === "number" ? status : undefined;

  for (const p of patterns) {
    if (p.test(message, numericStatus)) {
      return { message, ...p.classify() };
    }
  }

  return {
    category: "unknown",
    message,
    suggestion: "Check the stderr log for details. If the problem persists, file an issue.",
  };
}

/**
 * Format a classified error for terminal output.
 */
export function formatError(err: unknown): string {
  const classified = classifyError(err);
  const lines = [`Error: ${classified.message}`, "", `  ${classified.suggestion}`];
  return lines.join("\n");
}

/**
 * Format a classified error for TUI display (single line with hint).
 */
export function formatErrorShort(err: unknown): string {
  const classified = classifyError(err);
  return `${classified.message}\n${classified.suggestion}`;
}
