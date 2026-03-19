import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, buildSystemPrompt, sendMessage } from "../agent.js";
import { AgentNotFoundError, resolveAgent } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { loadAgentEnv } from "../env.js";
import { formatError } from "../errors.js";
import { extractSdkEvent } from "../sdk-stream.js";

/** Stream SDK query output to stdout — shared by `run` and `--message` */
export async function streamToStdout(stream: Query): Promise<void> {
  let responseBuffer = "";
  for await (const msg of stream) {
    // W8.1-T06: Use extractSdkEvent() instead of raw `(msg as any).event` casts
    const event = extractSdkEvent(msg);
    if (!event) continue;

    if (event.kind === "text_token") {
      process.stdout.write(event.text);
      responseBuffer += event.text;
    } else if (event.kind === "assistant" && !responseBuffer && event.textContent) {
      process.stdout.write(event.textContent);
      responseBuffer = event.textContent;
    }
  }
  process.stdout.write("\n");
}

export async function cliRun(agentName: string | undefined, message: string, config: HarnessConfig): Promise<void> {
  if (!agentName || !message) {
    console.error('Usage: mastersof-ai run <agent> "message"');
    process.exit(1);
  }

  let agentContext: ReturnType<typeof resolveAgent>;
  try {
    agentContext = resolveAgent(agentName);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);
  const startTime = Date.now();
  let exitCode = 0;

  try {
    const { systemPrompt, manifest } = await buildSystemPrompt(agentContext, config);
    const toolFilter = manifest.frontmatter.tools ?? undefined;
    const credentialsConfig = manifest.frontmatter.credentials ?? undefined;
    const allowedDomains = manifest.frontmatter.sandbox?.allowedDomains;
    const toolOperations = manifest.frontmatter.toolOperations ?? undefined;
    const options = buildOptions(
      agentContext,
      {
        systemPrompt,
        cwd: agentContext.workspaceDir,
        agentEnv: agentEnvKeys,
        credentialsConfig,
        allowedDomains,
        toolFilter,
        toolOperations,
        mcpConfigs: manifest.frontmatter.mcp,
      },
      config,
    );
    await streamToStdout(sendMessage(message, options));
  } catch (err) {
    console.error("");
    console.error(formatError(err));
    exitCode = 1;
  }

  // W2-T07: Append run record to runs.jsonl
  const durationMs = Date.now() - startTime;
  const runRecord = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    message: message.slice(0, 200),
    exitCode,
    durationMs,
  };

  try {
    mkdirSync(agentContext.stateDir, { recursive: true });
    const runsPath = join(agentContext.stateDir, "runs.jsonl");
    appendFileSync(runsPath, `${JSON.stringify(runRecord)}\n`);
  } catch {
    // Best-effort logging — don't fail the run
  }

  process.exit(exitCode);
}
