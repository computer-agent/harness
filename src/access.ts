import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getHomeDir } from "./config.js";
import type { AgentManifest } from "./manifest.js";

export interface AccessUser {
  token: string;
  name: string;
  agents: string[] | "*"; // "*" = all agents
}

export interface AccessConfig {
  users: Map<string, AccessUser>; // Keyed by token
}

export function loadAccessConfig(): AccessConfig {
  const accessPath = join(getHomeDir(), "access.yaml");
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const parsed = parse(raw) as { tokens?: Record<string, { name: string; agents: string[] | "*" }> };
    const users = new Map<string, AccessUser>();
    if (parsed?.tokens) {
      for (const [token, entry] of Object.entries(parsed.tokens)) {
        users.set(token, { token, name: entry.name, agents: entry.agents });
      }
    }
    return { users };
  } catch {
    // No access.yaml = no remote access allowed
    return { users: new Map() };
  }
}

export function lookupUser(token: string, access: AccessConfig): AccessUser | null {
  return access.users.get(token) ?? null;
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
