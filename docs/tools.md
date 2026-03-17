# Tool System

Tools are in-process MCP servers, one per domain. Each can be enabled/disabled via config. Agents discover available tools at runtime — they don't declare dependencies.

## Available Tools

| Tool | What It Does | Scope |
|------|-------------|-------|
| **memory** | Read/write/search agent's persistent memory | `agents/{name}/memory/` |
| **web** | Web search and URL fetch | Internet |
| **workspace** | File operations (read, write, list, search) | `process.cwd()` |
| **shell** | Execute shell commands | `process.cwd()` |
| **tasks** | Lightweight task tracking | Agent-scoped |
| **introspection** | Read/propose changes to own identity | Agent's definition file |
| **models** | Query other Claude models | Anthropic API |
| **ask-user** | Structured multi-choice questions to the user mid-execution | TUI |

> **Note:** `ask-user` is the SDK built-in `AskUserQuestion` tool — the one SDK tool the harness uses directly rather than reimplementing as a custom MCP server. It is intercepted via `canUseTool` and rendered as an interactive selector in the TUI.

## Design Principle

Agents discover tools at runtime from the harness. An agent doesn't need to know what tools exist when it's defined — it adapts to what's available when it runs. Like a developer sitting down at a new workstation and figuring out what's installed.

This keeps agent definitions portable. The same agent definition works in a harness with all tools enabled or one with only memory and web.

## Implementation

Each tool is a separate MCP server in `src/tools/`. The server creation function in `src/tools/index.ts` reads the config and only instantiates enabled tools. Tool servers are passed to the Claude Agent SDK at startup.

## MCP Tool Search

As of SDK 0.2.62, MCP tool search is automatically enabled when tool descriptions exceed 10% of the context window. No configuration is required — the SDK defers less relevant tools and searches for them on demand. This is transparent to agents and requires no changes to tool definitions or config.
