import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// --- Shared headless stream processor ---

import type { Query } from "@anthropic-ai/claude-agent-sdk";

async function streamToStdout(stream: Query): Promise<void> {
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
        responseBuffer = text;
      }
    }
  }
  process.stdout.write("\n");
}

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
  const val = args[idx + 1] ?? "";
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

// --- Flag: --card (output Agent Card JSON and exit) ---

if (getFlag("card")) {
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

  const { buildAgentCard } = await import("./a2a/agent-card.js");
  const { loadIdentity } = await import("./prompt.js");
  const identity = await loadIdentity(agentContext.identityPath);
  const port = Number(getFlagValue("port")) || 4000;
  const card = buildAgentCard(agentContext.name, identity, { port });
  console.log(JSON.stringify(card, null, 2));
  process.exit(0);
}

// --- Subcommand: run <agent> "message" (headless execution with structured exit codes) ---

if (args[0] === "run") {
  const runAgent = args[1];
  const runMessage = args.slice(2).join(" ");

  if (!runAgent || !runMessage) {
    console.error('Usage: mastersof-ai run <agent> "message"');
    process.exit(1);
  }

  let agentContext: ReturnType<typeof resolveAgent>;
  try {
    agentContext = resolveAgent(runAgent);
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
    await streamToStdout(sendMessage(runMessage, options));
  } catch (err) {
    console.error("");
    console.error(formatError(err));
    exitCode = 1;
  }

  // W2-T07: Append run record to runs.jsonl
  const durationMs = Date.now() - startTime;
  const runRecord = {
    timestamp: new Date().toISOString(),
    agent: runAgent,
    message: runMessage.slice(0, 200),
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

// --- Subcommand: credentials migrate ---

if (args[0] === "credentials" && args[1] === "migrate") {
  const targetAgent = args[2] ?? config.defaultAgent ?? DEFAULT_AGENT;
  let agentContext: ReturnType<typeof resolveAgent>;
  try {
    agentContext = resolveAgent(targetAgent);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);
  const keys = Object.keys(agentEnvKeys).filter((k) => k !== "DOTENV_PRIVATE_KEY");

  if (keys.length === 0) {
    console.log(`No .env keys found for agent "${targetAgent}".`);
    process.exit(0);
  }

  console.log(`# Credential migration for agent "${targetAgent}"`);
  console.log("# Add this to your IDENTITY.md frontmatter:\n");
  console.log("credentials:");
  console.log("  grants:");
  console.log("    all-keys:");
  console.log(`      keys: [${keys.join(", ")}]`);
  console.log("      tools: [web]  # Restrict to specific tool domains as needed");
  console.log("");
  console.log("# Review and split grants by sensitivity level.");
  console.log("# Example: separate read-only keys from write keys,");
  console.log("# and add 'approval: required' for sensitive operations.");
  process.exit(0);
}

// --- Subcommand: credentials check --agent <name> (W7-T17) ---

if (args[0] === "credentials" && args[1] === "check") {
  const targetAgent = getFlagValue("agent") ?? args[2] ?? config.defaultAgent ?? DEFAULT_AGENT;
  let agentContext: ReturnType<typeof resolveAgent>;
  try {
    agentContext = resolveAgent(targetAgent);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);
  const { manifest } = await buildSystemPrompt(agentContext, config);
  const credsCfg = manifest.frontmatter.credentials;

  console.log(`Agent: ${targetAgent}`);
  if (!credsCfg?.grants) {
    console.log("Mode: legacy (no credentials config — all env keys available to all tools)");
    const keys = Object.keys(agentEnvKeys).filter((k) => k !== "DOTENV_PRIVATE_KEY");
    if (keys.length > 0) {
      console.log(`Keys: ${keys.join(", ")}`);
    } else {
      console.log("Keys: (none)");
    }
  } else {
    console.log("Mode: strict (credentials config present)");
    for (const [grantName, grant] of Object.entries(credsCfg.grants)) {
      const grantKeys = (grant as any).keys as string[];
      const tools = (grant as any).tools as string[];
      const approval = (grant as any).approval;
      const present = grantKeys.filter((k) => k in agentEnvKeys);
      const missing = grantKeys.filter((k) => !(k in agentEnvKeys));
      console.log(`\n  Grant: ${grantName}`);
      console.log(`    Tools: ${tools.join(", ")}`);
      if (approval) console.log(`    Approval: ${approval}`);
      if (present.length > 0) console.log(`    Present: ${present.join(", ")}`);
      if (missing.length > 0) console.log(`    MISSING: ${missing.join(", ")}`);
    }
  }
  process.exit(0);
}

// --- Subcommand: access create --name <name> --agents <list> (W7-T18) ---

if (args[0] === "access" && args[1] === "create") {
  const name = getFlagValue("name") ?? args[2];
  const agentsList = getFlagValue("agents") ?? "*";
  if (!name) {
    console.error("Usage: mastersof-ai access create --name <name> [--agents <a,b,...>]");
    process.exit(1);
  }

  const { generateAccessToken } = await import("./access.js");
  const { getHomeDir } = await import("./config.js");
  const { stringify } = await import("yaml");

  const { token, tokenHash } = generateAccessToken();
  const agents = agentsList === "*" ? "*" : agentsList.split(",").map((s) => s.trim());

  const entry = {
    token_hash: tokenHash,
    name,
    agents,
    budget: "unlimited",
  };

  const accessPath = join(getHomeDir(), "access.yaml");
  let existing: { users?: unknown[] } = { users: [] };
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const { parse } = await import("yaml");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed;
    } else {
      console.warn(`Warning: ${accessPath} exists but contains no valid YAML object. Starting fresh.`);
    }
  } catch (err: unknown) {
    // ENOENT = file doesn't exist → start fresh (normal).
    // Anything else = malformed YAML → warn and overwrite.
    if (err && typeof err === "object" && "code" in err && (err as any).code !== "ENOENT") {
      console.warn(`Warning: ${accessPath} could not be parsed. Existing content will be overwritten.`);
    }
  }

  if (!existing.users) existing.users = [];
  existing.users.push(entry);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(accessPath, stringify(existing), "utf-8");

  console.log(`Token created for "${name}"`);
  console.log(`Agents: ${typeof agents === "string" ? agents : agents.join(", ")}`);
  console.log(`\nRaw token (give to partner — shown once):\n  ${token}\n`);
  console.log(`Saved to: ${accessPath}`);
  process.exit(0);
}

// --- Subcommand: access rotate --name <name> (W7-T21) ---

if (args[0] === "access" && args[1] === "rotate") {
  const name = getFlagValue("name") ?? args[2];
  if (!name) {
    console.error("Usage: mastersof-ai access rotate --name <name>");
    process.exit(1);
  }

  const { generateAccessToken } = await import("./access.js");
  const { getHomeDir } = await import("./config.js");
  const { parse, stringify } = await import("yaml");

  const accessPath = join(getHomeDir(), "access.yaml");
  let existing: { users?: Array<{ token_hash: string; name: string; [k: string]: unknown }> };
  try {
    existing = parse(readFileSync(accessPath, "utf-8")) ?? { users: [] };
  } catch {
    console.error("No access.yaml found.");
    process.exit(1);
  }

  const userEntry = existing.users?.find((u) => u.name === name);
  if (!userEntry) {
    console.error(`User "${name}" not found in access.yaml.`);
    process.exit(1);
  }

  const { token, tokenHash } = generateAccessToken();
  const oldHash = userEntry.token_hash;
  userEntry.token_hash = tokenHash;

  const { writeFileSync } = await import("node:fs");
  writeFileSync(accessPath, stringify(existing), "utf-8");

  console.log(`Token rotated for "${name}"`);
  console.log(`Old hash: ${oldHash.slice(0, 12)}...`);
  console.log(`New hash: ${tokenHash.slice(0, 12)}...`);
  console.log(`\nNew raw token (give to partner — shown once):\n  ${token}\n`);
  console.log("The file watcher will disconnect active sessions using the old token.");
  process.exit(0);
}

// --- Subcommand: status <agent> (W7-T19) ---

if (args[0] === "status") {
  const targetAgent = args[1] ?? config.defaultAgent ?? DEFAULT_AGENT;
  // Validate agent name to prevent path traversal (review fix: Sec #7a)
  try {
    resolveAgent(targetAgent);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const { getHomeDir } = await import("./config.js");

  const runsPath = join(getHomeDir(), "state", targetAgent, "runs.jsonl");
  try {
    const content = readFileSync(runsPath, "utf-8").trim();
    if (!content) {
      console.log(`No runs found for agent "${targetAgent}".`);
      process.exit(0);
    }
    const lines = content.split("\n").slice(-10); // last 10 runs
    console.log(`Recent runs for "${targetAgent}":\n`);
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
    console.log(`No runs found for agent "${targetAgent}".`);
  }
  process.exit(0);
}

// --- Subcommand: preflight --agent <name> (W7-T20) ---

if (args[0] === "preflight") {
  const targetAgent = getFlagValue("agent") ?? args[1] ?? config.defaultAgent ?? DEFAULT_AGENT;
  let allOk = true;

  const check = (label: string, ok: boolean, detail?: string) => {
    const mark = ok ? "OK" : "FAIL";
    console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) allOk = false;
  };

  console.log(`Preflight check for agent "${targetAgent}":\n`);

  // 1. Agent exists
  let agentContext: ReturnType<typeof resolveAgent> | null = null;
  try {
    agentContext = resolveAgent(targetAgent);
    check("Agent exists", true, agentContext.agentDir);
  } catch {
    check("Agent exists", false, "Agent not found");
    process.exit(1);
  }

  // 2. IDENTITY.md parseable
  let manifest: Awaited<ReturnType<typeof buildSystemPrompt>>["manifest"] | null = null;
  try {
    const result = await buildSystemPrompt(agentContext, config);
    manifest = result.manifest;
    check("IDENTITY.md parseable", true);
  } catch (err) {
    check("IDENTITY.md parseable", false, err instanceof Error ? err.message : String(err));
  }

  // 3. Credentials present
  const agentEnvKeys = loadAgentEnv(agentContext.agentDir);
  const credsCfg = manifest?.frontmatter.credentials;
  if (credsCfg?.grants) {
    for (const [grantName, grant] of Object.entries(credsCfg.grants)) {
      const grantKeys = (grant as any).keys as string[];
      const missing = grantKeys.filter((k) => !(k in agentEnvKeys));
      check(
        `Credentials: ${grantName}`,
        missing.length === 0,
        missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
      );
    }
  } else {
    check("Credentials config", true, "legacy mode (no grants)");
  }

  // 4. Sandbox config
  const sandbox = manifest?.frontmatter.sandbox;
  if (sandbox?.enforce) {
    check("Sandbox enforced", true);
    if (sandbox.allowedDomains && sandbox.allowedDomains.length > 0) {
      check("Egress allowlist", true, `${sandbox.allowedDomains.length} domains`);
    }
  } else {
    check("Sandbox", true, "not enforced (agent controls its own tools)");
  }

  // 5. API key
  check("ANTHROPIC_API_KEY", !!process.env.ANTHROPIC_API_KEY);

  console.log(allOk ? "\nAll checks passed." : "\nSome checks failed.");
  process.exit(allOk ? 0 : 1);
}

// --- Flag: --serve (server mode) ---

if (getFlag("serve")) {
  const port = parseInt(getFlagValue("port") ?? "3200", 10);
  const host = getFlagValue("host") ?? "127.0.0.1";

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
    // --- TUI mode ---

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
        // No argument — resume most recent session
        // Use /sessions + /resume #N inside the TUI for browsing
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
} // close the else block for --serve
