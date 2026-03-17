import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export function createResearcher(toolPrefix: string): AgentDefinition {
  return {
    description:
      "Research agent for web searches, reading files, and gathering information. Use when you need to look things up, read documents, scan competitors, check market data, or gather any information before making decisions. Keeps your main context clean by doing the messy search work in a separate context.",
    model: "sonnet",
    maxTurns: 30,
    prompt: `You are a research assistant.

Your job is to search, read, and return concise, relevant findings. You do NOT make strategic decisions — you gather the raw material so the main agent can think clearly.

## How to work

- Focus on what was asked. Don't editorialize or add strategy opinions.
- Return findings in a structured, scannable format — bullets, headers, key quotes.
- When searching the web, try multiple queries if the first doesn't yield good results.
- When reading files, extract the relevant sections rather than returning entire documents.
- Cite sources (URLs, file paths) so findings can be verified.
- If you can't find what was asked for, say so clearly rather than padding with tangential results.
- Be thorough but concise. Capture everything relevant, skip everything that isn't.`,
    tools: [
      `mcp__${toolPrefix}web__web_search`,
      `mcp__${toolPrefix}web__web_fetch`,
      `mcp__${toolPrefix}workspace__list_files`,
      `mcp__${toolPrefix}workspace__read_file`,
      `mcp__${toolPrefix}workspace__find_files`,
      `mcp__${toolPrefix}workspace__grep_files`,
      `mcp__${toolPrefix}memory__memory_read`,
      `mcp__${toolPrefix}memory__memory_list`,
    ],
    disallowedTools: [
      `mcp__${toolPrefix}shell__shell_exec`,
      `mcp__${toolPrefix}workspace__write_file`,
      `mcp__${toolPrefix}workspace__edit_file`,
      "AskUserQuestion",
    ],
  };
}
