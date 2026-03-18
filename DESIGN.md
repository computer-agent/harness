# Masters Of AI Harness — Design

A standalone agent runtime with two interfaces. Write a markdown agent definition, run an agent — interactively via terminal TUI for single-user iteration, or as a web service via `--serve` for multi-user remote access. Both share the same agent runtime: IDENTITY.md loading, Claude Agent SDK, in-process MCP tools, sub-agents, sessions, and memory.

```
Terminal TUI:  mastersof-ai [--agent x]           → React/Ink, single user, local
Web UI:        mastersof-ai --serve [--port 3100] → Fastify + React SPA, multi-user, token auth
```

## Docs

- **[Architecture](docs/architecture.md)** — dual-interface model, source layout, tech stack
- **[Agents](docs/agents.md)** — agent loading, identity, frontmatter, sub-agents, scratchpad
- **[Memory](docs/memory.md)** — persistent memory system, auto-loaded context, memory tools
- **[Tools](docs/tools.md)** — tool system, available tools (scratchpad, A2A client), design principles
- **[Configuration](docs/configuration.md)** — config file, CLI, hooks, serve mode, access control, sessions
- **[Secrets](docs/secrets.md)** — per-agent encrypted secrets via dotenvx
- **[Sandbox](docs/sandbox.md)** — bubblewrap isolation, per-agent config
- **[Design Decisions](docs/design-decisions.md)** — rationale for key choices
- **[Changelog](CHANGELOG.md)** — version history and notable changes
