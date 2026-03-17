import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

async function validateMemoryPath(memoryDir: string, filename: string): Promise<string> {
  const resolved = resolve(memoryDir, filename);
  if (!resolved.startsWith(memoryDir)) {
    throw new Error("Path must be within memory directory");
  }
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(memoryDir)) {
      throw new Error("Path resolves outside memory directory (symlink detected)");
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") return resolved;
    throw err;
  }
}

export function createMemoryTools(memoryDir: string) {
  const memoryRead = tool(
    "memory_read",
    "Read a memory file from persistent memory. Use this to recall context from previous sessions — decisions made, strategies discussed, insights captured. Always check memory at the start of a conversation.",
    { filename: z.string().describe("Filename to read from memory directory, e.g. 'CONTEXT.md'") },
    async ({ filename }) => {
      try {
        const filepath = await validateMemoryPath(memoryDir, filename);
        const content = await readFile(filepath, "utf-8");
        return { content: [{ type: "text" as const, text: content }] };
      } catch (err: any) {
        if (err?.message?.includes("memory directory") || err?.message?.includes("symlink")) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        return { content: [{ type: "text" as const, text: `Memory file '${filename}' not found.` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const memoryWrite = tool(
    "memory_write",
    "Write or update a memory file in persistent memory. Use this to persist decisions, strategies, insights, and context that must survive across sessions. What's not on disk doesn't exist.",
    {
      filename: z.string().describe("Filename to write in memory directory, e.g. 'strategy.md'"),
      content: z.string().describe("Full content to write to the file"),
    },
    async ({ filename, content }) => {
      try {
        await mkdir(memoryDir, { recursive: true });
        const filepath = await validateMemoryPath(memoryDir, filename);
        await writeFile(filepath, content, "utf-8");
        return { content: [{ type: "text" as const, text: `Memory file '${filename}' written successfully.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
    },
  );

  const memoryReplace = tool(
    "memory_replace",
    "Replace a specific string in a memory file. Use this for surgical updates — changing a single line or value without rewriting the whole file.",
    {
      filename: z.string().describe("Filename in memory directory"),
      old_str: z.string().describe("Exact text to find (must be unique in the file)"),
      new_str: z.string().describe("Replacement text"),
    },
    async ({ filename, old_str, new_str }) => {
      let filepath: string;
      try {
        filepath = await validateMemoryPath(memoryDir, filename);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      let content: string;
      try {
        content = await readFile(filepath, "utf-8");
      } catch {
        return { content: [{ type: "text" as const, text: `Memory file '${filename}' not found.` }] };
      }
      const indices: number[] = [];
      let idx = content.indexOf(old_str);
      while (idx !== -1) {
        indices.push(idx);
        idx = content.indexOf(old_str, idx + 1);
      }
      if (indices.length === 0) {
        return { content: [{ type: "text" as const, text: `String not found in '${filename}'.` }] };
      }
      if (indices.length > 1) {
        const lines = indices.map((i) => content.slice(0, i).split("\n").length);
        return {
          content: [
            {
              type: "text" as const,
              text: `Multiple occurrences found at lines ${lines.join(", ")}. Provide more context to make old_str unique.`,
            },
          ],
        };
      }
      const updated = content.slice(0, indices[0]) + new_str + content.slice(indices[0] + old_str.length);
      await writeFile(filepath, updated, "utf-8");
      return { content: [{ type: "text" as const, text: `Replaced in '${filename}'.` }] };
    },
  );

  const memoryInsert = tool(
    "memory_insert",
    "Insert text at a specific line in a memory file. Line 0 inserts at the beginning; line N inserts after line N.",
    {
      filename: z.string().describe("Filename in memory directory"),
      line: z.number().int().min(0).describe("Line number to insert after (0 = beginning of file)"),
      text: z.string().describe("Text to insert"),
    },
    async ({ filename, line, text }) => {
      let filepath: string;
      try {
        filepath = await validateMemoryPath(memoryDir, filename);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      let content: string;
      try {
        content = await readFile(filepath, "utf-8");
      } catch {
        return { content: [{ type: "text" as const, text: `Memory file '${filename}' not found.` }] };
      }
      const lines = content.split("\n");
      if (line > lines.length) {
        return {
          content: [{ type: "text" as const, text: `Line ${line} is beyond end of file (${lines.length} lines).` }],
        };
      }
      lines.splice(line, 0, text);
      await writeFile(filepath, lines.join("\n"), "utf-8");
      return { content: [{ type: "text" as const, text: `Inserted at line ${line} in '${filename}'.` }] };
    },
  );

  const memoryList = tool(
    "memory_list",
    "List all files in the persistent memory directory. Use this to see what context is available from previous sessions.",
    {},
    async () => {
      try {
        const files = await readdir(memoryDir);
        const filtered = files.filter((f) => !f.startsWith("."));
        return {
          content: [
            { type: "text" as const, text: filtered.length > 0 ? filtered.join("\n") : "No memory files yet." },
          ],
        };
      } catch {
        return { content: [{ type: "text" as const, text: "Memory directory not found." }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return [memoryRead, memoryWrite, memoryReplace, memoryInsert, memoryList];
}
