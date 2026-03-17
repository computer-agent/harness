import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { createDeepThinker } from "./deep-thinker.js";
import { createResearcher } from "./researcher.js";
import { createWriter } from "./writer.js";

export function createAgentRegistry(agentName: string): Record<string, AgentDefinition> {
  return {
    researcher: createResearcher(agentName),
    "deep-thinker": createDeepThinker(agentName),
    writer: createWriter(agentName),
  };
}
