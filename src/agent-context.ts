import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "./config.js";
import { type AgentManifest, loadAgentManifest } from "./manifest.js";

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
