import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT = 30_000;

export function createShellTools(defaultCwd: string, agentEnv: Record<string, string> = {}) {
  const shellExec = tool(
    "shell_exec",
    "Execute a shell command. Runs in the current directory by default. Use for running tests, compiling, git operations, deployments — anything you'd do in a terminal.",
    {
      command: z.string().describe("The command to run, e.g. 'npm test', 'git status', 'ls -la'"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory relative to current directory. Default: current directory"),
      timeout: z.number().optional().describe("Timeout in ms. Default: 30000"),
    },
    async ({ command, cwd, timeout = DEFAULT_TIMEOUT }) => {
      const workDir = cwd ? join(defaultCwd, cwd) : defaultCwd;

      try {
        const { stdout, stderr } = await exec("sh", ["-c", command], {
          cwd: workDir,
          timeout,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...agentEnv },
        });

        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += `${output ? "\n--- stderr ---\n" : ""}${stderr}`;

        return { content: [{ type: "text" as const, text: output || "(no output)" }] };
      } catch (err: unknown) {
        const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; message: string };
        let output = `Exit code: ${e.code ?? "unknown"}\n`;
        if (e.stdout) output += e.stdout;
        if (e.stderr) output += `${e.stdout ? "\n--- stderr ---\n" : ""}${e.stderr}`;
        if (e.killed) output += "\n(process killed — timeout exceeded)";

        return { content: [{ type: "text" as const, text: output || e.message }] };
      }
    },
  );

  return [shellExec];
}
