import { buildSystemPrompt } from "../agent.js";
import { AgentNotFoundError, DEFAULT_AGENT, resolveAgent } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { loadAgentEnv } from "../env.js";
// Review fix #3: Import CredentialGrant directly from manifest.ts (single source of truth)
import type { CredentialGrant } from "../manifest.js";

export async function cliCredentialsMigrate(targetAgent: string | undefined, config: HarnessConfig): Promise<void> {
  const name = targetAgent ?? config.defaultAgent ?? DEFAULT_AGENT;
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
  const keys = Object.keys(agentEnvKeys).filter((k) => k !== "DOTENV_PRIVATE_KEY");

  if (keys.length === 0) {
    console.log(`No .env keys found for agent "${name}".`);
    process.exit(0);
  }

  console.log(`# Credential migration for agent "${name}"`);
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

export async function cliCredentialsCheck(targetAgent: string | undefined, config: HarnessConfig): Promise<void> {
  const name = targetAgent ?? config.defaultAgent ?? DEFAULT_AGENT;
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
  const { manifest } = await buildSystemPrompt(agentContext, config);
  const credsCfg = manifest.frontmatter.credentials;

  console.log(`Agent: ${name}`);
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
      // W8.1-T03: grant is typed as CredentialGrant — no `as any` needed
      const typedGrant: CredentialGrant = grant;
      const present = typedGrant.keys.filter((k) => k in agentEnvKeys);
      const missing = typedGrant.keys.filter((k) => !(k in agentEnvKeys));
      console.log(`\n  Grant: ${grantName}`);
      console.log(`    Tools: ${typedGrant.tools.join(", ")}`);
      if (typedGrant.approval) console.log(`    Approval: ${typedGrant.approval}`);
      if (present.length > 0) console.log(`    Present: ${present.join(", ")}`);
      if (missing.length > 0) console.log(`    MISSING: ${missing.join(", ")}`);
    }
  }
  process.exit(0);
}
