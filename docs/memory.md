# Memory System

Agents accumulate context across sessions through a two-layer persistent memory system: automatic context injection at startup, and explicit tools for reading and writing memory during a session.

## Why This Exists

LLM conversations are ephemeral. When a session ends, everything the agent learned — decisions made, strategies discussed, user preferences discovered — vanishes. Session replay (resuming old conversations) solves continuity within a single thread, but agents need to carry forward *distilled knowledge* across unrelated sessions.

The memory system gives agents a persistent scratch space they control. No automatic summarization, no RAG pipeline, no hidden magic. The agent decides what matters enough to remember and writes it to disk. What's on disk survives. What isn't doesn't.

## Two Layers

### Layer 1: Auto-Loaded Context (Passive)

At startup, the harness checks for `CONTEXT.md` in the agent's memory directory. If present, its contents are injected into the system prompt:

```
[Agent identity — IDENTITY.md]
[Persistent memory — CONTEXT.md, if present]
[Current date, time, timezone]
[Workspace path]
[Environment onboarding]
[Verification protocol]
[Session continuity]
[Sub-agent coordination]
```

The agent sees this context immediately — no tool call needed. This is the "what you already know" layer. A fresh agent with no `CONTEXT.md` starts with a blank slate. An experienced agent starts with accumulated knowledge.

### Layer 2: Memory Tools (Active)

During a session, agents have five tools for managing memory:

| Tool | Purpose |
|------|---------|
| `memory_read` | Read any file from the memory directory |
| `memory_write` | Write or overwrite a memory file |
| `memory_replace` | Surgical string replacement (must be unique match) |
| `memory_insert` | Insert text at a specific line |
| `memory_list` | List all memory files |

These are standard MCP tools — the agent discovers them at runtime like any other tool. Nothing about the memory system is hardcoded into agent definitions.

## Storage

```
~/.mastersof-ai/agents/{name}/memory/
├── CONTEXT.md       — Primary memory (auto-loaded into system prompt)
├── strategy.md      — Whatever the agent decides to track
├── decisions.md     — Whatever the agent decides to track
└── ...              — No schema imposed
```

Memory is per-agent and fully isolated. The `researcher` agent's memory is separate from the `analyst` agent's memory. There's no shared memory across agents (by design — agents have different contexts and concerns).

## Design Philosophy

**Agent-controlled, not automatic.** The harness never writes to memory on the agent's behalf. No auto-summarization at session end, no background indexing, no decay algorithms. The agent calls `memory_write` when it has something worth persisting, or it doesn't. This is deliberate:

- Agents know what's important in their domain better than a generic summarizer
- Explicit writes are debuggable — you can read the memory files and see exactly what persisted
- No surprise context pollution from bad auto-summaries

**Files, not databases.** Memory is plain markdown files on disk. You can read them, edit them, back them up, or delete them with standard tools. An agent's memory is inspectable and portable.

**`CONTEXT.md` is the primary file, not the only file.** Only `CONTEXT.md` is auto-loaded into the system prompt. But agents can create and read any number of additional memory files. This lets agents organize knowledge — keep the system prompt lean with high-level context in `CONTEXT.md`, and store detailed reference material in separate files they read on demand.

## Configuration

Memory tools are enabled by default. Disable them in `~/.mastersof-ai/config.yaml`:

```yaml
tools:
  memory:
    enabled: false
```

When disabled, memory tools are not registered as MCP servers. The `CONTEXT.md` auto-load still works — it's part of system prompt assembly, not the tool system.

## How It Compares

| Approach | Tradeoff |
|----------|----------|
| **Session replay** (resume) | Preserves full context but only within one conversation thread |
| **Auto-summarization** | Convenient but lossy — the model decides what to compress, often badly |
| **RAG / vector search** | Good for large knowledge bases, overkill for agent working memory |
| **Explicit memory tools** (this system) | Agent decides what to persist, nothing is lost or hallucinated, fully inspectable |

The harness uses session replay *and* memory. They complement each other: resume a session for continuity within a thread, memory for knowledge that spans sessions.
