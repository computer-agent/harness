import { appendFile, mkdir, readFile } from "node:fs/promises";
import {
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  type Query,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext } from "./agent-context.js";
import { createAgentRegistry } from "./agents/index.js";
import type { HarnessConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type AgentManifest, loadAgentManifest } from "./manifest.js";
import type { RemoteSandboxPolicy } from "./sandbox.js";
import { createAgentServers, type ToolFilter } from "./tools/index.js";

async function loadMemoryContext(contextFile: string): Promise<string | null> {
  try {
    const content = await readFile(contextFile, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

function buildHooks(
  ctx: AgentContext,
  config: HarnessConfig,
  onInstructionsLoaded?: (filePath: string, memoryType: string, loadReason: string) => void,
  onToolResult?: (toolId: string, toolName: string, output: string) => void,
  logger?: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  if (config.hooks.logToolUse || logger) {
    const logDir = ctx.stateDir;
    const logPath = ctx.stderrLog;

    hooks.PreToolUse = [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PreToolUse") {
              const toolName = input.tool_name;
              if (logger) {
                logger.debug("tool", "tool.called", `Tool called: ${toolName}`, {
                  details: { tool: toolName },
                });
              }
              if (config.hooks.logToolUse) {
                const ts = new Date().toISOString();
                const toolInput =
                  typeof input.tool_input === "string"
                    ? input.tool_input.slice(0, 200)
                    : JSON.stringify(input.tool_input).slice(0, 200);
                await mkdir(logDir, { recursive: true });
                await appendFile(logPath, `${ts} [hook:PreToolUse] ${toolName} ${toolInput}\n`);
              }
            }
            return { continue: true };
          },
        ],
      },
    ];

    hooks.PostToolUse = [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") {
              const toolName = input.tool_name;
              if (logger) {
                logger.debug("tool", "tool.completed", `Tool completed: ${toolName}`, {
                  details: { tool: toolName },
                });
              }
              if (config.hooks.logToolUse) {
                const ts = new Date().toISOString();
                await mkdir(logDir, { recursive: true });
                await appendFile(logPath, `${ts} [hook:PostToolUse] ${toolName} complete\n`);
              }
            }
            return { continue: true };
          },
        ],
      },
    ];
  }

  hooks.InstructionsLoaded = [
    {
      hooks: [
        async (input) => {
          if (input.hook_event_name === "InstructionsLoaded") {
            const { file_path, memory_type, load_reason } = input;
            onInstructionsLoaded?.(file_path, memory_type, load_reason);
          }
          return { continue: true };
        },
      ],
    },
  ];

  if (onToolResult) {
    if (!hooks.PostToolUse) hooks.PostToolUse = [];
    hooks.PostToolUse.push({
      hooks: [
        async (input) => {
          if (input.hook_event_name === "PostToolUse") {
            const output =
              typeof input.tool_response === "string"
                ? input.tool_response
                : JSON.stringify(input.tool_response ?? "");
            onToolResult(input.tool_use_id, input.tool_name, output);
          }
          return { continue: true };
        },
      ],
    });
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function buildCanUseTool(
  ctx: AgentContext,
  config: HarnessConfig,
  onAskUserQuestion?: (input: Record<string, unknown>) => Promise<Record<string, string> | null>,
  onToolApproval?: (toolId: string, toolName: string, input: Record<string, unknown>) => Promise<boolean>,
  sandboxPolicy?: RemoteSandboxPolicy,
  logger?: Logger,
): CanUseTool {
  return async (toolName, input, options) => {
    // Logging
    if (config.hooks.logToolUse) {
      const ts = new Date().toISOString();
      const inputSummary = JSON.stringify(input).slice(0, 200);
      await mkdir(ctx.stateDir, { recursive: true });
      await appendFile(ctx.stderrLog, `${ts} [canUseTool] ${toolName} ${inputSummary}\n`);
    }

    // Layer 2: Remote sandbox policy — deny shell_exec if policy forbids it
    if (sandboxPolicy && toolName === "shell_exec" && !sandboxPolicy.shell) {
      if (logger) {
        logger.warn("tool", "tool.denied", `Shell denied by sandbox policy: ${toolName}`, {
          details: { tool: toolName },
        });
      }
      return { behavior: "deny", message: "Shell execution is not allowed for this session" };
    }

    // AskUserQuestion handling
    if (toolName === "AskUserQuestion") {
      if (options.agentID) {
        return { behavior: "deny", message: "Sub-agents cannot ask user questions" };
      }
      if (!onAskUserQuestion) {
        return { behavior: "deny", message: "No question handler available" };
      }
      const answers = await onAskUserQuestion(input);
      if (!answers) {
        return { behavior: "deny", message: "User dismissed the question" };
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    // Tool approval (serve mode)
    if (onToolApproval) {
      const approved = await onToolApproval(options.toolUseID, toolName, input);
      if (!approved) {
        return { behavior: "deny", message: "User denied tool execution" };
      }
    }

    return { behavior: "allow" as const };
  };
}

export function buildOptions(
  ctx: AgentContext,
  opts: {
    resume?: string;
    systemPrompt: string;
    cwd?: string;
    agentEnv?: Record<string, string>;
    toolFilter?: ToolFilter;
    onInstructionsLoaded?: (filePath: string, memoryType: string, loadReason: string) => void;
    onAskUserQuestion?: (input: Record<string, unknown>) => Promise<Record<string, string> | null>;
    onToolApproval?: (toolId: string, toolName: string, input: Record<string, unknown>) => Promise<boolean>;
    onToolResult?: (toolId: string, toolName: string, output: string) => void;
    logger?: Logger;
    sandboxPolicy?: RemoteSandboxPolicy;
  },
  config: HarnessConfig,
): Options {
  const hooks = buildHooks(ctx, config, opts.onInstructionsLoaded, opts.onToolResult, opts.logger);
  const canUseTool = buildCanUseTool(ctx, config, opts.onAskUserQuestion, opts.onToolApproval, opts.sandboxPolicy, opts.logger);
  const cwd = opts.cwd ?? ctx.workspaceDir;
  const agentEnv = opts.agentEnv ?? {};

  return {
    model: config.model,
    systemPrompt: opts.systemPrompt,
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: ["AskUserQuestion"],
    thinking: { type: "adaptive" },
    effort: config.effort,
    includePartialMessages: true,
    stderr: async (data: string) => {
      await mkdir(ctx.stateDir, { recursive: true });
      await appendFile(ctx.stderrLog, `${new Date().toISOString()} ${data}\n`);
    },
    mcpServers: createAgentServers(ctx, config, cwd, agentEnv, opts.toolFilter, opts.sandboxPolicy),
    strictMcpConfig: true,
    agents: createAgentRegistry(ctx.name),
    ...(hooks ? { hooks } : {}),
    canUseTool,
    ...(opts.resume ? { resume: opts.resume } : {}),
  };
}

interface SystemPromptResult {
  systemPrompt: string;
  manifest: AgentManifest;
}

export async function buildSystemPrompt(ctx: AgentContext): Promise<SystemPromptResult> {
  const { manifest, warnings } = await loadAgentManifest(ctx.agentDir);

  // Log any frontmatter warnings
  for (const w of warnings) {
    console.error(`Warning [${manifest.id}]: ${w.message}`);
  }

  const identity = manifest.body;
  const memoryContext = await loadMemoryContext(ctx.contextFile);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const dateLine = `# Current Date\n\n${date}, ${time} (${tz})`;

  const workspaceLine = `# Workspace\n\nYour workspace directory is \`${ctx.workspaceDir}\`. This is your persistent working directory — files you create here survive across sessions. You can also access any directories mounted in your sandbox config.`;

  const parts = [identity];
  if (memoryContext) {
    parts.push(
      `# Persistent Memory\n\nThe following is your accumulated context from previous sessions:\n\n${memoryContext}`,
    );
  }
  parts.push(dateLine);
  parts.push(workspaceLine);

  return { systemPrompt: parts.join("\n\n"), manifest };
}

export function sendMessage(prompt: string, options: Options): Query {
  return query({ prompt, options });
}
