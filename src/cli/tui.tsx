import { render } from "ink";
import React from "react";
import { buildOptions, buildSystemPrompt, sendMessage } from "../agent.js";
import { AgentNotFoundError, DEFAULT_AGENT, resolveAgent } from "../agent-context.js";
import { App } from "../components/App.js";
import type { HarnessConfig } from "../config.js";
import { loadAgentEnv } from "../env.js";
import { formatError } from "../errors.js";
import { setInkClear } from "../lib/ink-clear.js";
import { findSessionByName, listSessions, loadSession } from "../sessions.js";
import { streamToStdout } from "./run.js";

export async function cliTui(config: HarnessConfig, args: string[], agentName: string | null): Promise<void> {
  const name = agentName ?? config.defaultAgent ?? DEFAULT_AGENT;
  let agentContext: ReturnType<typeof resolveAgent>;
  try {
    agentContext = resolveAgent(name);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);

  // Sandbox gate
  const sandboxEnabled = args.includes("--sandbox");

  if (sandboxEnabled && !process.env.HARNESS_SANDBOXED) {
    try {
      (await import("node:child_process")).execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    } catch {
      console.error("Sandbox requires bubblewrap (bwrap) but it's not installed.");
      console.error("  Install: sudo apt install bubblewrap");
      process.exit(1);
    }

    const { loadSandboxConfig, execInSandbox } = await import("../sandbox.js");
    const sandboxConfig = loadSandboxConfig(agentContext, { autoCreate: true });
    if (!sandboxConfig) {
      console.error(`No sandbox config found at ~/.mastersof-ai/agents/${name}/sandbox.json`);
      process.exit(1);
    }
    const filteredArgv = process.argv.filter((a) => a !== "--sandbox" && a !== "--no-sandbox");
    execInSandbox(agentContext, sandboxConfig, filteredArgv, agentEnvKeys);
  }

  const sessionDirs = { sessionsDir: agentContext.sessionsDir, lastSessionFile: agentContext.lastSessionFile };

  // --message (headless mode)
  const messageIdx = args.indexOf("--message");

  if (messageIdx !== -1) {
    const message = args.slice(messageIdx + 1).join(" ");
    if (!message) {
      console.error('Usage: mastersof-ai --message "your message"');
      process.exit(1);
    }

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
      process.exit(1);
    }
  } else {
    // TUI mode
    const resumeIdx = args.indexOf("--resume");
    const isResume = resumeIdx !== -1;
    let initialSessionId: string | null = null;
    let initialSessionName: string | null = null;

    if (isResume) {
      const resumeArg =
        resumeIdx + 1 < args.length && !(args[resumeIdx + 1] ?? "").startsWith("--")
          ? (args[resumeIdx + 1] ?? null)
          : null;

      if (resumeArg) {
        const byId = await loadSession(sessionDirs, resumeArg);
        if (byId) {
          initialSessionId = byId.id;
          initialSessionName = byId.name;
        } else {
          const sessions = await listSessions(sessionDirs);
          const match = findSessionByName(resumeArg, sessions);
          if (match) {
            initialSessionId = match.id;
            initialSessionName = match.name;
          } else {
            console.error(`No session matching "${resumeArg}"`);
            process.exit(1);
          }
        }
      } else {
        const sessions = await listSessions(sessionDirs);
        if (sessions.length === 0) {
          console.error("No sessions found.");
          process.exit(1);
        }
        initialSessionId = sessions[0]?.id ?? null;
        initialSessionName = sessions[0]?.name ?? null;
      }
    }

    const instance = render(
      <App
        initialSessionId={initialSessionId}
        initialSessionName={initialSessionName}
        agentContext={agentContext}
        config={config}
        agentEnv={agentEnvKeys}
      />,
      { exitOnCtrlC: false },
    );
    setInkClear(instance.clear);
  }
}
