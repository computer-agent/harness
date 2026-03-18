/**
 * Environment variable safety — controls what env vars are visible to shell subprocesses.
 *
 * By default, shell subprocesses get ONLY a safe allowlist of system vars.
 * Agent-specific env values (from dotenvx .env) are injected separately
 * and do NOT include process.env secrets like ANTHROPIC_API_KEY.
 */

const SAFE_ENV_KEYS = ["PATH", "HOME", "TERM", "TZ", "LANG", "USER"] as const;

/**
 * Build a safe environment for shell subprocesses.
 *
 * Starts from an empty env, adds only allowlisted system vars,
 * then merges agent-specific env values (from dotenvx).
 * process.env secrets (ANTHROPIC_API_KEY, etc.) are never included.
 */
export function buildShellEnv(agentEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // TZ fallback: use Intl if not set in process.env
  if (!env.TZ) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) env.TZ = tz;
  }

  // Merge agent-specific env (from dotenvx .env decryption).
  // DOTENV_PRIVATE_KEY is excluded — it's the decryption key, not an app secret.
  for (const [key, val] of Object.entries(agentEnv)) {
    if (key === "DOTENV_PRIVATE_KEY") continue;
    env[key] = val;
  }

  return env;
}
