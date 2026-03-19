import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getHomeDir } from "./config.js";
import { type BudgetConfig, DEFAULT_BUDGET, UNLIMITED_BUDGET } from "./cost.js";
import type { AgentManifest } from "./manifest.js";

export interface AccessUser {
  name: string;
  agents: string[] | "*"; // "*" = all agents
  budget: BudgetConfig;
  toolsDeny: string[]; // Tool names this user cannot use (e.g., ["shell_exec"])
}

export interface AccessConfig {
  users: AccessEntry[];
}

export interface AccessEntry {
  tokenHash: string;
  name: string;
  agents: string[] | "*";
  budget: BudgetConfig;
  toolsDeny: string[];
}

/**
 * Hash a raw token with SHA-256 for storage in access.yaml.
 * Tokens should never be stored in plaintext.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two strings.
 * Prevents timing side-channel attacks on token validation.
 *
 * **Important:** `timingSafeEqual` is only constant-time when both inputs
 * have equal length. The early-return on length mismatch is safe because
 * all current callers compare fixed-length SHA-256 hex digests (64 chars).
 * If this function is ever used with variable-length inputs, the length
 * check itself leaks timing information about the expected length.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Load access configuration from access.yaml.
 *
 * access.yaml format:
 * ```yaml
 * users:
 *   - token_hash: "<sha256 hex of token>"
 *     name: "Alice"
 *     agents: "*"
 *     budget: unlimited  # or { sessionLimit, dailyLimit, monthlyLimit }
 * ```
 */

/** Parse a budget field from access.yaml into a BudgetConfig. */
function parseBudget(raw: unknown): BudgetConfig {
  if (raw === "unlimited") return UNLIMITED_BUDGET;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      sessionLimit: typeof obj.sessionLimit === "number" ? obj.sessionLimit : DEFAULT_BUDGET.sessionLimit,
      dailyLimit: typeof obj.dailyLimit === "number" ? obj.dailyLimit : DEFAULT_BUDGET.dailyLimit,
      monthlyLimit: typeof obj.monthlyLimit === "number" ? obj.monthlyLimit : DEFAULT_BUDGET.monthlyLimit,
    };
  }
  return DEFAULT_BUDGET;
}

export function loadAccessConfig(): AccessConfig {
  const accessPath = join(getHomeDir(), "access.yaml");
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const parsed = parse(raw) as {
      users?: Array<{
        token_hash: string;
        name: string;
        agents: string[] | "*";
        budget?: unknown;
        tools_deny?: string[];
      }>;
    };
    const users: AccessEntry[] = [];
    if (parsed?.users) {
      for (const entry of parsed.users) {
        if (entry.token_hash) {
          users.push({
            tokenHash: entry.token_hash,
            name: entry.name,
            agents: entry.agents,
            budget: parseBudget(entry.budget),
            toolsDeny: Array.isArray(entry.tools_deny) ? entry.tools_deny : [],
          });
        }
      }
    }
    return { users };
  } catch {
    // No access.yaml = no remote access allowed
    return { users: [] };
  }
}

/**
 * Look up a user by their raw bearer token.
 * The token is hashed and compared against stored SHA-256 hashes.
 */
export function lookupUser(token: string, access: AccessConfig): AccessUser | null {
  const incomingHash = hashToken(token);
  for (const entry of access.users) {
    if (safeCompare(incomingHash, entry.tokenHash)) {
      return { name: entry.name, agents: entry.agents, budget: entry.budget, toolsDeny: entry.toolsDeny };
    }
  }
  return null;
}

export function authenticateRequest(
  request: { headers: Record<string, string | undefined> },
  access: AccessConfig,
): AccessUser | null {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return lookupUser(token, access);
}

export function userCanAccessAgent(agent: AgentManifest, user: AccessUser): boolean {
  // Check token-level access
  if (user.agents !== "*" && !user.agents.includes(agent.id)) {
    return false;
  }

  // Check agent-level access (from IDENTITY.md frontmatter)
  if (agent.frontmatter.access === "private") {
    return false; // Private agents are never visible to remote users
  }
  if (agent.frontmatter.access === "users") {
    return agent.frontmatter.users.includes(user.name);
  }
  // access === "public" — visible to all authenticated users
  return true;
}

export function filterAgentsForUser(agents: AgentManifest[], user: AccessUser): AgentManifest[] {
  return agents.filter((a) => userCanAccessAgent(a, user));
}

/**
 * Generate a cryptographically random access token and its SHA-256 hash.
 *
 * Returns the raw token (to give to the partner) and the hash (to store in access.yaml).
 * The raw token is 32 bytes of randomness, hex-encoded (64 chars).
 */
export function generateAccessToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}
