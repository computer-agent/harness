import { listAgents } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";

export async function cliListAgents(config: HarnessConfig): Promise<void> {
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

      const tools = agent.frontmatter.tools;
      if (tools?.allow) {
        console.log(`    tools: ${tools.allow.join(", ")}`);
      } else if (tools?.deny) {
        console.log(`    tools: all except ${tools.deny.join(", ")}`);
      }

      if (agent.frontmatter.access !== "public") {
        const accessStr =
          agent.frontmatter.access === "users"
            ? `users: ${agent.frontmatter.users.join(", ")}`
            : agent.frontmatter.access;
        console.log(`    access: ${accessStr}`);
      }

      if (agent.frontmatter.tags.length > 0) {
        console.log(`    tags: ${agent.frontmatter.tags.join(", ")}`);
      }

      console.log("");
    }
  }
  process.exit(0);
}
