// W8.1-T13: Removed dead `buildOptions` import
import { buildSystemPrompt } from "../agent.js";
import { DEFAULT_AGENT, resolveAgent } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { loadAgentEnv } from "../env.js";
// Review fix #3: Import CredentialGrant directly from manifest.ts (single source of truth)
import type { CredentialGrant } from "../manifest.js";

export async function cliPreflight(targetAgent: string | undefined, config: HarnessConfig): Promise<void> {
  const name = targetAgent ?? config.defaultAgent ?? DEFAULT_AGENT;
  let allOk = true;

  const check = (label: string, ok: boolean, detail?: string) => {
    const mark = ok ? "OK" : "FAIL";
    console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) allOk = false;
  };

  console.log(`Preflight check for agent "${name}":\n`);

  // 1. Agent exists
  let agentContext: ReturnType<typeof resolveAgent> | null = null;
  try {
    agentContext = resolveAgent(name);
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
      // W8.1-T03: grant is typed as CredentialGrant — no `as any` needed
      const typedGrant: CredentialGrant = grant;
      const missing = typedGrant.keys.filter((k) => !(k in agentEnvKeys));
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
