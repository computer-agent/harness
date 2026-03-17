import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function createScratchpadTools(workspaceDir: string) {
  const scratchDir = join(workspaceDir, ".scratch");

  const scratchpadRead = tool(
    "scratchpad_read",
    "Read a file from the shared scratchpad (.scratch/ directory). Used to read intermediate results left by other sub-agents.",
    {
      path: z.string().describe("Filename or path relative to .scratch/"),
    },
    async ({ path }) => {
      const target = resolve(scratchDir, path);
      if (!target.startsWith(`${resolve(scratchDir)}/`)) {
        return { content: [{ type: "text" as const, text: "Path must be within .scratch/" }] };
      }
      try {
        const text = await readFile(target, "utf-8");
        return { content: [{ type: "text" as const, text }] };
      } catch {
        return { content: [{ type: "text" as const, text: `Could not read '${path}' from scratchpad.` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const scratchpadWrite = tool(
    "scratchpad_write",
    "Write a file to the shared scratchpad (.scratch/ directory). Used to pass intermediate results to other sub-agents without bloating the parent context.",
    {
      path: z.string().describe("Filename or path relative to .scratch/"),
      content: z.string().describe("Content to write"),
    },
    async ({ path, content }) => {
      const target = resolve(scratchDir, path);
      if (!target.startsWith(`${resolve(scratchDir)}/`)) {
        return { content: [{ type: "text" as const, text: "Path must be within .scratch/" }] };
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf-8");
        return { content: [{ type: "text" as const, text: `Written: .scratch/${path}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Could not write '${path}': ${e}` }] };
      }
    },
  );

  const scratchpadList = tool(
    "scratchpad_list",
    "List files in the shared scratchpad (.scratch/ directory).",
    {
      path: z.string().optional().describe("Subdirectory within .scratch/ to list. Omit for top-level."),
    },
    async ({ path }) => {
      const target = path ? resolve(scratchDir, path) : scratchDir;
      if (path && !target.startsWith(`${resolve(scratchDir)}/`) && target !== resolve(scratchDir)) {
        return { content: [{ type: "text" as const, text: "Path must be within .scratch/" }] };
      }
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const items = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { content: [{ type: "text" as const, text: items.join("\n") || "(empty)" }] };
      } catch {
        return { content: [{ type: "text" as const, text: "(scratchpad empty or not yet created)" }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return [scratchpadRead, scratchpadWrite, scratchpadList];
}
