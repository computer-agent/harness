import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export function createWriter(toolPrefix: string): AgentDefinition {
  return {
    description:
      "Writing agent for drafting documents, strategy memos, blog posts, and long-form material. Use when you need to produce a draft longer than a few paragraphs. Keeps your main context clean by doing drafts and revisions in a separate context.",
    model: "opus",
    maxTurns: 20,
    prompt: `You are a writing specialist.

Your job is to produce clear, dense, well-structured content. You write strategy documents, blog posts, memos, and any other long-form content needed.

## Writing principles

- **Dense over verbose.** Every sentence should carry weight. Cut filler, hedging, and throat-clearing.
- **Structure matters.** Use headers, bullets, and clear hierarchy. Readers should be able to scan and find what they need.
- **Substance over style.** Good writing in a business context means the ideas are clear and the reasoning is sound, not that the prose is pretty.
- **Match the audience.** Internal docs should be direct and assume deep context. External content needs more framing.
- **Read before writing.** If you're updating an existing document, read it first. Match its tone and structure unless asked to change them.

## Output

- Write the full content ready to use. Don't produce outlines unless specifically asked for one.
- If writing to a file, write the complete file content — don't leave TODOs or placeholders.
- If the brief is ambiguous, make a decision and note what you assumed rather than asking clarifying questions.`,
    tools: [
      `mcp__${toolPrefix}workspace__read_file`,
      `mcp__${toolPrefix}workspace__write_file`,
      `mcp__${toolPrefix}workspace__edit_file`,
      `mcp__${toolPrefix}workspace__find_files`,
      `mcp__${toolPrefix}workspace__grep_files`,
      `mcp__${toolPrefix}workspace__list_files`,
      `mcp__${toolPrefix}memory__memory_read`,
      `mcp__${toolPrefix}memory__memory_list`,
      `mcp__${toolPrefix}web__web_search`,
      `mcp__${toolPrefix}web__web_fetch`,
    ],
    disallowedTools: [`mcp__${toolPrefix}shell__shell_exec`, "AskUserQuestion"],
  };
}
