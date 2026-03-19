import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateName } from "../path-safety.js";

export async function cliAccessCreate(
  name: string | undefined,
  agentsList: string,
  isWildcardDefault?: boolean,
): Promise<void> {
  if (!name) {
    console.error("Usage: mastersof-ai access create --name <name> [--agents <a,b,...>]");
    process.exit(1);
  }

  // W8.1-T12: Validate name at creation time, not first connection
  try {
    validateName(name, "user name");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { generateAccessToken } = await import("../access.js");
  const { getHomeDir } = await import("../config.js");
  const { stringify } = await import("yaml");

  const { token, tokenHash } = generateAccessToken();
  const agents = agentsList === "*" ? "*" : agentsList.split(",").map((s) => s.trim());

  // W8.1-T10: Warn when defaulting to wildcard access
  if (agents === "*" && isWildcardDefault) {
    console.warn("WARNING: No --agents flag provided — defaulting to wildcard (*) access.");
    console.warn("  This grants access to ALL agents. Use --agents <a,b,...> to restrict.\n");
  }

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
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
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

export async function cliAccessRotate(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("Usage: mastersof-ai access rotate --name <name>");
    process.exit(1);
  }

  // Review fix #4: Validate name consistently with cliAccessCreate
  try {
    validateName(name, "user name");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { generateAccessToken } = await import("../access.js");
  const { getHomeDir } = await import("../config.js");
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
