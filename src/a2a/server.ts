import type { AgentCard } from "@a2a-js/sdk";
import { DefaultExecutionEventBusManager, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { type AccessConfig, loadAccessConfig, lookupUser } from "../access.js";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { loadIdentity } from "../prompt.js";
import { buildAgentCard } from "./agent-card.js";
import { HarnessExecutor } from "./executor.js";

/**
 * Bearer token auth middleware for the A2A JSON-RPC endpoint.
 * Rejects unauthenticated requests with 401.
 */
function bearerAuth(access: AccessConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = authHeader.slice(7);
    const user = lookupUser(token, access);
    if (!user) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    next();
  };
}

export async function startA2AServer(agentContext: AgentContext, config: HarnessConfig, port: number): Promise<void> {
  const identity = await loadIdentity(agentContext.identityPath);
  const agentCard: AgentCard = buildAgentCard(agentContext.name, identity, { port });

  const taskStore = new InMemoryTaskStore();
  const executor = new HarnessExecutor(agentContext, config);
  const eventBusManager = new DefaultExecutionEventBusManager();

  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor, eventBusManager);

  const access = loadAccessConfig();

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Agent Card endpoint — public (needed for agent discovery)
  app.get("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));

  // W4-T05: JSON-RPC endpoint requires bearer token authentication
  app.post(
    "/",
    bearerAuth(access),
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication, // Auth handled by middleware above
    }),
  );

  // Bind to localhost only — use a reverse proxy for external access
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`A2A server for agent "${agentContext.name}" running on port ${port}`);
    console.log(`  Agent Card: http://localhost:${port}/.well-known/agent-card.json`);
    console.log(`  JSON-RPC:   http://localhost:${port}/`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Try a different port with --port.`);
    } else {
      console.error(`A2A server error: ${err.message}`);
    }
    process.exit(1);
  });
}
