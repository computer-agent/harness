import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentNotFoundError, DEFAULT_AGENT, resolveAgent } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";

export async function cliStatus(targetAgent: string | undefined, config: HarnessConfig): Promise<void> {
  const name = targetAgent ?? config.defaultAgent ?? DEFAULT_AGENT;
  try {
    resolveAgent(name);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { getHomeDir } = await import("../config.js");

  const runsPath = join(getHomeDir(), "state", name, "runs.jsonl");
  try {
    const content = readFileSync(runsPath, "utf-8").trim();
    if (!content) {
      console.log(`No runs found for agent "${name}".`);
      process.exit(0);
    }
    const lines = content.split("\n").slice(-10);
    console.log(`Recent runs for "${name}":\n`);
    for (const line of lines) {
      try {
        const run = JSON.parse(line);
        const date = run.timestamp ? new Date(run.timestamp).toLocaleString() : "unknown";
        const status = run.exitCode === 0 ? "OK" : `FAIL(${run.exitCode})`;
        const duration = run.durationMs ? `${Math.round(run.durationMs / 1000)}s` : "?";
        console.log(`  ${date}  ${status}  ${duration}  ${(run.message ?? "").slice(0, 60)}`);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    console.log(`No runs found for agent "${name}".`);
  }
  process.exit(0);
}
