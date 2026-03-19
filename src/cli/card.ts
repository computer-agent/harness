import { AgentNotFoundError, DEFAULT_AGENT, resolveAgent } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";

export async function cliCard(config: HarnessConfig, agentName: string | null, port: number): Promise<void> {
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

  const { buildAgentCard } = await import("../a2a/agent-card.js");
  const { loadIdentity } = await import("../prompt.js");
  const identity = await loadIdentity(agentContext.identityPath);
  const card = buildAgentCard(agentContext.name, identity, { port });
  console.log(JSON.stringify(card, null, 2));
  process.exit(0);
}
