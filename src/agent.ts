import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type HookJSONOutput,
  type Options,
  type Query,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext } from "./agent-context.js";
import { createAgentRegistry } from "./agents/index.js";
import type { HarnessConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type AgentManifest, loadAgentManifest, type McpServerManifest } from "./manifest.js";
import type { RemoteSandboxPolicy } from "./sandbox.js";
import { createAgentServers, mergeExternalMcpServers, type ToolFilter } from "./tools/index.js";

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

  // B3: Silent success / verbose failure — compact successful tool output
  if (config.hooks.compactSuccessOutput) {
    const threshold = config.hooks.compactOutputThreshold;
    const compactHook = {
      hooks: [
        async (input: Record<string, unknown>): Promise<HookJSONOutput> => {
          if (input.hook_event_name !== "PostToolUse") return { continue: true };

          const toolName = input.tool_name as string;
          const response = input.tool_response as { content?: { type: string; text: string }[] } | undefined;
          const text = response?.content?.[0]?.text;
          if (!text) return { continue: true };

          const lines = text.split("\n");
          if (lines.length <= threshold) return { continue: true };

          const makeCompacted = (summary: string): HookJSONOutput => ({
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              updatedMCPToolOutput: { content: [{ type: "text", text: summary }] },
            },
          });

          // shell_exec: compact success, preserve full failure output
          if (toolName.endsWith("__shell_exec")) {
            const isFailure = text.startsWith("Exit code:");
            if (!isFailure) {
              const preview = lines.slice(0, 5).join("\n");
              return makeCompacted(`Command succeeded (${lines.length} lines of output). First 5 lines:\n${preview}`);
            }
          }

          // grep_files: summarize large result sets
          if (toolName.endsWith("__grep_files")) {
            const matchLines = lines.filter((l) => l.trim() && l !== "--");
            const preview = lines.slice(0, 10).join("\n");
            return makeCompacted(
              `${matchLines.length} matching lines found. First 10:\n${preview}\n\n(Use more specific patterns or path filters to narrow results)`,
            );
          }

          return { continue: true };
        },
      ],
    };

    if (hooks.PostToolUse) {
      hooks.PostToolUse.push(compactHook);
    } else {
      hooks.PostToolUse = [compactHook];
    }
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
              typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response ?? "");
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
  // B2: Loop detection — per-file edit counts
  const editCounts = new Map<string, number>();
  // B1: Verification tracking — set of files written but not yet read back
  const unverifiedWrites = new Set<string>();

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

    // --- B1/B2: Loop detection + verification tracking ---
    const isWrite = toolName.endsWith("__write_file") || toolName.endsWith("__edit_file");
    const isVerify =
      toolName.endsWith("__read_file") || toolName.endsWith("__grep_files") || toolName.endsWith("__shell_exec");

    // Extract file path from tool input (used by both B1 and B2)
    const inp = input as Record<string, unknown>;
    const filePath = (inp.path ?? inp.file_path ?? "") as string;

    let message: string | undefined;

    // B2: Loop detection — warn after repeated edits to the same file
    if (config.hooks.loopDetection && isWrite && filePath) {
      const count = (editCounts.get(filePath) || 0) + 1;
      editCounts.set(filePath, count);
      if (count >= config.hooks.loopDetectionThreshold) {
        message = `You've edited ${filePath} ${count} times. Consider stepping back: is your approach correct, or should you try a fundamentally different solution?`;
      }
    }

    // B1: Verification tracking — per-file unverified write tracking
    if (config.hooks.verifyBeforeComplete) {
      if (isWrite && filePath) {
        unverifiedWrites.add(filePath);
      } else if (isVerify && filePath) {
        // Reading/grepping a specific file counts as verifying it
        unverifiedWrites.delete(filePath);
      } else if (isVerify && !filePath) {
        // shell_exec or grep without a specific path — clear all (broad verification)
        unverifiedWrites.clear();
      } else if (unverifiedWrites.size > 0) {
        message =
          message ??
          "You modified files but haven't verified the changes. Please read back modified files to confirm correctness before continuing.";
      }
    }

    // Reset loop counter only for the specific file being verified
    if (isVerify && config.hooks.loopDetection && filePath) {
      editCounts.delete(filePath);
    }

    return { behavior: "allow" as const, ...(message ? { message } : {}) };
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
    mcpConfigs?: McpServerManifest[];
    isRemoteSession?: boolean;
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
  const canUseTool = buildCanUseTool(
    ctx,
    config,
    opts.onAskUserQuestion,
    opts.onToolApproval,
    opts.sandboxPolicy,
    opts.logger,
  );
  const cwd = opts.cwd ?? ctx.workspaceDir;
  const agentEnv = opts.agentEnv ?? {};

  const harnessServers = createAgentServers(ctx, config, cwd, agentEnv, opts.toolFilter, opts.sandboxPolicy);
  const mcpServers = opts.mcpConfigs?.length
    ? mergeExternalMcpServers(
        harnessServers,
        opts.mcpConfigs,
        `${ctx.name}-`,
        agentEnv,
        opts.isRemoteSession ?? false,
        opts.sandboxPolicy,
        opts.logger,
      )
    : harnessServers;

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
    mcpServers,
    strictMcpConfig: true,
    agents: createAgentRegistry(ctx.name),
    ...(hooks ? { hooks } : {}),
    canUseTool,
    ...(opts.resume ? { resume: opts.resume } : {}),
  };
}

// B5: Environment onboarding — workspace snapshot for system prompt
async function buildEnvironmentContext(ctx: AgentContext, config: HarnessConfig): Promise<string> {
  const parts = ["# Environment\n"];

  // Workspace contents
  try {
    const entries = await readdir(ctx.workspaceDir);
    if (entries.length > 0) {
      parts.push("## Workspace Files\n");
      parts.push(
        entries
          .slice(0, 20)
          .map((e) => `- ${e}`)
          .join("\n"),
      );
      if (entries.length > 20) parts.push(`\n... and ${entries.length - 20} more`);
    }
  } catch {
    /* empty or inaccessible workspace */
  }

  // B5 + B4: If PROGRESS.json exists, surface outstanding work
  try {
    const progress = await readFile(join(ctx.workspaceDir, "PROGRESS.json"), "utf-8");
    const parsed = JSON.parse(progress);
    if (parsed.remaining?.length) {
      parts.push("\n## Outstanding Work\n");
      parts.push(parsed.remaining.map((r: string) => `- ${r}`).join("\n"));
    }
  } catch {
    /* no progress file */
  }

  // Available tool domains
  const enabledTools = Object.entries(config.tools)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  if (enabledTools.length > 0) {
    parts.push(`\n## Available Tools\n${enabledTools.join(", ")}`);
  }

  return parts.join("\n");
}

interface SystemPromptResult {
  systemPrompt: string;
  manifest: AgentManifest;
}

export async function buildSystemPrompt(ctx: AgentContext, config?: HarnessConfig): Promise<SystemPromptResult> {
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

  // B5: Environment onboarding (only when config is available — CLI/TUI mode)
  if (config) {
    const envContext = await buildEnvironmentContext(ctx, config);
    parts.push(envContext);

    // B1: Verification protocol
    if (config.hooks.verifyBeforeComplete) {
      parts.push(`# Verification Protocol

Before concluding any task that produces artifacts (code, documents, analysis):
1. Re-read your original instructions
2. Verify each requirement was addressed
3. If you wrote code, run it or check for obvious errors
4. If you modified files, re-read the modified files to confirm correctness
5. Only then report your results`);
    }

    // B4: Structured progress tracking
    parts.push(`# Session Continuity

At the start of each session, read \`workspace/PROGRESS.json\` if it exists.
Before ending a session, update it with:
- What you accomplished
- What remains to be done
- Any decisions made and their rationale
- Current blockers or open questions

Format: JSON with fields: { accomplished: string[], remaining: string[], decisions: string[], blockers: string[] }`);

    // B6: Sub-agent scratchpad coordination
    if (config.tools.scratchpad.enabled) {
      parts.push(`# Sub-Agent Coordination

Sub-agents can share intermediate results via the \`.scratch/\` directory in your workspace. Direct sub-agents to write findings there for other sub-agents to read. For example:
- Researcher writes findings to \`.scratch/research-results.md\`
- Deep-thinker reads those findings and writes analysis to \`.scratch/analysis.md\`
- Writer reads both to compose the final output`);
    }
  }

  return { systemPrompt: parts.join("\n\n"), manifest };
}

export function sendMessage(prompt: string, options: Options): Query {
  return query({ prompt, options });
}
