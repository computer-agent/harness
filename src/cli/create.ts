import { AgentExistsError, createAgent } from "../create-agent.js";

export function cliCreate(name: string | undefined): void {
  if (!name) {
    console.error("Usage: mastersof-ai create <name>");
    process.exit(1);
  }
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
