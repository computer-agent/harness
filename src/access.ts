import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getHomeDir } from "./config.js";
import type { AgentManifest } from "./manifest.js";

export interface AccessUser {
  name: string;
  agents: string[] | "*"; // "*" = all agents
}

export interface AccessConfig {
  users: AccessEntry[];
}

interface AccessEntry {
  tokenHash: string;
  name: string;
  agents: string[] | "*";
}

/**
 * Hash a raw token with SHA-256 for storage in access.yaml.
 * Tokens should never be stored in plaintext.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two hex strings.
 * Prevents timing side-channel attacks on token validation.
 */
function safeCompare(a: string, b: string): boolean {
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
 * ```
 */
export function loadAccessConfig(): AccessConfig {
  const accessPath = join(getHomeDir(), "access.yaml");
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const parsed = parse(raw) as {
      users?: Array<{ token_hash: string; name: string; agents: string[] | "*" }>;
    };
    const users: AccessEntry[] = [];
    if (parsed?.users) {
      for (const entry of parsed.users) {
        if (entry.token_hash) {
          users.push({ tokenHash: entry.token_hash, name: entry.name, agents: entry.agents });
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
      return { name: entry.name, agents: entry.agents };
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
