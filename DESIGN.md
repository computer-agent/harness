# Masters Of AI Harness — Design

A standalone agent runtime. Write a markdown agent definition, run an agent — interactively via TUI or as an A2A-compatible service via `--serve`. The harness reads `IDENTITY.md` files, connects them to a model via the Claude Agent SDK, provides tools via in-process MCP servers, and handles I/O through a React/Ink TUI or A2A protocol endpoints.

## Docs

- **[Architecture](docs/architecture.md)** — how it works, source layout, tech stack, A2A server mode
- **[Agents](docs/agents.md)** — agent loading, identity, sub-agents, scratchpad coordination
- **[Memory](docs/memory.md)** — persistent memory system, auto-loaded context, memory tools
- **[Tools](docs/tools.md)** — tool system, available tools (including scratchpad and A2A client), design principles
- **[Configuration](docs/configuration.md)** — config file, CLI, hooks, A2A config, first run, sessions
- **[Secrets](docs/secrets.md)** — per-agent encrypted secrets via dotenvx
- **[Sandbox](docs/sandbox.md)** — bubblewrap isolation, per-agent config
- **[Design Decisions](docs/design-decisions.md)** — rationale for key choices
