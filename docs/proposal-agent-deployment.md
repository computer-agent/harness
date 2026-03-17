# Proposal: Frictionless Agent Deployment

**Goal:** Write an IDENTITY.md, maybe configure some tools, and a new agent appears in the web UI for partners/friends to use.

## The Core Tension

The harness was built for Chris running agents locally. Extending it to remote users introduces three problems that don't exist today:

1. **Trust boundary** -- Chris trusts his agents with shell_exec and full filesystem. Remote users' conversations run on Chris's infrastructure with Chris's API keys. The agent must be sandboxed not just from the system, but from other agents and other users.

2. **Tool surface** -- Today every agent gets every enabled tool. A CRE analyst doesn't need shell_exec. A writing assistant doesn't need the models tool. Tool access should be part of the agent definition, not a global config toggle.

3. **Discovery** -- Today `--list-agents` prints names. A web UI needs display names, descriptions, icons, conversation starters, categories. This metadata doesn't exist anywhere.

## Design Principles

- **IDENTITY.md stays the source of truth.** One file to create an agent. No separate registration step, no database entry, no deploy command.
- **Convention over configuration.** Sane defaults for everything. A bare IDENTITY.md with no frontmatter works -- you just get all tools, no access restriction, default model.
- **Align with the ecosystem, diverge where necessary.** AGENTS.md is for coding agents reading codebases. SKILL.md is for modular capabilities. Neither is for defining a conversational agent with tool permissions and access control. Take what fits, invent what's missing.
- **The agent directory is the deployment unit.** Everything about an agent lives in its directory. Copy the directory, you've deployed the agent.

## IDENTITY.md Format

YAML frontmatter (optional) + markdown body (the system prompt). This is the same pattern as SKILL.md and the proposed AGENTS.md v1.1, but with fields specific to agent deployment rather than coding guidance.

### Minimal (works today, keeps working)

```markdown
# My Agent

You are a helpful assistant that specializes in X.

## How to work

- Be concise.
- Use your tools when needed.
```

No frontmatter. Gets all enabled tools, default model, default effort, visible to all users, no sandbox restrictions beyond the global config. This is the current behavior -- nothing breaks.

### Full frontmatter

```yaml
---
# Display
name: CRE Analyst
description: Commercial real estate deal analysis and market research
icon: building          # emoji shortcode or path to image in agent dir
tags: [cre, analysis, real-estate]
starters:
  - "Analyze this deal: [paste details]"
  - "What's the cap rate environment in [market]?"
  - "Compare these two properties"

# Tools
tools:
  allow: [memory, web, workspace, tasks, models]
  # deny: [shell, introspection]    # alternative: deny list instead of allow list
mcp:
  - server: cre-mcp
    uri: https://mcp.mastersof.ai/cre
  - server: google-calendar
    uri: npx -y @anthropic-ai/google-calendar-mcp

# Model
model: claude-opus-4-6[1m]
effort: max

# Access
access: public              # public | private | users
users: [chris, jim]         # only when access: users

# Sandbox
sandbox:
  enforce: true             # always sandbox, even when run locally
  network: host
  mounts:
    - path: ~/data/cre
      mode: ro

# Sub-agents
agents:
  researcher:
    model: sonnet
    maxTurns: 30
    tools:
      allow: [web, workspace, memory]
---

# CRE Analyst

You are a commercial real estate analyst...
```

### Field Reference

**Display fields** -- metadata for the web UI card grid:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `name` | string | Directory name, capitalized | Display name in UI |
| `description` | string | First paragraph of body | Card description |
| `icon` | string | none | Emoji shortcode or filename |
| `tags` | string[] | [] | Categorization, filtering |
| `starters` | string[] | [] | Suggested first messages |

**Tool fields** -- what the agent can use:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `tools.allow` | string[] | all enabled | Allowlist of tool domains |
| `tools.deny` | string[] | [] | Denylist of tool domains |
| `mcp` | object[] | [] | Additional MCP servers |

Allow and deny are mutually exclusive. If `allow` is set, only those tools are available. If `deny` is set, all tools except those are available. If neither is set, all globally-enabled tools are available.

Tool domain names match the keys in `config.yaml`: `memory`, `web`, `workspace`, `shell`, `tasks`, `introspection`, `models`.

**Model fields:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `model` | string | from config.yaml | Override model for this agent |
| `effort` | string | from config.yaml | Override effort level |

**Access fields:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `access` | string | `public` | `public`, `private`, `users` |
| `users` | string[] | [] | Allowed user identifiers (when access: users) |

**Sandbox fields:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `sandbox.enforce` | boolean | false | Force sandbox even without --sandbox |
| `sandbox.network` | string | host | `host` or `none` |
| `sandbox.mounts` | object[] | [] | Additional bind mounts |

Sandbox fields in frontmatter replace `sandbox.json`. Having them in IDENTITY.md means the agent directory is truly self-contained. Migration: if `sandbox.json` exists, it takes precedence (backward compat), but new agents use frontmatter.

**Sub-agent fields:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `agents` | object | global registry | Override sub-agent config |
| `agents.{name}.model` | string | from sub-agent default | Model override |
| `agents.{name}.maxTurns` | number | from sub-agent default | Turn limit |
| `agents.{name}.tools` | object | from sub-agent default | Tool allow/deny |

## Why Not AGENTS.md Format

AGENTS.md solves a different problem. It tells coding agents how to work with a codebase: build commands, test commands, style rules. It's a README.md for machines.

Our IDENTITY.md defines what an agent **is** -- personality, capabilities, permissions, access control. AGENTS.md has no concept of tool permissions, model selection, access control, or sandbox configuration because those aren't relevant to its use case (a file that lives in a repo alongside code).

That said, the formats are compatible. Both are markdown with optional frontmatter. An agent could have both: AGENTS.md in a project repo telling it how to work on that codebase, and IDENTITY.md defining the agent itself. They serve different layers of the stack.

SKILL.md is closer -- it has `allowed-tools`, `metadata`, and a progressive disclosure model. But skills are modular capabilities, not autonomous agents. An agent might use skills; an agent is not a skill.

**Alignment choices:**
- YAML frontmatter (same as SKILL.md, proposed AGENTS.md v1.1)
- `name` and `description` in frontmatter (same field names as SKILL.md)
- `tags` for categorization (same as AGENTS.md v1.1)
- Markdown body as the operative content (universal)

**Divergences (necessary):**
- `tools.allow` / `tools.deny` -- neither AGENTS.md nor SKILL.md has deny-list semantics
- `access` / `users` -- no precedent; agents are deployed services, not repo files
- `sandbox` -- no precedent; AGENTS.md assumes the agent runs in the user's environment
- `starters` -- no precedent; conversation-specific
- `agents` (sub-agents) -- no precedent; hierarchical agent composition

## Tool Configuration: The Design Space

This is the hardest problem. There are three layers:

### Layer 1: Tool domain enable/disable (exists today)

`config.yaml` controls which tool domains exist at all. If `shell.enabled: false`, no agent gets shell. This is the operator's decision -- Chris deciding what capabilities his infrastructure offers.

**Keep as-is.** This is the global supply of tools.

### Layer 2: Per-agent tool access (new)

IDENTITY.md frontmatter controls which of the globally-enabled tools this agent can use. A CRE analyst gets `[memory, web, workspace, tasks, models]` but not `shell` or `introspection`.

**Implementation:** `createAgentServers()` currently reads `config.tools.*`. Add a filter step: after checking `config.tools.X.enabled`, also check whether the agent's frontmatter allows tool domain X. The agent's parsed frontmatter is already available in the `AgentContext` (it's loaded from IDENTITY.md at startup).

```
Global config (supply) → Agent frontmatter (demand) → Actual tool set
```

### Layer 3: Per-agent MCP servers (new)

Some agents need MCP servers that aren't built into the harness. The CRE analyst needs the CRE MCP server. A scheduling agent needs Google Calendar.

The `mcp` field in frontmatter declares additional MCP servers. These are merged with the harness-provided servers at startup.

Two forms:
- **URI-based**: `uri: https://mcp.mastersof.ai/cre` -- remote MCP server
- **Command-based**: `uri: npx -y @some/mcp-server` -- local process (only when not sandboxed, or with explicit mount config)

**Implementation:** After `createAgentServers()` builds the harness servers, iterate `frontmatter.mcp` and add entries to the `mcpServers` object passed to the SDK. The SDK already supports arbitrary MCP server configs.

### What about canUseTool?

Today `canUseTool` handles AskUserQuestion interception and logging. It could also enforce per-agent tool restrictions at the SDK level (as a safety net in addition to not providing the tools at all). Belt and suspenders.

For remote users, `canUseTool` becomes the enforcement point for any tool-level policy that can't be handled by simply not mounting the MCP server -- for example, rate limiting shell commands, or restricting web search to certain domains.

## Access Control: Minimum Viable Model

For 5 people, the model should be dead simple.

### Option A: Token-based (recommended for v1)

Each user gets an opaque token (UUID). The token maps to a set of allowed agent names. Stored in a simple YAML file on the server.

```yaml
# ~/.mastersof-ai/access.yaml
tokens:
  abc-123-def:
    name: Jim
    agents: [cre-analyst]
  xyz-789-ghi:
    name: Dave
    agents: [cre-analyst, assistant]
  all-access-token:
    name: Chris
    agents: "*"     # wildcard = all agents
```

The web UI sends the token with each request. The server looks up allowed agents and filters the roster. If the token isn't in the file, access denied.

**Why this works for 5 people:**
- No user accounts, no passwords, no OAuth
- Tokens are easy to generate, revoke, and rotate
- Agent-level granularity is sufficient
- The access file is on disk, version-controllable, auditable

**Why not API keys?** Tokens are for user access to the harness. The Anthropic API key is the harness's key, not the user's. Users never see or manage it.

### Option B: For later (10+ users)

OAuth via a provider (Google, GitHub). User identity maps to roles, roles map to agent sets. The `access` and `users` fields in IDENTITY.md become the role mapping. Not needed yet.

### The `access` field in IDENTITY.md

- `public` -- any authenticated user (any valid token) can use this agent
- `private` -- only the operator (Chris) can use this agent; excluded from the web UI roster
- `users: [jim, dave]` -- only these users (matched by `name` in access.yaml)

The web UI's agent card grid is the intersection of: agents where `access` permits this user AND this user's token allows the agent.

## Sandboxing for Remote Users

This is non-negotiable. When a remote user's conversation drives an agent, the agent runs with the remote user's trust level, not Chris's.

### Policy

1. **Remote agents always run sandboxed.** The web server sets `sandbox.enforce: true` on every agent invocation from a remote user. This overrides both the IDENTITY.md frontmatter and the `--sandbox` flag. The operator cannot accidentally expose an unsandboxed agent to remote users.

2. **The default sandbox is restrictive.** No shell access, no additional mounts, workspace-only filesystem, network allowed (for web tools). This is the starting point. The IDENTITY.md can relax specific constraints (add mounts, allow shell within sandbox), but cannot disable sandboxing.

3. **Shell access for remote agents requires explicit opt-in AND sandbox.** If an agent needs shell for remote users, IDENTITY.md must declare both `tools.allow: [... shell ...]` AND `sandbox.enforce: true`. The harness refuses to serve shell-enabled agents to remote users without sandbox enforcement.

4. **Per-user workspace isolation.** Each user gets their own workspace subdirectory under the agent's workspace: `~/.mastersof-ai/agents/{agent}/workspace/{user}/`. Conversations from different users never share a workspace. This prevents data leakage between users.

### Sandbox levels (conceptual)

| Level | Shell | Filesystem | Network | Use case |
|-------|-------|-----------|---------|----------|
| **restricted** | no | workspace only | yes | Default for remote. Research, analysis, writing. |
| **standard** | yes (sandboxed) | workspace + declared mounts | yes | Agents that need to run code. |
| **local** | yes | full | yes | Chris running locally. Not available to remote users. |

## Agent Manifest / Registry

Today the harness discovers agents by scanning `~/.mastersof-ai/agents/` for directories containing IDENTITY.md. This works. No manifest file needed.

For the web UI, the scan needs to return richer data. The function that currently does this:

```typescript
// Current: just finds names
const agents = entries
  .filter(e => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
  .map(e => e.name);
```

Becomes:

```typescript
// New: returns display metadata
const agents = entries
  .filter(e => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
  .map(e => loadAgentManifest(e.name));  // parses frontmatter, extracts display fields

interface AgentManifest {
  id: string;               // directory name
  name: string;             // frontmatter.name || capitalize(id)
  description: string;      // frontmatter.description || first paragraph
  icon?: string;
  tags: string[];
  starters: string[];
  access: "public" | "private" | "users";
  users?: string[];
}
```

**No separate manifest file.** The IDENTITY.md frontmatter IS the manifest. The harness parses it once at startup (or on file change, if hot-reloading) and caches the AgentManifest objects.

### Hot reload vs restart

For v1: restart required. The harness re-scans on startup.

For v2: watch `~/.mastersof-ai/agents/` for filesystem changes. When an IDENTITY.md is created, modified, or deleted, re-scan and update the in-memory roster. The web UI polls or gets pushed the updated roster. This gives the "drop a file, agent appears" experience.

## The "Just Works" Walkthrough

### Chris creates a new agent

```bash
# Option A: Use the CLI
mastersof-ai create cre-analyst

# Option B: Just create the directory
mkdir -p ~/.mastersof-ai/agents/cre-analyst
```

### Chris writes the IDENTITY.md

```yaml
---
name: CRE Analyst
description: Analyze commercial real estate deals, market data, and investment opportunities
icon: building
tags: [cre, analysis]
starters:
  - "Analyze this deal for me"
  - "What's the market like in [city]?"
tools:
  allow: [memory, web, tasks, models]
mcp:
  - server: cre-mcp
    uri: npx -y @mastersof-ai/cre-mcp
access: users
users: [jim, chris]
sandbox:
  enforce: true
---

# CRE Analyst

You are a commercial real estate analyst with deep expertise in...

## How to work

- Always start with the fundamentals: cap rate, NOI, price per unit...
```

### Chris restarts the server (v1) or the server hot-reloads (v2)

The harness scans the agents directory, finds `cre-analyst/IDENTITY.md`, parses the frontmatter, builds an AgentManifest, adds it to the roster.

### Jim opens the web UI

1. Jim navigates to the URL, enters his token (or it's saved in a cookie)
2. The UI requests the agent roster. The server filters: Jim's token allows `[cre-analyst]`, and `cre-analyst` has `access: users, users: [jim, chris]` -- Jim is in the list.
3. Jim sees one card: "CRE Analyst" with the building icon, description, and starter prompts.
4. Jim clicks a starter prompt or types his own message.
5. The server creates a sandboxed agent session:
   - Parses IDENTITY.md body as the system prompt
   - Creates MCP servers for `[memory, web, tasks, models]` only (per `tools.allow`)
   - Adds the CRE MCP server (per `mcp` config)
   - Workspace is `~/.mastersof-ai/agents/cre-analyst/workspace/jim/`
   - Sandbox enforced, workspace-only filesystem, network allowed
6. Jim has a conversation. The agent searches the web, queries market data via MCP, saves findings to memory.

### What could go wrong

| Failure | Cause | Mitigation |
|---------|-------|------------|
| Agent doesn't appear in UI | Frontmatter parse error | Validate on startup, log warnings, show agent anyway with defaults |
| MCP server fails to start | Bad URI, missing package | Agent loads without the MCP server, logs error, agent can still use built-in tools |
| Sandbox mount fails | Directory doesn't exist | Create directory or skip mount with warning |
| User can't access agent | Token/access mismatch | Clear error message: "You don't have access to this agent" |
| Agent tries to use denied tool | Bug in filtering | `canUseTool` enforces as backup; tool call returns "tool not available" |

## Implementation Phases

### Phase 1: Frontmatter parsing + tool filtering

- Add YAML frontmatter parsing to `loadIdentity()` (separate frontmatter from body)
- Add `AgentFrontmatter` type
- Modify `createAgentServers()` to accept tool allow/deny from frontmatter
- Modify `--list-agents` to show name/description from frontmatter
- Tests for frontmatter parsing, tool filtering

This gives immediate value even without the web UI. Chris can constrain tool access per agent in the TUI.

### Phase 2: Web UI + access control

- HTTP server that wraps the agent runtime
- Token-based auth with `access.yaml`
- Agent roster endpoint (filtered by user access)
- WebSocket or SSE for streaming responses
- Per-user workspace isolation

### Phase 3: MCP server configuration + hot reload

- `mcp` field in frontmatter, merged into mcpServers
- Filesystem watcher on agents directory
- Live roster updates pushed to connected web clients

### Phase 4: Sandbox enforcement for remote

- Automatic sandbox enforcement for remote sessions
- Per-user workspace subdirectories
- Sandbox policy validation (shell requires sandbox)

## Open Questions

1. **Frontmatter parser choice.** The `gray-matter` package is the standard for YAML frontmatter in markdown. Already a transitive dependency? If not, it's tiny. Alternatively, a simple regex split on `---` boundaries and `yaml.parse()` (already a dependency) works.

2. **Sub-agent definitions in frontmatter vs separate files.** The frontmatter `agents` field handles simple overrides (model, maxTurns, tools). But if an agent needs a custom sub-agent with a unique prompt, that's a lot of YAML. Should custom sub-agents be separate .md files in the agent directory? e.g., `agents/cre-analyst/sub-agents/data-collector.md`?

3. **MCP server lifecycle.** If an MCP server is declared in frontmatter, when does it start? Per-session (clean state each time) or per-agent (shared across sessions)? Per-session is safer for isolation but slower for servers that need to initialize.

4. **Memory isolation for remote users.** Should each user have their own memory, or share the agent's memory? Shared memory means Jim's research is available to Chris. Separate memory means the agent starts fresh per user. Both have value. Maybe: agent memory is shared (read-only for remote users), user memory is per-user (read-write).

5. **Cost tracking.** When remote users drive conversations on Chris's API key, how does cost get tracked per user? The SDK provides token counts. The harness should log per-session costs and attribute them to users. Not in scope for this proposal but worth flagging.
