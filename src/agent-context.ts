import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "./config.js";
import { type AgentManifest, loadAgentManifest } from "./manifest.js";

/** Validate userId to prevent path traversal. Only alphanumeric + hyphens allowed. */
const USER_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i;

function validateUserId(userId: string): void {
  if (!userId || userId.length < 2 || userId.length > 64 || !USER_ID_RE.test(userId)) {
    throw new Error(`Invalid userId: must be 2-64 alphanumeric characters or hyphens, got "${userId}"`);
  }
  if (userId.includes("..") || userId.includes("/") || userId.includes("\0")) {
    throw new Error("Invalid userId: contains path traversal characters");
  }
}

export interface AgentContext {
  name: string;
  agentDir: string;
  identityPath: string;
  memoryDir: string;
  contextFile: string;
  stateDir: string;
  sessionsDir: string;
  lastSessionFile: string;
  proposalsDir: string;
  stderrLog: string;
  workspaceDir: string;
}

export const DEFAULT_AGENT = "cofounder";

export class AgentNotFoundError extends Error {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`Agent "${agentName}": ${reason}`);
    this.name = "AgentNotFoundError";
  }
}

export function getAgentsDir(): string {
  return join(getHomeDir(), "agents");
}

export function resolveAgent(name: string): AgentContext {
  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");

  if (!existsSync(agentDir)) {
    throw new AgentNotFoundError(name, `directory not found: ${agentDir}`);
  }
  if (!existsSync(identityPath)) {
    throw new AgentNotFoundError(name, `IDENTITY.md not found: ${identityPath}`);
  }

  const stateDir = join(getHomeDir(), "state", name);
  const workspaceDir = join(agentDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  return {
    name,
    agentDir,
    identityPath,
    memoryDir: join(agentDir, "memory"),
    contextFile: join(agentDir, "memory", "CONTEXT.md"),
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
    lastSessionFile: join(stateDir, "last-session-id"),
    proposalsDir: join(stateDir, "proposals"),
    stderrLog: join(stateDir, "stderr.log"),
    workspaceDir,
  };
}

/**
 * Resolve agent context for a remote (serve mode) user.
 * Each user gets isolated workspace and memory directories:
 *   workspace: ~/.mastersof-ai/agents/{agent}/workspace/{userId}/
 *   memory:    ~/.mastersof-ai/agents/{agent}/memory/{userId}/
 *
 * The shared agent memory (memory/CONTEXT.md) is read-only for remote users.
 */
export function resolveRemoteAgent(name: string, userId: string): AgentContext {
  validateUserId(userId);

  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");

  if (!existsSync(agentDir)) {
    throw new AgentNotFoundError(name, `directory not found: ${agentDir}`);
  }
  if (!existsSync(identityPath)) {
    throw new AgentNotFoundError(name, `IDENTITY.md not found: ${identityPath}`);
  }

  const stateDir = join(getHomeDir(), "state", name);
  const userWorkspaceDir = join(agentDir, "workspace", userId);
  const userMemoryDir = join(agentDir, "memory", userId);

  mkdirSync(userWorkspaceDir, { recursive: true, mode: 0o700 });
  mkdirSync(userMemoryDir, { recursive: true, mode: 0o700 });

  return {
    name,
    agentDir,
    identityPath,
    memoryDir: userMemoryDir,
    contextFile: join(agentDir, "memory", "CONTEXT.md"), // Shared memory (read-only for remote users)
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
    lastSessionFile: join(stateDir, "last-session-id"),
    proposalsDir: join(stateDir, "proposals"),
    stderrLog: join(stateDir, "stderr.log"),
    workspaceDir: userWorkspaceDir,
  };
}

/**
 * Scan the agents directory and return manifests for all valid agents.
 * Agents with parse errors are included with default frontmatter (warnings logged to stderr).
 */
export async function listAgents(): Promise<AgentManifest[]> {
  const agentsDir = getAgentsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agentDirs = entries
    .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
    .map((e) => join(agentsDir, e.name));

  const results = await Promise.all(
    agentDirs.map(async (dir) => {
      try {
        const { manifest, warnings } = await loadAgentManifest(dir);
        for (const w of warnings) {
          console.error(`Warning [${manifest.id}]: ${w.message}`);
        }
        return manifest;
      } catch (err) {
        console.error(`Error loading agent from ${dir}: ${err}`);
        return null;
      }
    }),
  );

  return results.filter((m): m is AgentManifest => m !== null);
}
