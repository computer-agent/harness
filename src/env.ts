import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenvx from "@dotenvx/dotenvx";

/**
 * Load per-agent .env file (encrypted or plaintext) without mutating process.env.
 * Returns the parsed key-value pairs for sandbox passthrough and tool injection.
 */
export function loadAgentEnv(agentDir: string): Record<string, string> {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return {};

  // Use a throwaway object so process.env is not mutated
  const container: Record<string, string> = {};
  const result = dotenvx.config({ path: envPath, quiet: true, processEnv: container });
  return (result.parsed as Record<string, string>) ?? {};
}
