import express from "express";
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import type { AgentCard } from "@a2a-js/sdk";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { loadIdentity } from "../prompt.js";
import { buildAgentCard } from "./agent-card.js";
import { HarnessExecutor } from "./executor.js";

export async function startA2AServer(
  agentContext: AgentContext,
  config: HarnessConfig,
  port: number,
): Promise<void> {
  const identity = await loadIdentity(agentContext.identityPath);
  const agentCard: AgentCard = buildAgentCard(agentContext.name, identity, { port });

  const taskStore = new InMemoryTaskStore();
  const executor = new HarnessExecutor(agentContext, config);
  const eventBusManager = new DefaultExecutionEventBusManager();

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
    eventBusManager,
  );

  const app = express();
  app.use(express.json());

  // Agent Card endpoint
  app.get(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler }),
  );

  // JSON-RPC endpoint for A2A protocol
  app.post(
    "/",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  app.listen(port, () => {
    console.log(`A2A server for agent "${agentContext.name}" running on port ${port}`);
    console.log(`  Agent Card: http://localhost:${port}/.well-known/agent-card.json`);
    console.log(`  JSON-RPC:   http://localhost:${port}/`);
  });
}
