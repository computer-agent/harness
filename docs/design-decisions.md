# Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Standalone | Reads format directly | Independence, simpler install, no coupling |
| Tools discovered at runtime | Agent adapts to harness | Portable definitions, no dep declarations |
| In-process MCP servers | One server per tool domain | No external processes, fast, simple |
| Config-driven tool enable/disable | `config.yaml` controls what's available | User controls their environment |
| Legacy format fallback (planned) | IDENTITY.md will still work | Don't break existing agents |
| tsx as runtime | No build step for JSX | Simpler than bundling React/Ink |
| `~/.mastersof-ai/` home dir | Global config + agents + state | Standard Unix convention |
| Memory as a tool | Not baked into core | Just another context source |
| Sub-agents as .md files (planned) | Same format as primary agents | Uniform, composable, portable |
| Bubblewrap sandbox | Optional `--sandbox` flag | Isolate agent filesystem access without Docker overhead |
| A2A protocol via `--serve` | Express server, not embedded in TUI | Agents are services or CLI tools — same code, different entry point |
| A2A client as MCP tool | `a2a_discover` / `a2a_call` / `a2a_list` | Agents call external agents the same way they use any tool — discoverable at runtime |
| Agent Card from IDENTITY.md | Parse H2 sections as skills | No separate card file to maintain — identity is the source of truth |
| Sub-agent scratchpad | Dedicated `.scratch/` tool, not workspace | Scoped access, path confinement, clear separation from workspace files |
| Verification hook | System prompt + canUseTool tracking | Dual approach — prompt sets expectations, hook enforces verify-after-write |
| Loop detection | canUseTool edit counter | Lightweight, resets on verification, configurable threshold |
| Compact success output | PostToolUse hook truncation | Keeps context clean — failures stay verbose, successes get summarized |
