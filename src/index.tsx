/**
 * W8-T08: CLI dispatcher — arg parsing and routing only.
 * W8.1-T01: if/else if chain prevents fall-through if a CLI module returns without exiting.
 * W8.1-T09: Unknown subcommands print usage error instead of silently launching TUI.
 * Subcommand implementations live in src/cli/*.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { formatError } from "./errors.js";
import { isFirstRun, runFirstRun } from "./first-run.js";

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

// --- Pre-config subcommands (no config or auth needed) ---

if (args[0] === "create") {
  if (isFirstRun()) runFirstRun();
  const { cliCreate } = await import("./cli/create.js");
  await cliCreate(args[1]);
  process.exit(0); // safety net — cliCreate already exits
} else if (getFlag("init")) {
  runFirstRun();
  process.exit(0);
}

// --- First run check + config ---

if (isFirstRun()) runFirstRun();
const config = loadConfig();

// --- Pre-auth subcommand ---

if (getFlag("list-agents")) {
  const { cliListAgents } = await import("./cli/list-agents.js");
  await cliListAgents(config);
  process.exit(0); // safety net — cliListAgents already exits
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
        console.error("Note: OAuth token expired — the SDK will attempt to refresh it.");
        console.error("  If this fails, run: claude login");
        console.error("");
      }
    }
  } catch {
    console.error("Warning: Could not parse ~/.claude/.credentials.json");
    console.error("  If authentication fails, run: claude login");
    console.error("");
  }
}

// --- Subcommand dispatch (auth required) ---
// W8.1-T01: if/else if chain — no fall-through possible.

if (getFlag("card")) {
  const { cliCard } = await import("./cli/card.js");
  await cliCard(config, getFlagValue("agent"), Number(getFlagValue("port")) || 4000);
  process.exit(0);
} else if (args[0] === "run") {
  const { cliRun } = await import("./cli/run.js");
  await cliRun(args[1], args.slice(2).join(" "), config);
  process.exit(0);
} else if (args[0] === "credentials") {
  if (args[1] === "migrate") {
    const { cliCredentialsMigrate } = await import("./cli/credentials.js");
    await cliCredentialsMigrate(args[2], config);
  } else if (args[1] === "check") {
    const { cliCredentialsCheck } = await import("./cli/credentials.js");
    await cliCredentialsCheck(getFlagValue("agent") ?? args[2], config);
  } else {
    console.error("Usage: mastersof-ai credentials <migrate|check>");
    process.exit(1);
  }
  process.exit(0);
} else if (args[0] === "access") {
  if (args[1] === "create") {
    const { cliAccessCreate } = await import("./cli/access.js");
    // W8.1-T10: Pass whether --agents was explicitly provided
    const explicitAgents = getFlagValue("agents");
    await cliAccessCreate(getFlagValue("name") ?? args[2], explicitAgents ?? "*", !explicitAgents);
  } else if (args[1] === "rotate") {
    const { cliAccessRotate } = await import("./cli/access.js");
    await cliAccessRotate(getFlagValue("name") ?? args[2]);
  } else {
    // W8.1-T09: Missing subcommand prints usage instead of launching TUI
    console.error("Usage: mastersof-ai access <create|rotate>");
    process.exit(1);
  }
  process.exit(0);
} else if (args[0] === "status") {
  const { cliStatus } = await import("./cli/status.js");
  await cliStatus(args[1], config);
  process.exit(0);
} else if (args[0] === "preflight") {
  const { cliPreflight } = await import("./cli/preflight.js");
  await cliPreflight(getFlagValue("agent") ?? args[1], config);
  process.exit(0);
} else if (getFlag("serve")) {
  const { cliServe } = await import("./cli/serve.js");
  await cliServe(config, parseInt(getFlagValue("port") ?? "3200", 10), getFlagValue("host") ?? "127.0.0.1");
} else if (args[0] && !args[0].startsWith("--")) {
  // W8.1-T09: Unknown positional subcommand — print usage instead of launching TUI
  console.error(`Unknown command: ${args[0]}`);
  console.error("");
  console.error("Available commands:");
  console.error("  create <name>                    Create a new agent");
  console.error('  run <agent> "message"             Run agent headlessly');
  console.error("  credentials <migrate|check>      Manage agent credentials");
  console.error("  access <create|rotate>           Manage access tokens");
  console.error("  status <agent>                   Show recent run results");
  console.error("  preflight --agent <name>         Validate agent config");
  console.error("");
  console.error("Flags: --serve, --card, --list-agents, --init, --agent, --message");
  process.exit(1);
} else {
  // Default: TUI / --message mode
  const { cliTui } = await import("./cli/tui.js");
  await cliTui(config, args, getFlagValue("agent"));
}
