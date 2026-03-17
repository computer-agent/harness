import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const exec = promisify(execFile);

async function validateWorkspacePath(workspaceDir: string, userPath: string): Promise<string> {
  const resolved = resolve(workspaceDir, userPath);
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error("Path must be within workspace");
  }
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(workspaceDir)) {
      throw new Error("Path resolves outside workspace (symlink detected)");
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") return resolved;
    throw err;
  }
}

export function createWorkspaceTools(workspaceDir: string) {
  const listFiles = tool(
    "list_files",
    "List files and directories in the workspace.",
    {
      path: z.string().optional().describe("Subdirectory relative to workspace root to list. Omit for top-level."),
      include_files: z.boolean().optional().describe("Include files in listing, not just directories. Default: false"),
    },
    async ({ path, include_files = false }) => {
      try {
        const target = path ? await validateWorkspacePath(workspaceDir, path) : workspaceDir;
        const entries = await readdir(target, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith("."))
          .filter((e) => include_files || e.isDirectory())
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { content: [{ type: "text" as const, text: items.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err?.message ?? `Could not list '${path}'.` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const readWorkspaceFile = tool(
    "read_file",
    "Read a file from the workspace.",
    {
      path: z.string().describe("Path relative to workspace root."),
    },
    async ({ path }) => {
      try {
        const target = await validateWorkspacePath(workspaceDir, path);
        const text = await readFile(target, "utf-8");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        if (err?.message?.includes("workspace") || err?.message?.includes("symlink")) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        return { content: [{ type: "text" as const, text: `Could not read '${path}'.` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const writeWorkspaceFile = tool(
    "write_file",
    "Write or update a file in the workspace. Creates parent directories as needed.",
    {
      path: z.string().describe("Path relative to workspace root."),
      content: z.string().describe("Full file content to write"),
    },
    async ({ path, content }) => {
      try {
        const target = await validateWorkspacePath(workspaceDir, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf-8");
        return { content: [{ type: "text" as const, text: `Written: ${path}` }] };
      } catch (e: any) {
        if (e?.message?.includes("workspace") || e?.message?.includes("symlink")) {
          return { content: [{ type: "text" as const, text: e.message }] };
        }
        return { content: [{ type: "text" as const, text: `Could not write '${path}': ${e}` }] };
      }
    },
  );

  const editWorkspaceFile = tool(
    "edit_file",
    "Replace a specific string in a workspace file. Surgical edit — find exact text and replace it without rewriting the whole file.",
    {
      path: z.string().describe("Path relative to workspace root."),
      old_str: z.string().describe("Exact text to find (must be unique in the file)"),
      new_str: z.string().describe("Replacement text"),
    },
    async ({ path, old_str, new_str }) => {
      let target: string;
      try {
        target = await validateWorkspacePath(workspaceDir, path);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      let content: string;
      try {
        content = await readFile(target, "utf-8");
      } catch {
        return { content: [{ type: "text" as const, text: `Could not read '${path}'.` }] };
      }
      const indices: number[] = [];
      let idx = content.indexOf(old_str);
      while (idx !== -1) {
        indices.push(idx);
        idx = content.indexOf(old_str, idx + 1);
      }
      if (indices.length === 0) {
        return { content: [{ type: "text" as const, text: `String not found in '${path}'.` }] };
      }
      if (indices.length > 1) {
        const lines = indices.map((i) => content.slice(0, i).split("\n").length);
        return {
          content: [
            {
              type: "text" as const,
              text: `Multiple occurrences at lines ${lines.join(", ")}. Provide more context to make old_str unique.`,
            },
          ],
        };
      }
      const updated = content.slice(0, indices[0]) + new_str + content.slice(indices[0] + old_str.length);
      await writeFile(target, updated, "utf-8");
      return { content: [{ type: "text" as const, text: `Edited: ${path}` }] };
    },
  );

  const findFilesTool = tool(
    "find_files",
    "Find files by name pattern using fd. Fast, respects .gitignore. Use for locating files in the workspace.",
    {
      pattern: z.string().describe("Search pattern (regex by default, or use -g for glob), e.g. '*.md' or 'STRATEGY'"),
      path: z
        .string()
        .optional()
        .describe("Subdirectory relative to workspace root to search. Default: entire workspace."),
      glob: z.boolean().optional().describe("Use glob pattern instead of regex. Default: false"),
      type: z
        .enum(["f", "d"])
        .optional()
        .describe("Filter by type: 'f' for files, 'd' for directories. Default: both."),
      max_results: z.number().optional().describe("Max results to return. Default: 50"),
    },
    async ({ pattern, path, glob = false, type, max_results = 50 }) => {
      let target: string;
      try {
        target = path ? await validateWorkspacePath(workspaceDir, path) : workspaceDir;
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      const args = [pattern, target, "--color", "never", "--max-results", String(max_results)];
      if (glob) args.push("--glob");
      if (type) args.push("--type", type);

      try {
        const { stdout } = await exec("fd", args, { timeout: 10_000, maxBuffer: 512 * 1024 });
        const relative = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((p) => p.replace(workspaceDir, "").replace(/^\//, ""));
        return {
          content: [{ type: "text" as const, text: relative.length > 0 ? relative.join("\n") : "No matches." }],
        };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        if (e.stdout?.trim()) {
          const relative = e.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((p) => p.replace(workspaceDir, "").replace(/^\//, ""));
          return { content: [{ type: "text" as const, text: relative.join("\n") }] };
        }
        return { content: [{ type: "text" as const, text: `fd error: ${e.stderr || e.message}` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const grepFilesTool = tool(
    "grep_files",
    "Search file contents using ripgrep. Fast, respects .gitignore. Returns matching lines with file paths and line numbers.",
    {
      pattern: z.string().describe("Search pattern (regex)"),
      path: z
        .string()
        .optional()
        .describe("Subdirectory relative to workspace root to search. Default: entire workspace."),
      glob: z.string().optional().describe("File glob filter, e.g. '*.ts' or '*.md'"),
      ignore_case: z.boolean().optional().describe("Case-insensitive search. Default: false"),
      context: z.number().optional().describe("Lines of context around matches. Default: 0"),
      max_results: z.number().optional().describe("Max matching lines. Default: 100"),
    },
    async ({ pattern, path, glob: fileGlob, ignore_case = false, context = 0, max_results = 100 }) => {
      let target: string;
      try {
        target = path ? await validateWorkspacePath(workspaceDir, path) : workspaceDir;
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }
      const args = [pattern, target, "--color", "never", "--no-heading", "--line-number", "--max-count", "50"];
      if (fileGlob) args.push("--glob", fileGlob);
      if (ignore_case) args.push("--ignore-case");
      if (context > 0) args.push("--context", String(context));

      try {
        const { stdout } = await exec("rg", args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
        const lines = stdout.trim().split("\n").filter(Boolean);
        const truncated = lines.slice(0, max_results);
        const relative = truncated.map((l) => l.replace(workspaceDir, "").replace(/^\//, ""));
        let result = relative.join("\n");
        if (lines.length > max_results) result += `\n\n(${lines.length - max_results} more matches truncated)`;
        return { content: [{ type: "text" as const, text: result || "No matches." }] };
      } catch (err: unknown) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
        // rg exits 1 for no matches
        if (e.code === 1) return { content: [{ type: "text" as const, text: "No matches." }] };
        return { content: [{ type: "text" as const, text: `rg error: ${e.stderr || e.message}` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return [listFiles, readWorkspaceFile, writeWorkspaceFile, editWorkspaceFile, findFilesTool, grepFilesTool];
}
