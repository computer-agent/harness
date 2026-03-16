import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import type { ToolDomain } from "../manifest.js";
import { createIntrospectionTools } from "./introspection.js";
import { createMemoryTools } from "./memory.js";
import { modelQueryTools } from "./model-query.js";
import { createShellTools } from "./shell.js";
import { createTaskTools } from "./tasks.js";
import { createWebTools } from "./web.js";
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

export function createAgentServers(
  ctx: AgentContext,
  config: HarnessConfig,
  cwd: string,
  agentEnv: Record<string, string> = {},
  toolFilter?: ToolFilter,
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
    servers[`${prefix}shell`] = createServer(`${prefix}shell`, createShellTools(cwd, agentEnv));
  }
  if (isToolEnabled("models", config, toolFilter)) {
    servers[`${prefix}models`] = createServer(`${prefix}models`, modelQueryTools);
  }
  if (isToolEnabled("tasks", config, toolFilter)) {
    servers[`${prefix}tasks`] = createServer(`${prefix}tasks`, createTaskTools(ctx.memoryDir));
  }

  return servers;
}
