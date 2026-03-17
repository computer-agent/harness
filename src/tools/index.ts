import { createSdkMcpServer, type McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { McpServerManifest, ToolDomain } from "../manifest.js";
import type { RemoteSandboxPolicy } from "../sandbox.js";
import { createIntrospectionTools } from "./introspection.js";
import { createMemoryTools } from "./memory.js";
import { modelQueryTools } from "./model-query.js";
import { createSandboxedShellTools, createShellTools } from "./shell.js";
import { createTaskTools } from "./tasks.js";
import { createWebTools } from "./web.js";
import { createA2ATools } from "./a2a.js";
import { createScratchpadTools } from "./scratchpad.js";
import { createWorkspaceTools } from "./workspace.js";

export interface ToolFilter {
  allow?: ToolDomain[];
  deny?: ToolDomain[];
}

/**
 * Determine whether a tool domain is enabled given global config and agent-level filter.
 *
 * Layer 1 (global): config.tools[domain].enabled must be true
 * Layer 2 (agent): if filter.allow is set, domain must be in the list
 *                   if filter.deny is set, domain must NOT be in the list
 *                   if neither, all globally-enabled tools pass
 */
export function isToolEnabled(domain: ToolDomain, config: HarnessConfig, filter?: ToolFilter): boolean {
  // Layer 1: global config
  if (!config.tools[domain].enabled) return false;

  // Layer 2: agent-level filter
  if (!filter) return true;
  if (filter.allow) return filter.allow.includes(domain);
  if (filter.deny) return !filter.deny.includes(domain);

  return true;
}

const createServer = (name: string, tools: Parameters<typeof createSdkMcpServer>[0]["tools"]) =>
  createSdkMcpServer({ name, tools });

/**
 * Build an MCP tool name from its components.
 * Centralizes the `mcp__<agent>-<server>__<tool>` naming convention.
 */
export function mcpTool(agentName: string, server: string, tool: string): string {
  return `mcp__${agentName}-${server}__${tool}`;
}

export function createAgentServers(
  ctx: AgentContext,
  config: HarnessConfig,
  cwd: string,
  agentEnv: Record<string, string> = {},
  toolFilter?: ToolFilter,
  sandboxPolicy?: RemoteSandboxPolicy,
) {
  const prefix = `${ctx.name}-`;
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};

  if (isToolEnabled("memory", config, toolFilter)) {
    servers[`${prefix}memory`] = createServer(`${prefix}memory`, createMemoryTools(ctx.memoryDir));
  }
  if (isToolEnabled("web", config, toolFilter)) {
    servers[`${prefix}web`] = createServer(`${prefix}web`, createWebTools(config.tools.web, agentEnv));
  }
  if (isToolEnabled("introspection", config, toolFilter)) {
    servers[`${prefix}introspection`] = createServer(
      `${prefix}introspection`,
      createIntrospectionTools({ identityPath: ctx.identityPath, proposalsDir: ctx.proposalsDir }),
    );
  }
  if (isToolEnabled("workspace", config, toolFilter)) {
    servers[`${prefix}workspace`] = createServer(`${prefix}workspace`, createWorkspaceTools(cwd));
  }
  if (isToolEnabled("shell", config, toolFilter)) {
    if (sandboxPolicy) {
      // Remote mode: only create shell if policy allows, always sandboxed
      if (sandboxPolicy.shell) {
        servers[`${prefix}shell`] = createServer(
          `${prefix}shell`,
          createSandboxedShellTools(cwd, sandboxPolicy, agentEnv),
        );
      }
      // If shell not allowed by policy, don't create the server at all (Layer 1 defense)
    } else {
      // CLI mode: unsandboxed shell
      servers[`${prefix}shell`] = createServer(`${prefix}shell`, createShellTools(cwd, agentEnv));
    }
  }
  if (isToolEnabled("models", config, toolFilter)) {
    servers[`${prefix}models`] = createServer(`${prefix}models`, modelQueryTools);
  }
  if (isToolEnabled("tasks", config, toolFilter)) {
    servers[`${prefix}tasks`] = createServer(`${prefix}tasks`, createTaskTools(ctx.memoryDir));
  }
  if (config.tools.a2a.enabled) {
    servers[`${prefix}a2a`] = createServer(`${prefix}a2a`, createA2ATools(config.tools.a2a.agents));
  }
  if (config.tools.scratchpad.enabled) {
    servers[`${prefix}scratchpad`] = createServer(
      `${prefix}scratchpad`,
      createScratchpadTools(ctx.workspaceDir),
    );
  }

  return servers;
}

// --- External MCP server merging ---

// Harness server names that external MCP servers cannot collide with
const HARNESS_SERVER_SUFFIXES = ["memory", "web", "introspection", "workspace", "shell", "models", "tasks"];

/**
 * Resolve ${VAR} references in MCP env config against the agent's .env values.
 * Uses simple string replacement — NEVER shell evaluation.
 */
function resolveEnvVars(
  env: Record<string, string> | undefined,
  agentEnv: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName) => agentEnv[varName] ?? "");
  }
  return resolved;
}

/**
 * Merge external MCP servers declared in agent frontmatter with harness servers.
 *
 * @param harnessServers - Servers created by createAgentServers()
 * @param mcpConfigs - MCP server configs from agent frontmatter
 * @param agentPrefix - Agent name prefix (e.g. "cre-analyst-")
 * @param agentEnv - Agent .env values for ${VAR} resolution
 * @param isRemoteSession - Whether this is a serve mode session
 * @param sandboxPolicy - Remote sandbox policy (if remote)
 * @param logger - Optional logger
 * @returns Merged servers record
 */
export function mergeExternalMcpServers(
  harnessServers: Record<string, SdkMcpServerConfig>,
  mcpConfigs: McpServerManifest[],
  agentPrefix: string,
  agentEnv: Record<string, string>,
  isRemoteSession: boolean,
  sandboxPolicy?: RemoteSandboxPolicy,
  logger?: Logger,
): Record<string, SdkMcpServerConfig> {
  const merged: Record<string, SdkMcpServerConfig> = { ...harnessServers };

  for (const mcp of mcpConfigs) {
    // Check for name collisions with harness servers
    const collidesWithHarness = HARNESS_SERVER_SUFFIXES.some(
      (suffix) => `${agentPrefix}${suffix}` === mcp.server || suffix === mcp.server,
    );
    if (collidesWithHarness) {
      logger?.warn("mcp", "mcp.collision", `MCP server name "${mcp.server}" collides with harness server — skipped`);
      continue;
    }
    if (merged[mcp.server]) {
      logger?.warn("mcp", "mcp.collision", `Duplicate MCP server name "${mcp.server}" — skipped`);
      continue;
    }

    if (mcp.uri) {
      // Remote MCP — always allowed (use streamable HTTP transport)
      merged[mcp.server] = { type: "http", url: mcp.uri };
      logger?.info("mcp", "mcp.configured", `URI-based MCP server configured: ${mcp.server}`, {
        details: { server: mcp.server, uri: mcp.uri },
      });
    } else if (mcp.command) {
      if (isRemoteSession && !sandboxPolicy) {
        // Remote session without sandbox — skip command-based MCP
        logger?.warn(
          "mcp",
          "mcp.skipped",
          `Command-based MCP server "${mcp.server}" skipped — remote session without sandbox`,
        );
        continue;
      }
      // Command-based MCP — allowed in CLI mode or sandboxed remote (stdio transport)
      const resolvedEnv = resolveEnvVars(mcp.env, agentEnv);
      merged[mcp.server] = {
        type: "stdio",
        command: mcp.command,
        ...(mcp.args ? { args: mcp.args } : {}),
        ...(resolvedEnv ? { env: resolvedEnv } : {}),
      };
      logger?.info("mcp", "mcp.configured", `Command-based MCP server configured: ${mcp.server}`, {
        details: { server: mcp.server, command: mcp.command },
      });
    }
  }

  return merged;
}
