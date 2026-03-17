# Harness Upgrades Spec — A2A Integration + Harness Engineering

**Date:** 2026-03-17
**Scope:** 12 work items across two themes: A2A protocol integration and harness engineering improvements
**Target:** All implementable today

---

## Theme A: A2A Protocol Integration

### A1. Agent Server Mode (`--serve`)

**What:** Expose any harness agent as an A2A-compatible HTTP endpoint that external systems can call.

**Why:** Makes our agents callable by AWS Bedrock, Google ADK, LangGraph, ServiceNow, or any A2A client. Our agents become services, not just CLI tools.

**Spec:**

- New CLI flag: `mastersof-ai --agent researcher --serve [--port 4000]`
- Starts an Express server alongside (or instead of) the TUI
- Serves `GET /.well-known/agent-card.json` — derived from IDENTITY.md
- Handles `POST /` — JSON-RPC 2.0 per A2A spec
- Implements `SendMessage` and `SendStreamingMessage` methods
- Maps A2A task lifecycle to our existing `sendMessage()` / `Query` flow:
  - `TASK_STATE_SUBMITTED` → query created
  - `TASK_STATE_WORKING` → streaming in progress
  - `TASK_STATE_INPUT_REQUIRED` → agent needs clarification (future)
  - `TASK_STATE_COMPLETED` → result returned
  - `TASK_STATE_FAILED` → error
- SSE streaming for real-time task updates
- In-memory task store (A2A SDK provides `InMemoryTaskStore`)

**New files:**
- `src/a2a/server.ts` — Express app setup, route wiring
- `src/a2a/agent-card.ts` — Generates AgentCard JSON from IDENTITY.md + config
- `src/a2a/executor.ts` — `AgentExecutor` implementation bridging A2A → our `sendMessage()`
- `src/a2a/index.ts` — Exports

**Touches:**
- `src/index.tsx` — Add `--serve` / `--port` flag parsing, launch server mode
- `package.json` — Add `@a2a-js/sdk` and `express` dependencies

**Agent Card shape** (derived from IDENTITY.md):
```typescript
{
  name: ctx.name,                    // from agent dir name
  description: extractFirstParagraph(identity),  // from IDENTITY.md
  version: packageJson.version,
  supportedInterfaces: [{
    url: `http://localhost:${port}/`,
    protocolVersion: "1.0.0",        // A2A v1.0
    protocolBinding: "JSONRPC",
  }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: deriveSkillsFromIdentity(identity),  // parse IDENTITY.md sections
}
```

**Executor bridge** (core logic):
```typescript
class HarnessExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, eventBus: IExecutionEventBus) {
    const prompt = extractTextFromMessage(ctx.message);
    const systemPrompt = await buildSystemPrompt(agentContext);
    const options = buildOptions(agentContext, { systemPrompt }, config);

    eventBus.publish({ kind: 'status-update', status: { state: TaskState.Working }});

    const q = sendMessage(prompt, options);
    let result = "";
    for await (const msg of q) {
      if (msg.type === "stream_event") {
        // Publish streaming artifacts for SSE clients
      }
      if (msg.type === "result") {
        result = msg.text;
      }
    }

    eventBus.publish({
      kind: 'status-update',
      status: { state: TaskState.Completed, message: { role: 'agent', parts: [{ kind: 'text', text: result }] }},
      final: true,
    });
  }
}
```

---

### A2. A2A Client Tool — Consume External Agents

**What:** New MCP tool that lets our agents call any A2A-compatible remote agent.

**Why:** Our agents can delegate work to specialized external agents (LangGraph pipelines, Bedrock agents, etc.) without knowing their internals.

**Spec:**

- New tool server: `{agent}-a2a` with tools:
  - `a2a_discover` — Fetch and display an Agent Card from a URL
  - `a2a_call` — Send a message to a remote A2A agent, return the result
  - `a2a_call_streaming` — Same but with streaming progress updates
- Uses `@a2a-js/sdk` `ClientFactory` for client creation
- Supports both blocking and streaming modes
- Agent Card caching (in-memory, per-session)

**New files:**
- `src/tools/a2a.ts` — MCP tool definitions for a2a_discover, a2a_call, a2a_call_streaming

**Touches:**
- `src/tools/index.ts` — Add a2a server creation when `config.tools.a2a.enabled`
- `src/config.ts` — Add `a2a: { enabled: boolean }` to HarnessConfig and defaults

**Tool schemas:**
```typescript
a2a_discover: {
  input: { url: z.string().describe("Base URL of remote A2A agent") },
  output: AgentCard JSON
}

a2a_call: {
  input: {
    url: z.string().describe("Base URL of remote A2A agent"),
    message: z.string().describe("Message to send to the remote agent"),
    blocking: z.boolean().default(true).describe("Wait for completion"),
  },
  output: Task result text or task ID for async polling
}
```

---

### A3. A2A Agent Registry in Config

**What:** Allow users to register known A2A agents in config.yaml so agents can discover them without hardcoding URLs.

**Why:** Makes external agent discovery declarative and per-deployment configurable.

**Spec:**

- New config section in `config.yaml`:
```yaml
a2a:
  enabled: true
  agents:
    data-pipeline:
      url: http://data-agent.internal:4000
      description: "LangGraph data pipeline agent"
    code-review:
      url: http://review-agent:4000
      description: "Automated code review"
```
- New tool: `a2a_list` — Returns all registered A2A agents from config
- Agents can discover available external agents, then call them by name

**Touches:**
- `src/config.ts` — Extend `HarnessConfig` with `a2a` section
- `src/tools/a2a.ts` — Add `a2a_list` tool, accept name-based lookups

---

### A4. Sub-Agent Type: A2A Remote

**What:** Register remote A2A agents as sub-agent types alongside researcher/deep-thinker/writer.

**Why:** The parent agent can delegate to external A2A agents using the same sub-agent dispatch pattern it already uses for built-in sub-agents. Uniform interface.

**Spec:**

- For each entry in `config.a2a.agents`, generate a sub-agent entry:
```typescript
{
  description: config.a2a.agents[name].description,
  // No model/maxTurns — handled by remote agent
  // Implementation: A2A client call instead of SDK sub-agent
}
```
- This requires the SDK's agent dispatch to support custom execution. If the SDK doesn't support custom agent executors, fall back to exposing A2A agents as MCP tools only (A2 above).

**Touches:**
- `src/agents/index.ts` — Conditional A2A agent registration
- May require SDK investigation — does `AgentDefinition` support custom execution?

**Fallback:** If SDK doesn't support this cleanly, skip A4 and rely on A2 (tool-based access). The tool approach is simpler and still gives full functionality.

---

### A5. Agent Card Auto-Generation for All Agents

**What:** `mastersof-ai --agent <name> --card` outputs a valid A2A Agent Card JSON for any agent.

**Why:** Lets users inspect what an agent would advertise, useful for debugging and registration with external systems.

**Spec:**

- New CLI flag: `--card`
- Reads IDENTITY.md, extracts name/description/skills
- Outputs formatted Agent Card JSON to stdout
- Skills derived by parsing markdown H2 sections or explicit `## Skills` section in IDENTITY.md

**Touches:**
- `src/index.tsx` — Add `--card` flag handling
- `src/a2a/agent-card.ts` — Reuse card generation logic from A1

---

## Theme B: Harness Engineering Improvements

### B1. Pre-Completion Verification Hook

**What:** Before an agent finishes its response, inject a verification reminder into context.

**Why:** The single highest-impact harness improvement per LangChain, OpenAI, HumanLayer, and Anthropic research. Agents default to "write it, read it, say looks good, stop." Forcing a verification pass catches bugs the agent would otherwise miss.

**Spec:**

Two implementation options (implement both, config-driven):

**Option 1: System prompt convention**
- Append to the system prompt (in `buildSystemPrompt`):
```
# Verification Protocol

Before concluding any task that produces artifacts (code, documents, analysis):
1. Re-read your original instructions
2. Verify each requirement was addressed
3. If you wrote code, run it or check for obvious errors
4. If you modified files, re-read the modified files to confirm correctness
5. Only then report your results
```

**Option 2: Post-tool hook (deterministic)**
- Track when the agent produces a `result` message
- If the agent hasn't used a verification tool (grep, read_file, shell_exec with test command) after its last write_file/edit_file, inject a context message: "You modified files but haven't verified the changes. Please verify before finishing."
- Implemented via hook state tracking in `buildCanUseTool`

**New config:**
```yaml
hooks:
  logToolUse: false
  verifyBeforeComplete: true   # NEW
```

**Touches:**
- `src/agent.ts` — `buildSystemPrompt()` for Option 1, `buildCanUseTool()` for Option 2
- `src/config.ts` — Add `verifyBeforeComplete` to hooks config

---

### B2. Loop Detection

**What:** Detect when an agent is editing the same file repeatedly and inject "reconsider your approach" guidance.

**Why:** Prevents doom loops where agents make 10+ small variations to the same broken approach. LangChain found this recovers agents from stuck states.

**Spec:**

- Track edit/write counts per file path in `canUseTool` callback
- After N edits (default: 3) to the same file within a session, inject guidance:
  `"You've edited {filename} {N} times. Consider stepping back: is your approach correct, or should you try a fundamentally different solution?"`
- Counter resets when a different file is edited or a verification tool is run
- Configurable threshold

**State tracking:**
```typescript
// In canUseTool closure
const editCounts = new Map<string, number>();

// On write_file or edit_file:
const path = input.path || input.filename;
const count = (editCounts.get(path) || 0) + 1;
editCounts.set(path, count);

if (count >= threshold) {
  return {
    behavior: "allow",
    message: `You've edited ${path} ${count} times...`
  };
}
```

**New config:**
```yaml
hooks:
  loopDetection: true          # NEW
  loopDetectionThreshold: 3    # NEW — edits before warning
```

**Touches:**
- `src/agent.ts` — `buildCanUseTool()` state tracking
- `src/config.ts` — Add loop detection config

---

### B3. Silent Success / Verbose Failure

**What:** Compress successful tool output and expand failures to keep context clean.

**Why:** HumanLayer found that 4,000 lines of passing test output floods context and makes agents lose track. Success should be silent; failures should be verbose.

**Spec:**

- `PostToolUse` hook that checks tool results:
  - If `shell_exec` exits 0 and output > N lines: truncate to summary
    `"Command succeeded (147 lines of output). First 5 lines: ..."`
  - If `shell_exec` exits non-zero: pass full output through
  - If `grep_files` returns many results: summarize count + first few
  - If `read_file` is very large: note the size (already handled by workspace tool, but reinforce)
- Configurable output limit (default: 50 lines for successful commands)

**Implementation:** `PostToolUse` hook that modifies the tool result before it enters context.

**Note:** Need to check if the SDK's `PostToolUse` hook can modify tool results, or if we need to use `canUseTool` / a different mechanism. If PostToolUse is read-only, implement this as tool-level output truncation in `src/tools/shell.ts` directly.

**New config:**
```yaml
hooks:
  compactSuccessOutput: true     # NEW
  compactOutputThreshold: 50     # NEW — max lines for success output
```

**Touches:**
- `src/agent.ts` — `PostToolUse` hook or `canUseTool` modification
- `src/tools/shell.ts` — Fallback: truncate at tool level
- `src/config.ts` — Add compact output config

---

### B4. Structured Progress Tracking

**What:** A structured progress file that agents maintain across sessions, enabling clean handoffs.

**Why:** Both OpenAI and Anthropic found this essential for multi-session work. Anthropic specifically found JSON is better than markdown because models are less likely to inappropriately edit JSON.

**Spec:**

- New convention: `workspace/PROGRESS.json` maintained by the agent
- System prompt instruction added to `buildSystemPrompt`:
```
# Session Continuity

At the start of each session, read `workspace/PROGRESS.json` if it exists.
Before ending a session, update it with:
- What you accomplished
- What remains to be done
- Any decisions made and their rationale
- Current blockers or open questions

Format: JSON with fields: { accomplished: string[], remaining: string[], decisions: string[], blockers: string[] }
```
- The agent uses existing `workspace` tools to read/write this file
- No new tools needed — just system prompt guidance

**Alternative:** Could add a dedicated `progress_read` / `progress_update` tool with schema validation. But the system prompt approach is simpler and aligns with "start simple."

**Touches:**
- `src/agent.ts` — `buildSystemPrompt()` adds progress section
- System prompt only — no new code for MVP

---

### B5. Environment Onboarding

**What:** Inject a brief workspace summary into the system prompt at session start.

**Why:** LangChain's `LocalContextMiddleware` pattern — onboard the agent into its environment so it doesn't waste tokens discovering directory structure, installed tools, and recent state.

**Spec:**

- In `buildSystemPrompt`, after loading CONTEXT.md, generate a workspace snapshot:
  - List files in workspace directory (top-level only, max 20 entries)
  - Check if PROGRESS.json exists and include its summary
  - List available tool domains (from config)
- Inject as a `# Environment` section in the system prompt

**Implementation:**
```typescript
async function buildEnvironmentContext(ctx: AgentContext, config: HarnessConfig): Promise<string> {
  const parts = ["# Environment\n"];

  // Workspace contents
  try {
    const entries = await readdir(ctx.workspaceDir);
    if (entries.length > 0) {
      parts.push("## Workspace Files\n");
      parts.push(entries.slice(0, 20).map(e => `- ${e}`).join("\n"));
      if (entries.length > 20) parts.push(`\n... and ${entries.length - 20} more`);
    }
  } catch { /* empty workspace */ }

  // Progress summary
  try {
    const progress = await readFile(join(ctx.workspaceDir, "PROGRESS.json"), "utf-8");
    const parsed = JSON.parse(progress);
    if (parsed.remaining?.length) {
      parts.push("\n## Outstanding Work\n");
      parts.push(parsed.remaining.map((r: string) => `- ${r}`).join("\n"));
    }
  } catch { /* no progress file */ }

  // Available tools
  const enabledTools = Object.entries(config.tools)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  parts.push(`\n## Available Tools\n${enabledTools.join(", ")}`);

  return parts.join("\n");
}
```

**Touches:**
- `src/agent.ts` — `buildSystemPrompt()` calls `buildEnvironmentContext()`
- New helper function in `src/agent.ts` (or extracted to `src/environment.ts` if large)

---

### B6. Shared Sub-Agent Scratchpad

**What:** Give sub-agents access to a shared scratch directory so they can pass intermediate results to each other without bloating the parent's context.

**Why:** LangChain Deep Agents pattern. Researcher writes findings to shared space. Deep-thinker reads them. Writer composes from them. Parent context stays clean.

**Spec:**

- New directory: `workspace/.scratch/` — shared across parent and all sub-agents
- Sub-agent tool lists gain read/write access to `.scratch/`:
  - Researcher: add `write_file` access to `.scratch/` only (not workspace root)
  - Deep-thinker: add `read_file` access to `.scratch/`
  - Writer: add `read_file` and `write_file` access to `.scratch/`
- Parent agent prompt includes: "Sub-agents can share intermediate results via `workspace/.scratch/`. Direct sub-agents to write findings there for other sub-agents to read."

**Implementation approach:**

Sub-agents already have scoped tool access. The cleanest approach is to add a dedicated `scratchpad` MCP server (similar to workspace but scoped to `.scratch/`):
- `src/tools/scratchpad.ts` — read, write, list tools scoped to `workspace/.scratch/`
- Register in sub-agent tool lists

**Alternative simpler approach:** Just add `.scratch/` guidance to sub-agent system prompts and let them use existing workspace tools. This works if workspace tools are available to sub-agents (check: researcher currently has `read_file` from workspace but not `write_file`).

**Touches:**
- `src/tools/scratchpad.ts` — New file, minimal tool set (read, write, list)
- `src/tools/index.ts` — Register scratchpad server
- `src/agents/researcher.ts` — Add scratchpad write tool
- `src/agents/deep-thinker.ts` — Add scratchpad read tool
- `src/agents/writer.ts` — Add scratchpad read+write tools
- `src/agents/index.ts` — Pass scratchpad tools to sub-agents

---

### B7. Sub-Agent Response Condensation Guidelines

**What:** Update sub-agent system prompts to return condensed results with source citations.

**Why:** HumanLayer found that sub-agents returning verbose results pollute the parent context. Condensed results with `filepath:line` or URL citations keep the parent in the "smart zone" while preserving navigability.

**Spec:**

Update all three sub-agent prompts to append:

```
## Response Format

Return results in a condensed, scannable format:
- Lead with the direct answer to what was asked
- Use bullets and headers for structure
- Cite sources as `filepath:line` for code or URLs for web content
- Do NOT include raw file contents or full web pages — extract and summarize
- If the parent needs more detail, it can follow your citations
- Keep total response under 2000 words unless the task explicitly requires more
```

**Touches:**
- `src/agents/researcher.ts` — Append response format to prompt
- `src/agents/deep-thinker.ts` — Append response format to prompt
- `src/agents/writer.ts` — Append response format to prompt (writer gets a higher word limit since its job is drafting)

---

## Implementation Order

Organize into waves for parallel execution:

### Wave 1: Quick Wins (hooks + prompts, no new deps)
These are all internal changes — system prompt improvements and hook logic.

| Item | Files | Effort |
|------|-------|--------|
| B1. Pre-completion verification | `src/agent.ts`, `src/config.ts` | 1-2 hours |
| B2. Loop detection | `src/agent.ts`, `src/config.ts` | 1-2 hours |
| B4. Structured progress tracking | `src/agent.ts` (prompt only) | 30 min |
| B5. Environment onboarding | `src/agent.ts` | 1-2 hours |
| B7. Sub-agent response condensation | `src/agents/*.ts` | 30 min |

### Wave 2: Tool Additions (new MCP servers)
New tool implementations that extend agent capabilities.

| Item | Files | Effort |
|------|-------|--------|
| B3. Silent success / verbose failure | `src/agent.ts` or `src/tools/shell.ts`, `src/config.ts` | 1-2 hours |
| B6. Shared sub-agent scratchpad | `src/tools/scratchpad.ts`, `src/tools/index.ts`, `src/agents/*.ts` | 2-3 hours |

### Wave 3: A2A Foundation (new dependency, new module)
Core A2A integration — server and client.

| Item | Files | Effort |
|------|-------|--------|
| A1. Agent server mode | `src/a2a/server.ts`, `src/a2a/agent-card.ts`, `src/a2a/executor.ts`, `src/index.tsx` | 4-6 hours |
| A2. A2A client tool | `src/tools/a2a.ts`, `src/tools/index.ts`, `src/config.ts` | 2-3 hours |
| A5. Agent card generation | `src/index.tsx`, `src/a2a/agent-card.ts` | 1 hour (reuses A1) |

### Wave 4: A2A Extensions (builds on Wave 3)

| Item | Files | Effort |
|------|-------|--------|
| A3. A2A agent registry | `src/config.ts`, `src/tools/a2a.ts` | 1-2 hours |
| A4. Sub-agent type: A2A remote | `src/agents/index.ts` (pending SDK investigation) | 2-3 hours or skip |

---

## Config Schema After All Changes

```yaml
model: claude-opus-4-6[1m]
defaultAgent: cofounder
effort: max

tools:
  memory: { enabled: true }
  workspace: { enabled: true }
  web: { enabled: true }
  shell: { enabled: true }
  tasks: { enabled: true }
  introspection: { enabled: true }
  models: { enabled: true }
  a2a: { enabled: true }           # NEW — A2A client tools

hooks:
  logToolUse: false
  verifyBeforeComplete: true        # NEW — pre-completion verification
  loopDetection: true               # NEW — doom loop detection
  loopDetectionThreshold: 3         # NEW — edits before warning
  compactSuccessOutput: true        # NEW — truncate successful output
  compactOutputThreshold: 50        # NEW — max lines for success

a2a:                                # NEW — A2A configuration
  enabled: true
  port: 4000                        # default port for --serve mode
  agents:                           # registered remote agents
    # example:
    #   data-pipeline:
    #     url: http://data-agent.internal:4000
    #     description: "LangGraph data pipeline agent"
```

---

## New File Summary

| File | Purpose |
|------|---------|
| `src/a2a/index.ts` | A2A module exports |
| `src/a2a/server.ts` | Express A2A server setup |
| `src/a2a/agent-card.ts` | Agent Card generation from IDENTITY.md |
| `src/a2a/executor.ts` | AgentExecutor bridging A2A → harness |
| `src/tools/a2a.ts` | A2A client MCP tools (discover, call, list) |
| `src/tools/scratchpad.ts` | Shared sub-agent scratchpad tools |

## Modified File Summary

| File | Changes |
|------|---------|
| `src/agent.ts` | System prompt additions (verification, progress, environment), enhanced hooks (loop detection, compact output) |
| `src/config.ts` | New config sections (hooks expansion, a2a) |
| `src/tools/index.ts` | Register a2a and scratchpad servers |
| `src/agents/index.ts` | Potentially register A2A remote agents |
| `src/agents/researcher.ts` | Response condensation prompt, scratchpad tools |
| `src/agents/deep-thinker.ts` | Response condensation prompt, scratchpad tools |
| `src/agents/writer.ts` | Response condensation prompt, scratchpad tools |
| `src/index.tsx` | `--serve`, `--port`, `--card` flags |
| `package.json` | New deps: `@a2a-js/sdk`, `express`, `@types/express` |

---

## Open Questions for Planning

1. **SDK PostToolUse hook capabilities** — Can PostToolUse modify the tool result that enters context? If not, B3 needs to be implemented at the tool level.
2. **SDK AgentDefinition extensibility** — Can we register A2A remote agents as sub-agents (A4)? Or does the SDK require all agents to be local?
3. **A2A SDK v0.3 vs v1.0** — The JS SDK is at v0.3. v1.0 changes are mechanical (enum casing, Part type unification). Do we build on v0.3 and migrate, or wait? Recommendation: build on v0.3, migrate later — the protocol surface is small.
4. **Express in the dependency tree** — Express adds ~30 deps. Alternative: use Node's built-in `http` module with a thin JSON-RPC handler. Tradeoff: more code vs. fewer deps. The A2A SDK's `A2AExpressApp` helper makes Express the path of least resistance.
