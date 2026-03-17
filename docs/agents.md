# Agents

## Agent Loading

The harness reads agent definitions from `~/.mastersof-ai/agents/`.

### Resolution

Each agent is a directory under `agents/` containing an `IDENTITY.md` file:

```
~/.mastersof-ai/agents/{name}/
├── IDENTITY.md          — Plain markdown, becomes the system prompt
├── .env                 — Encrypted secrets via dotenvx (optional, see docs/secrets.md)
├── sandbox.json         — Per-agent sandbox config (optional, see docs/sandbox.md)
└── memory/
    └── CONTEXT.md       — Persistent memory (optional)
```

`resolveAgent(name)` checks that `agents/{name}/` exists and contains `IDENTITY.md`. If either is missing, the harness exits with an error.

### System Prompt Assembly

```
[Agent identity — IDENTITY.md content]
[Persistent memory — CONTEXT.md, if present]
[Current date, time, and timezone]
[Workspace path]
[Environment onboarding — workspace files, outstanding work, available tools]
[Verification protocol — if hooks.verifyBeforeComplete is true]
[Session continuity — PROGRESS.json guidance]
[Sub-agent coordination — scratchpad guidance, if scratchpad tool enabled]
```

The identity file is loaded as-is (no frontmatter parsing). Memory is wrapped with a header explaining it's accumulated context from previous sessions. Date/time uses the system timezone. The environment section lists workspace files (top-level, max 20), any outstanding items from PROGRESS.json, and enabled tool domains.

## Sub-Agents

The harness supports sub-agent delegation — the primary agent can spawn specialized agents for tasks like research, deep thinking, or writing.

### Current Implementation

Sub-agents are defined in TypeScript (`src/agents/*.ts`). Each has a name, model, system prompt, and tool access. They are registered via `createAgentRegistry()` and passed to the Claude Agent SDK.

Each sub-agent specifies `maxTurns` to prevent runaway loops and `disallowedTools` for explicit safety constraints:

| Sub-agent | maxTurns | disallowedTools |
|-----------|----------|-----------------|
| researcher | 30 | file write, shell exec |
| deep-thinker | 15 | file write, shell exec |
| writer | 20 | shell exec |

## Sub-Agent Scratchpad

Sub-agents coordinate through a shared `.scratch/` directory in the agent's workspace. The parent agent directs sub-agents to write intermediate results there rather than returning everything through the parent's context window. The scratchpad tool (`scratchpad_read`, `scratchpad_write`, `scratchpad_list`) provides scoped access — paths are confined to `.scratch/`.

## Persistent Memory

Agents read and write to `~/.mastersof-ai/agents/{name}/memory/`. The primary file is `CONTEXT.md`, which accumulates context across sessions. Memory is exposed as a tool — agents decide when and what to remember.
