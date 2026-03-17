import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import React from "react";
import { buildOptions, buildSystemPrompt, sendMessage } from "./agent.js";
import { AgentNotFoundError, DEFAULT_AGENT, listAgents, resolveAgent } from "./agent-context.js";
import { App } from "./components/App.js";
import { loadConfig } from "./config.js";
import { AgentExistsError, createAgent } from "./create-agent.js";
import { loadAgentEnv } from "./env.js";
import { formatError } from "./errors.js";
import { isFirstRun, runFirstRun } from "./first-run.js";
import { setInkClear } from "./lib/ink-clear.js";
import { findSessionByName, listSessions, loadSession } from "./sessions.js";

// --- Global error safety net ---

process.on("unhandledRejection", (reason) => {
  console.error("");
  console.error(formatError(reason));
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("");
  console.error(formatError(err));
  process.exit(1);
});

// --- Arg parsing ---

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getFlagValue(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const val = args[idx + 1];
  if (val.startsWith("--")) return null;
  return val;
}

// --- Subcommand: create ---

if (args[0] === "create") {
  const name = args[1];
  if (!name) {
    console.error("Usage: mastersof-ai create <name>");
    process.exit(1);
  }
  if (isFirstRun()) runFirstRun();
  try {
    createAgent(name);
  } catch (err) {
    if (err instanceof AgentExistsError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  process.exit(0);
}

// --- Flag: --init ---

if (getFlag("init")) {
  runFirstRun();
  process.exit(0);
}

// --- First run check ---

if (isFirstRun()) {
  runFirstRun();
}

// --- Load config ---

const config = loadConfig();

// --- Flag: --list-agents ---

if (getFlag("list-agents")) {
  const agents = await listAgents();
  if (agents.length === 0) {
    console.log("No agents found. Create one with: mastersof-ai create <name>");
  } else {
    console.log("Available agents:\n");
    for (const agent of agents) {
      const isDefault = agent.id === config.defaultAgent;
      const marker = isDefault ? " (default)" : "";

      console.log(`  ${agent.displayName} [${agent.id}]${marker}`);
      if (agent.description) console.log(`    ${agent.description}`);

      // Tools
      const tools = agent.frontmatter.tools;
      if (tools?.allow) {
        console.log(`    tools: ${tools.allow.join(", ")}`);
      } else if (tools?.deny) {
        console.log(`    tools: all except ${tools.deny.join(", ")}`);
      }

      // Access
      if (agent.frontmatter.access !== "public") {
        const accessStr =
          agent.frontmatter.access === "users"
            ? `users: ${agent.frontmatter.users.join(", ")}`
            : agent.frontmatter.access;
        console.log(`    access: ${accessStr}`);
      }

      // Tags
      if (agent.frontmatter.tags.length > 0) {
        console.log(`    tags: ${agent.frontmatter.tags.join(", ")}`);
      }

      console.log(""); // blank line between agents
    }
  }
  process.exit(0);
}

// --- Auth check ---

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const credentialsPath = join(homedir(), ".claude", ".credentials.json");
const hasCredentials = existsSync(credentialsPath);

if (!hasApiKey && !hasCredentials) {
  console.error("No authentication found.");
  console.error("");
  console.error("The harness requires either:");
  console.error("  1. Claude Code: install and run 'claude login'");
  console.error("     npm install -g @anthropic-ai/claude-code && claude login");
  console.error("  2. API key: set ANTHROPIC_API_KEY environment variable");
  process.exit(1);
}

// Validate credential expiry when using OAuth (best-effort — token refresh may still work)
if (!hasApiKey && hasCredentials) {
  try {
    const creds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.expiresAt && typeof oauth.expiresAt === "number") {
      const expiresAt = new Date(oauth.expiresAt);
      const now = new Date();
      if (expiresAt < now && !oauth.refreshToken) {
        console.error("Claude credentials have expired and no refresh token is available.");
        console.error("");
        console.error("  Run: claude login");
        process.exit(1);
      }
      if (expiresAt < now) {
        // Token expired but refresh token exists — the SDK may refresh automatically.
        // Warn but don't block.
        console.error("Note: OAuth token expired — the SDK will attempt to refresh it.");
        console.error("  If this fails, run: claude login");
        console.error("");
      }
    }
  } catch {
    // Malformed credentials file
    console.error("Warning: Could not parse ~/.claude/.credentials.json");
    console.error("  If authentication fails, run: claude login");
    console.error("");
  }
}

// --- Flag: --serve (server mode) ---

if (getFlag("serve")) {
  const port = parseInt(getFlagValue("port") ?? "3000", 10);
  const host = getFlagValue("host") ?? "0.0.0.0";

  const { loadAccessConfig } = await import("./access.js");
  const { startServer } = await import("./serve.js");

  const access = loadAccessConfig();

  if (access.users.length === 0) {
    console.error("Warning: No tokens defined in ~/.mastersof-ai/access.yaml");
    console.error("All API requests will be rejected. Create access.yaml to enable access.");
    console.error("");
  }

  try {
    await startServer({ port, host, config, access });
  } catch (err) {
    console.error(formatError(err));
    process.exit(1);
  }
  // startServer blocks (Fastify listen keeps the process alive)
} else {
  // --- Resolve agent ---

  const agentName = getFlagValue("agent") ?? config.defaultAgent ?? DEFAULT_AGENT;
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

  // Load per-agent .env (encrypted or plaintext) — must happen before sandbox gate
  // so decrypted values are available for passthrough into bwrap
  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);

  // Sandbox gate: opt-in on all platforms via --sandbox flag
  const sandboxEnabled = getFlag("sandbox");

  if (sandboxEnabled && !process.env.HARNESS_SANDBOXED) {
    // Check for bwrap
    try {
      (await import("node:child_process")).execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    } catch {
      console.error("Sandbox requires bubblewrap (bwrap) but it's not installed.");
      console.error("  Install: sudo apt install bubblewrap");
      process.exit(1);
    }

    const { loadSandboxConfig, execInSandbox } = await import("./sandbox.js");
    const sandboxConfig = loadSandboxConfig(agentContext, { autoCreate: true });
    if (!sandboxConfig) {
      console.error(`No sandbox config found at ~/.mastersof-ai/agents/${agentName}/sandbox.json`);
      process.exit(1);
    }
    const filteredArgv = process.argv.filter((a) => a !== "--sandbox" && a !== "--no-sandbox");
    execInSandbox(agentContext, sandboxConfig, filteredArgv, agentEnvKeys);
  }

  const sessionDirs = { sessionsDir: agentContext.sessionsDir, lastSessionFile: agentContext.lastSessionFile };

  // --- Flag: --message (headless mode) ---

  const messageIdx = args.indexOf("--message");

  if (messageIdx !== -1) {
    const message = args.slice(messageIdx + 1).join(" ");
    if (!message) {
      console.error('Usage: mastersof-ai --message "your message"');
      process.exit(1);
    }

    try {
      const { systemPrompt, manifest } = await buildSystemPrompt(agentContext);
      const toolFilter = manifest.frontmatter.tools ?? undefined;
      const options = buildOptions(
        agentContext,
        { systemPrompt, cwd: agentContext.workspaceDir, agentEnv: agentEnvKeys, toolFilter },
        config,
      );
      const stream = sendMessage(message, options);

      let responseBuffer = "";

      for await (const msg of stream) {
        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            process.stdout.write(event.delta.text);
            responseBuffer += event.delta.text;
          }
        }

        if (msg.type === "assistant" && !responseBuffer) {
          const text = (msg as any).message?.content
            ?.filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
          if (text) {
            process.stdout.write(text);
          }
        }
      }
      process.stdout.write("\n");
    } catch (err) {
      console.error("");
      console.error(formatError(err));
      process.exit(1);
    }
  } else {
    // --- TUI mode ---

    const resumeIdx = args.indexOf("--resume");
    const isResume = resumeIdx !== -1;
    let initialSessionId: string | null = null;
    let initialSessionName: string | null = null;

    if (isResume) {
      const resumeArg =
        resumeIdx + 1 < args.length && !args[resumeIdx + 1].startsWith("--") ? args[resumeIdx + 1] : null;

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
        // No argument — resume most recent session
        // Use /sessions + /resume #N inside the TUI for browsing
        const sessions = await listSessions(sessionDirs);
        if (sessions.length === 0) {
          console.error("No sessions found.");
          process.exit(1);
        }
        initialSessionId = sessions[0].id;
        initialSessionName = sessions[0].name;
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
} // close the else block for --serve
